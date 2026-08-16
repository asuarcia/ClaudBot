"""
ForgeBridge — the FreeCAD end of Forge.

Forge drops a job file in a folder. This picks it up and builds it in the
running FreeCAD, in the active document, as real parametric objects you can
select, edit and recompute. Then it writes a result back so the other side
knows whether it worked.

Why a folder and not a socket: it needs no ports, no auth, survives FreeCAD
restarting, and a job written while FreeCAD is closed simply runs when it next
opens. The same reasoning as the Fusion bridge this is a port of.

Where it differs from that port, and why:

- **No worker thread.** Fusion's API is only callable from its main thread, so
  the Fusion bridge polls on a thread and marshals work back via a custom
  event. FreeCAD is Qt, and a `QTimer` callback already runs on the Qt main
  thread — so InitGui.py drives `sweep()` from a timer and there is no second
  thread anywhere in this file. That removes the entire class of bug the Fusion
  version had to be careful about.
- **Console mode is a real mode.** FreeCADCmd can run a script headlessly with
  no bridge at all, which Fusion could never do. So this module is imported in
  both modes and must never hard-import FreeCADGui at the top level.

Job format (JSON):

    {"id": "...", "kind": "script", "path": "C:/.../part.py", "name": "bracket"}
    {"id": "...", "kind": "import", "path": "C:/.../part.step"}
    {"id": "...", "kind": "ping"}
"""

import contextlib
import io
import json
import os
import time
import traceback

# FreeCAD itself is safe to import here — it exists in both GUI and console
# mode. FreeCADGui is not, and is imported inside functions behind a try.
import FreeCAD

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))

# Written by `claudbot forge freecad install`, next to this file, so the addon
# and Forge agree on where jobs go without either hardcoding a user's paths.
CONFIG_NAME = "forge-bridge.json"

# Set by whichever entry point loaded us. Reported back on ping, because "the
# bridge answered" means something different in a headless process than in the
# GUI the user is sitting in front of.
MODE = "unknown"

# Claimed jobs and their results are cleaned up by the client that sent them.
# A job nobody is listening for would otherwise sit here forever, so anything
# this old is swept — long enough that it can never race a live job.
STALE_SECONDS = 3600


def version():
    """
    FreeCAD's version as a string.

    Built from `Version()`, which returns a list of strings, because there is
    no `VersionString()` — the obvious guess, and wrong. It returned an
    AttributeError that `mark_alive` swallowed, so the bridge looked like it
    had never started at all.
    """
    try:
        return ".".join(FreeCAD.Version()[:3])
    except Exception:
        return "unknown"


def config_path():
    return os.path.join(MODULE_DIR, CONFIG_NAME)


def load_jobs_dir():
    """Where the job folder is. Falls back next to the addon if installed by hand."""
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            jobs = json.load(f).get("jobs")
        if jobs:
            return jobs
    except Exception:
        pass
    return os.path.join(MODULE_DIR, "jobs")


# ─── the work ────────────────────────────────────────────────────────────────


def _active_doc():
    """
    The active document, creating one if there is none.

    Deliberately does *not* save it. A new document has no FileName, and
    `save()` on one raises ValueError in console mode and opens a file dialog
    in the GUI — either way the first job every user sent would have failed.
    """
    doc = FreeCAD.ActiveDocument
    if doc is None:
        doc = FreeCAD.newDocument("Forge")
    return doc


def _fit_view():
    """
    Point the camera at what was just built.

    GUI-only, and best-effort: a part that built correctly must not be reported
    as failed because the viewport was busy. FreeCADGui is imported here rather
    than at module top level because this file is also loaded by FreeCADCmd,
    where it does not exist.
    """
    try:
        import FreeCADGui

        FreeCADGui.activeDocument().activeView().viewAxonometric()
        FreeCADGui.SendMsgToActiveView("ViewFit")
    except Exception:
        pass


def _run_script(job):
    """
    Execute a FreeCAD Python file against the live application.

    Run in a namespace of its own with `__name__` set to something other than
    "__main__", so a script that ends in the usual main guard does not fire
    twice. `FreeCAD`, `App`, `Part` and `doc` are pre-bound because every
    generated script needs them and making each one rediscover the application
    is boilerplate that models get wrong.
    """
    import Part

    path = job.get("path")
    if not path or not os.path.isfile(path):
        return {"ok": False, "detail": "script not found: {}".format(path)}

    doc = _active_doc()
    before = len(doc.Objects)

    with open(path, "r", encoding="utf-8") as f:
        source = f.read()

    namespace = {
        "__name__": "forge_job",
        "__file__": path,
        "FreeCAD": FreeCAD,
        "App": FreeCAD,
        "Part": Part,
        "doc": doc,
    }

    # The script's own prints are captured rather than left to go wherever
    # stdout happens to point. In the GUI they would land in a console panel
    # the user has to go and open; headless they would be tangled up with
    # FreeCAD's recompute progress, which is written from C++ and cannot be
    # filtered out of the process stream reliably. Capturing at the Python
    # level gets exactly the script's output and nothing else.
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            exec(compile(source, path, "exec"), namespace)
            doc.recompute()
    except Exception:
        # The traceback verbatim, not str(e). This text is what goes back to
        # the model in Forge's retry loop, and "name 'Vector' is not defined"
        # without the line number is not enough to fix anything.
        return {"ok": False, "detail": traceback.format_exc(), "stdout": buffer.getvalue()}

    after = len(doc.Objects)
    _fit_view()
    return {
        "ok": True,
        "detail": "built {} in {}".format(job.get("name") or "part", doc.Name),
        "objects": after,
        "objectsAdded": after - before,
        "document": doc.Name,
        "stdout": buffer.getvalue().strip(),
    }


def _import_file(job):
    """Import STEP/IGES/BREP/STL/OBJ, or open an FCStd. Geometry, no feature tree."""
    path = job.get("path")
    if not path or not os.path.isfile(path):
        return {"ok": False, "detail": "file not found: {}".format(path)}

    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".step", ".stp", ".iges", ".igs"):
            import Import

            doc = _active_doc()
            Import.insert(path, doc.Name)
        elif ext in (".brep", ".brp"):
            import Part

            doc = _active_doc()
            Part.insert(path, doc.Name)
        elif ext in (".stl", ".obj"):
            import Mesh

            doc = _active_doc()
            Mesh.insert(path, doc.Name)
        elif ext == ".fcstd":
            # A native document opens as itself rather than being merged into
            # whatever happened to be active — merging would lose its tree.
            doc = FreeCAD.openDocument(path)
        else:
            return {"ok": False, "detail": "cannot import {} files".format(ext)}
    except Exception:
        return {"ok": False, "detail": traceback.format_exc()}

    _fit_view()
    return {
        "ok": True,
        "detail": "imported {}".format(os.path.basename(path)),
        "objects": len(doc.Objects),
        "document": doc.Name,
    }


def handle(job):
    """Dispatch one job. Always returns a dict; never raises."""
    kind = job.get("kind", "script")
    if kind == "ping":
        return {
            "ok": True,
            "detail": "bridge is alive",
            "version": version(),
            "mode": MODE,
        }
    if kind == "script":
        return _run_script(job)
    if kind == "import":
        return _import_file(job)
    return {"ok": False, "detail": 'unknown job kind "{}"'.format(kind)}


# ─── the folder protocol ─────────────────────────────────────────────────────


def write_result(jobs_dir, job_id, result):
    """
    Result lands beside the job, as <id>.result.json.

    Written to a temp name and renamed, because the other side polls for it and
    must never read a half-written file. `os.replace` is atomic on Windows as
    well as POSIX, which `os.rename` is not.
    """
    out = os.path.join(jobs_dir, "{}.result.json".format(job_id))
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f)
    os.replace(tmp, out)


def _prune(jobs_dir, now):
    """Drop claimed jobs and results nobody ever collected."""
    for name in os.listdir(jobs_dir):
        if not (name.endswith(".taken") or name.endswith(".result.json")):
            continue
        p = os.path.join(jobs_dir, name)
        try:
            if now - os.path.getmtime(p) > STALE_SECONDS:
                os.remove(p)
        except OSError:
            pass


def sweep(jobs_dir):
    """
    Handle every job waiting in the folder. Returns how many were handled.

    Claimed by renaming *before* any work happens: a job picked up twice would
    build the part twice, and on a timer that fires every 400ms that is not a
    theoretical race. The rename is also the lock — if it fails, another sweep
    already has it.
    """
    if not os.path.isdir(jobs_dir):
        return 0

    handled = 0
    for name in sorted(os.listdir(jobs_dir)):
        if not name.endswith(".job.json"):
            continue

        # The id is the filename without ".job.json" — and it must be taken
        # from here, not from the claimed name, or the result is written as
        # <id>.taken.result.json and the client polls forever for a file that
        # will never appear.
        job_id = name[: -len(".job.json")]
        path = os.path.join(jobs_dir, name)
        claimed = os.path.join(jobs_dir, job_id + ".taken")

        try:
            os.replace(path, claimed)
        except OSError:
            continue

        try:
            with open(claimed, "r", encoding="utf-8") as f:
                job = json.load(f)
            job_id = job.get("id") or job_id
            result = handle(job)
        except Exception:
            result = {"ok": False, "detail": traceback.format_exc()}

        try:
            write_result(jobs_dir, job_id, result)
        except Exception:
            # A failed result write must not stop the sweep; the next job may
            # be fine, and a dead sweep looks exactly like FreeCAD ignoring you.
            pass
        handled += 1

    try:
        _prune(jobs_dir, time.time())
    except OSError:
        pass

    return handled


# The GUI poll timer. It lives here, in a module that is genuinely imported and
# therefore genuinely persistent, and NOT in InitGui.py — see start_gui().
_timer = None

# Fast enough to feel immediate, slow enough that an idle FreeCAD is not
# stat()ing a folder hundreds of times a second.
POLL_MS = 400


def _tick():
    """Runs on the Qt main thread — the only safe place to touch a document."""
    try:
        sweep(load_jobs_dir())
    except Exception as exc:
        # An exception escaping a timer callback can kill the timer, and a dead
        # timer is indistinguishable from FreeCAD ignoring you. Report and live.
        FreeCAD.Console.PrintError("ForgeBridge sweep failed: {}\n".format(exc))


def start_gui():
    """
    Start watching the job folder. Called from InitGui.py, GUI mode only.

    **Why the timer is created here and not there**, which took two rounds to
    find: a QTimer nothing refers to is garbage-collected and silently stops
    firing. The usual fix is to hold it in a module-level global — but FreeCAD
    does not *import* InitGui.py, it `exec()`s it in a throwaway namespace, so
    a "global" in that file is really a local that dies the moment the file
    finishes. The bridge then starts, writes its alive marker, reports no error,
    and never answers a single job — which is exactly what it did.

    This module, by contrast, is a real entry in `sys.modules` and outlives
    startup, so a reference parked here is a reference that lasts.
    """
    global _timer
    from PySide import QtCore

    jobs = load_jobs_dir()
    os.makedirs(jobs, exist_ok=True)
    mark_alive(jobs, "gui")

    _timer = QtCore.QTimer()
    _timer.timeout.connect(_tick)
    _timer.start(POLL_MS)
    return jobs


def mark_alive(jobs_dir, mode):
    """
    Announce that the bridge loaded.

    A file rather than a dialog: this runs on every FreeCAD start, and a box
    you have to dismiss each launch is how an addon gets deleted. Its presence
    means the bridge was loaded; its mtime says when.
    """
    global MODE
    MODE = mode
    try:
        os.makedirs(jobs_dir, exist_ok=True)
        payload = {"started": time.time(), "version": version(), "mode": mode}
        out = os.path.join(jobs_dir, ".bridge-alive")
        tmp = out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, out)
    except Exception:
        pass
