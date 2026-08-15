"""
ForgeBridge — the Fusion 360 end of Forge.

Forge drops a job file in a folder. This picks it up and builds it in the
running Fusion, in the active document, as real parametric geometry with a
timeline you can scrub, edit, and hand to Fusion's own assistant. Then it writes
a result back so the other side knows whether it worked.

The whole design is dictated by one line in Autodesk's threading docs:

    "you should not call any Fusion API functions within the worker thread.
     Even calling the messageBox method can sometimes result in Fusion crashing."

So the polling thread never touches Fusion. It watches the folder, and when a
job appears it calls `fireCustomEvent`, which queues the work and runs it on the
main thread when Fusion is next idle. Every Fusion call in this file happens
inside `notify()`, and nowhere else. Getting this wrong does not produce an
error — it produces an intermittent crash of the user's CAD application, which
is a far worse way to find out.

Two other rules that come from the same docs and are easy to miss:

- A command may be mid-flight when the event lands. Anything that adds to the
  undo stack has to terminate it first, hence the SelectCommand dance.
- Handlers must be kept in a module-level list or Python garbage-collects them
  and the event silently stops firing.

Job format (JSON):

    {"id": "...", "kind": "script", "path": "C:/.../part.py", "name": "bracket"}
    {"id": "...", "kind": "import", "path": "C:/.../part.step"}
    {"id": "...", "kind": "ping"}

`script` is the interesting one: the file is Fusion API Python, executed against
the live application, so what lands in the document is a native feature tree
rather than dead imported geometry.
"""

import adsk.core
import adsk.fusion
import traceback
import threading
import json
import os
import time

app = None
ui = None

# Handlers must outlive run(); a local reference gets collected and the event
# quietly stops arriving.
handlers = []
stop_flag = None
watcher = None
custom_event = None

EVENT_ID = "ForgeBridgeJobEvent"

# Written by `claudbot forge fusion install`, next to this file, so the add-in
# and Forge agree on where jobs go without either hardcoding a user's paths.
CONFIG_NAME = "forge-bridge.json"

POLL_SECONDS = 0.4


def _here():
    return os.path.dirname(os.path.realpath(__file__))


def _load_config():
    """Where the job folder is. Falls back next to the add-in if uninstalled by hand."""
    cfg_path = os.path.join(_here(), CONFIG_NAME)
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        jobs = cfg.get("jobs")
        if jobs:
            return jobs
    except Exception:
        pass
    return os.path.join(_here(), "jobs")


# ─── the main thread: everything that touches Fusion ─────────────────────────


class JobEventHandler(adsk.core.CustomEventHandler):
    """Runs on Fusion's main thread. The only place Fusion's API is called."""

    def __init__(self):
        super().__init__()

    def notify(self, args):
        job_path = None
        try:
            job_path = args.additionalInfo

            # A command may be part-way through. Anything that touches the
            # document adds to the undo stack, and doing that under a live
            # command is what corrupts a session.
            if ui.activeCommand != "SelectCommand":
                ui.commandDefinitions.itemById("SelectCommand").execute()

            with open(job_path, "r", encoding="utf-8") as f:
                job = json.load(f)

            kind = job.get("kind", "script")
            if kind == "ping":
                result = {"ok": True, "detail": "bridge is alive", "version": app.version}
            elif kind == "script":
                result = _run_script(job)
            elif kind == "import":
                result = _import_file(job)
            else:
                result = {"ok": False, "detail": 'unknown job kind "{}"'.format(kind)}

            _write_result(job, result)

        except Exception:
            # Never let an exception escape a notify handler — it takes the
            # add-in down with it and the bridge goes dead with no explanation.
            detail = traceback.format_exc()
            try:
                _write_result_raw(job_path, {"ok": False, "detail": detail})
            except Exception:
                pass


def _run_script(job):
    """
    Execute a Fusion API Python file against the live application.

    Run in a namespace of its own with `__name__` set to something other than
    "__main__", so a script that ends in the usual `if __name__ == "__main__"`
    guard does not fire twice. `adsk` and `app` are pre-bound because every
    generated script needs them and making each one rediscover the application
    is boilerplate that models get wrong.
    """
    path = job.get("path")
    if not path or not os.path.exists(path):
        return {"ok": False, "detail": "script not found: {}".format(path)}

    design = adsk.fusion.Design.cast(app.activeProduct)
    if design is None:
        # A CAM or drawing tab is active, or no document is open at all.
        app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        design = adsk.fusion.Design.cast(app.activeProduct)
    if design is None:
        return {"ok": False, "detail": "no design document is active in Fusion"}

    # Parametric, not direct: the timeline is the entire reason for building in
    # Fusion rather than shipping a mesh, so it is set rather than assumed.
    design.designType = adsk.fusion.DesignTypes.ParametricDesignType

    with open(path, "r", encoding="utf-8") as f:
        source = f.read()

    namespace = {
        "__name__": "forge_job",
        "__file__": path,
        "adsk": adsk,
        "app": app,
        "ui": ui,
        "design": design,
        "root": design.rootComponent,
    }

    before = design.rootComponent.bRepBodies.count
    exec(compile(source, path, "exec"), namespace)
    after = design.rootComponent.bRepBodies.count

    # Bring the result into view. Without this a part can build correctly and
    # leave the user staring at the previous camera position wondering.
    try:
        app.activeViewport.fit()
    except Exception:
        pass

    return {
        "ok": True,
        "detail": "built {} in the timeline".format(job.get("name") or "part"),
        "bodies": after,
        "bodiesAdded": after - before,
        "timeline": design.timeline.count if design.timeline else 0,
        "document": app.activeDocument.name,
    }


def _import_file(job):
    """Import STEP/IGES/SAT. The fallback path — geometry, but no feature tree."""
    path = job.get("path")
    if not path or not os.path.exists(path):
        return {"ok": False, "detail": "file not found: {}".format(path)}

    design = adsk.fusion.Design.cast(app.activeProduct)
    if design is None:
        app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        design = adsk.fusion.Design.cast(app.activeProduct)

    mgr = app.importManager
    ext = os.path.splitext(path)[1].lower()
    if ext in (".step", ".stp"):
        options = mgr.createSTEPImportOptions(path)
    elif ext in (".iges", ".igs"):
        options = mgr.createIGESImportOptions(path)
    elif ext == ".sat":
        options = mgr.createSATImportOptions(path)
    else:
        return {"ok": False, "detail": "cannot import {} files".format(ext)}

    mgr.importToTarget(options, design.rootComponent)
    try:
        app.activeViewport.fit()
    except Exception:
        pass

    return {"ok": True, "detail": "imported {}".format(os.path.basename(path))}


def _write_result(job, result):
    _write_result_raw(job.get("_path"), result, job.get("id"))


def _write_result_raw(job_path, result, job_id=None):
    """
    Result lands beside the job, as <id>.result.json.

    Written to a temp name and renamed, because the other side polls for it and
    must never read a half-written file.
    """
    if not job_path:
        return
    folder = os.path.dirname(job_path)
    name = job_id or os.path.splitext(os.path.basename(job_path))[0]
    out = os.path.join(folder, "{}.result.json".format(name))
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f)
    os.replace(tmp, out)


# ─── the worker thread: no Fusion calls, ever ────────────────────────────────


class JobWatcher(threading.Thread):
    def __init__(self, stopped, folder):
        threading.Thread.__init__(self, daemon=True)
        self.stopped = stopped
        self.folder = folder

    def run(self):
        while not self.stopped.wait(POLL_SECONDS):
            try:
                self._sweep()
            except Exception:
                # A bad sweep must not kill the watcher; the next one may be
                # fine, and a dead watcher looks exactly like Fusion ignoring
                # you.
                pass

    def _sweep(self):
        if not os.path.isdir(self.folder):
            return
        for entry in sorted(os.listdir(self.folder)):
            if not entry.endswith(".job.json"):
                continue
            path = os.path.join(self.folder, entry)

            # Claim it by renaming before firing. A job that is picked up twice
            # would build the part twice, and the timeline makes that obvious
            # and annoying.
            claimed = path + ".taken"
            try:
                os.replace(path, claimed)
            except OSError:
                continue

            # Record where the job came from so the main thread can put the
            # result next to it, then hand over the path only — additionalInfo
            # is a string, and a large payload does not belong in it.
            try:
                with open(claimed, "r", encoding="utf-8") as f:
                    job = json.load(f)
                job["_path"] = claimed
                with open(claimed, "w", encoding="utf-8") as f:
                    json.dump(job, f)
            except Exception:
                continue

            app.fireCustomEvent(EVENT_ID, claimed)


# ─── lifecycle ───────────────────────────────────────────────────────────────


def run(context):
    global app, ui, custom_event, stop_flag, watcher
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface

        folder = _load_config()
        os.makedirs(folder, exist_ok=True)

        custom_event = app.registerCustomEvent(EVENT_ID)
        handler = JobEventHandler()
        custom_event.add(handler)
        handlers.append(handler)

        stop_flag = threading.Event()
        watcher = JobWatcher(stop_flag, folder)
        watcher.start()

        # A file rather than a message box: this runs on every Fusion start, and
        # a dialog you have to dismiss each launch is how an add-in gets
        # uninstalled.
        with open(os.path.join(folder, ".bridge-alive"), "w", encoding="utf-8") as f:
            json.dump({"started": time.time(), "version": app.version}, f)

    except Exception:
        if ui:
            ui.messageBox("ForgeBridge failed to start:\n{}".format(traceback.format_exc()))


def stop(context):
    global stop_flag
    try:
        if stop_flag:
            stop_flag.set()
        if custom_event and handlers:
            custom_event.remove(handlers[0])
        if app:
            app.unregisterCustomEvent(EVENT_ID)
        handlers.clear()
    except Exception:
        if ui:
            ui.messageBox("ForgeBridge failed to stop:\n{}".format(traceback.format_exc()))
