/**
 * forge/src/freecad.mjs — driving FreeCAD.
 *
 * FreeCAD presents two integration surfaces, and Forge needs both:
 *
 * 1. **Headless, via FreeCADCmd.** Runs a script in a cold process with no GUI
 *    and no addon involved. This is the workhorse — batch conversions, exports,
 *    regression tests — and it works on a machine where FreeCAD has never been
 *    opened. Fusion had no equivalent, which is most of why this backend is
 *    better suited to the job than that one was.
 *
 * 2. **The live GUI, via the ForgeBridge addon.** Forge drops a job file in a
 *    watched folder; the addon picks it up and executes it against the document
 *    the user is actually sitting in front of, with their unsaved work and
 *    their undo stack intact. This is the path that matters when the answer is
 *    "not quite, move that".
 *
 * The folder protocol needs no ports and no auth, survives FreeCAD restarting,
 * and a job written while FreeCAD is closed simply runs when it next opens.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  rmSync, cpSync, statSync, renameSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { find, INSTALL } from "../toolchain.mjs";

const WIN = process.platform === "win32";

/** The FreeCAD GUI binary, or null. toolchain.mjs owns the search. */
export function gui() {
  return find("freecad");
}

/**
 * The headless binary, or null.
 *
 * Named with a trailing underscore because `console` is a Node global, and a
 * module-level binding that shadows it would break every `console.log` in this
 * file in a way that reads as a mystery rather than a mistake.
 *
 * It sits *next to* FreeCAD.exe at the top of the install folder, not in bin/.
 */
export function console_() {
  const g = gui();
  if (!g) return null;
  const exe = path.join(path.dirname(g), WIN ? "FreeCADCmd.exe" : "FreeCADCmd");
  return existsSync(exe) ? exe : null;
}

export function installed() {
  return Boolean(gui() || console_());
}

let cachedUserAppData = null;

/**
 * FreeCAD's per-user data directory — e.g. `…\AppData\Roaming\FreeCAD\v1-1\`.
 *
 * Probed by asking FreeCAD, not assembled from a guess, because that path is
 * **version-stamped**. Hardcoding `v1-1` would work today and point at a folder
 * nothing reads after the next release — the addon would install successfully
 * into a directory FreeCAD ignores, which is exactly the failure mode that cost
 * a day on the Fusion side: green status for something that could never run.
 *
 * Cached, because it costs a process spawn and the pipeline asks repeatedly.
 */
export function userAppData() {
  if (process.env.FORGE_FREECAD_USERDATA) return process.env.FORGE_FREECAD_USERDATA;
  if (cachedUserAppData) return cachedUserAppData;

  const cmd = console_();
  if (cmd) {
    try {
      const r = spawnSync(cmd, ["-c", "import FreeCAD;print(FreeCAD.getUserAppDataDir())"], {
        encoding: "utf8", windowsHide: true, timeout: 30_000,
      });
      // The last path-shaped line, not the first: FreeCAD prints a banner and
      // any module warnings to stdout before the answer.
      const lines = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const absolute = WIN ? /^([a-zA-Z]:[\\/]|\\\\)/ : /^\//;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (absolute.test(lines[i])) {
          cachedUserAppData = lines[i];
          return cachedUserAppData;
        }
      }
    } catch {
      // Fall through to the convention below.
    }
  }

  // Last resort, and not version-stamped — so it is very likely wrong on 1.x.
  // Kept only so that path-building code has something to print rather than
  // throwing; `doctor` shows this value so a bad one is visible.
  cachedUserAppData = WIN
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "FreeCAD")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "FreeCAD")
      : path.join(os.homedir(), ".local", "share", "FreeCAD");
  return cachedUserAppData;
}

export const modDir = () => path.join(userAppData(), "Mod");
export const installedAt = () => path.join(modDir(), "ForgeBridge");

/** Where jobs are exchanged. Desktop-only, like the widgets — see docs/forge.md. */
export function jobsDir() {
  if (process.env.FORGE_FREECAD_JOBS) return process.env.FORGE_FREECAD_JOBS;
  const base = WIN
    ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "Claudbot", "freecad-jobs");
}

/**
 * Is the FreeCAD GUI up?
 *
 * By process name, which is the only signal available without talking to it.
 * The non-Windows match is anchored so a running FreeCADCmd — which is headless
 * and has no bridge — is not reported as a live GUI session.
 */
export function running() {
  try {
    if (WIN) {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq FreeCAD.exe", "/NH"],
        { encoding: "utf8", windowsHide: true });
      return /FreeCAD\.exe/i.test(r.stdout ?? "");
    }
    return spawnSync("pgrep", ["-x", "FreeCAD"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Has the addon reported for duty since FreeCAD last started?
 *
 * The bridge drops `.bridge-alive` on GUI startup. Its presence means it was
 * installed and loaded; its mtime says when. Both matter — an addon copied into
 * place but never loaded looks identical on disk to one that is working.
 */
export function bridgeStatus() {
  const marker = path.join(jobsDir(), ".bridge-alive");
  if (!existsSync(marker)) return { installed: existsSync(installedAt()), everRan: false };
  try {
    return {
      installed: existsSync(installedAt()),
      everRan: true,
      lastStart: statSync(marker).mtime,
      ...JSON.parse(readFileSync(marker, "utf8")),
    };
  } catch {
    return { installed: existsSync(installedAt()), everRan: true };
  }
}

/**
 * Copy the addon into FreeCAD's user Mod folder and point it at the job dir.
 *
 * Copied rather than symlinked: a symlink needs developer mode on Windows. The
 * config file is written at install time so neither side hardcodes the other's
 * paths — the same rule the rest of Claudbot follows.
 */
export function install() {
  if (!installed()) {
    throw new Error(`FreeCAD is not installed. ${INSTALL.freecad}`);
  }

  const src = path.join(import.meta.dirname, "..", "freecad", "ForgeBridge");
  if (!existsSync(src)) throw new Error(`The addon source is missing from ${src}.`);

  const dest = installedAt();
  mkdirSync(modDir(), { recursive: true });
  // Removed first: cpSync over an existing tree leaves stale files behind, and
  // a stale .py next to a new one is the kind of thing that takes an hour.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  const jobs = jobsDir();
  mkdirSync(jobs, { recursive: true });
  writeFileSync(
    path.join(dest, "forge-bridge.json"),
    JSON.stringify({ jobs, installedAt: new Date().toISOString() }, null, 2),
  );

  return { dest, jobs };
}

export function uninstall() {
  rmSync(installedAt(), { recursive: true, force: true });
  return installedAt();
}

/**
 * Send a job and wait for the bridge to answer.
 *
 * Polls for a result file rather than holding anything open. `timeoutMs` is
 * generous because the answer is gated on FreeCAD's event loop being free — the
 * addon polls from a QTimer, so a job fired while the user is dragging a sketch
 * waits until they let go. That is correct behaviour, and it means a short
 * timeout would report failure for work that is merely queued.
 */
export async function send(job, { timeoutMs = 120_000 } = {}) {
  const dir = jobsDir();
  mkdirSync(dir, { recursive: true });

  const id = job.id ?? randomUUID();

  // Written to a temp name and renamed: the addon polls this folder, and a
  // partially written job would parse as corrupt and be thrown away.
  const file = path.join(dir, `${id}.job.json`);
  const tmp = `${file}.writing`;
  writeFileSync(tmp, JSON.stringify({ ...job, id }, null, 2), "utf8");
  renameSync(tmp, file);

  const result = path.join(dir, `${id}.result.json`);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (existsSync(result)) {
      const data = JSON.parse(readFileSync(result, "utf8"));
      cleanup(dir, id);
      return data;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  cleanup(dir, id);
  throw new Error(
    running()
      ? "FreeCAD did not answer. The ForgeBridge addon may not be loaded — " +
        "run `claudbot forge freecad doctor`."
      : "FreeCAD is not running, so the job is queued. It will run when you next open FreeCAD.",
  );
}

/** Leave the folder as we found it; a job dir that only grows is a bug report. */
function cleanup(dir, id) {
  for (const f of readdirSync(dir)) {
    if (f.startsWith(id)) rmSync(path.join(dir, f), { force: true });
  }
}

/** Round-trip the bridge. The one call that proves the live-GUI path works. */
export const ping = () => send({ kind: "ping" }, { timeoutMs: 15_000 });

/** Start FreeCAD if it is not already up. */
export function launch() {
  if (running()) return false;
  const exe = gui();
  if (!exe) return false;
  try {
    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run FreeCAD Python with no GUI and no bridge, straight through FreeCADCmd.
 *
 * Pass a script path, or `{ code }` to run a snippet inline via `-c`. The
 * snippet form is what `doctor` uses to prove the headless path works without
 * needing a file on disk.
 *
 * Deliberately does **not** throw on a non-zero exit. A failing script is a
 * normal, informative outcome here — it is what Forge's retry loop feeds back
 * to the model, and what `exec` prints to the user. Throwing would replace the
 * one thing the caller needs, the interpreter's own stderr, with a generic
 * message about the exit code.
 */
export function runHeadless(scriptPath, { timeoutMs = 300_000, code = null } = {}) {
  const cmd = console_();
  if (!cmd) throw new Error("FreeCADCmd is not installed — the headless path is unavailable.");

  const args = code ? ["-c", code] : [scriptPath];
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A Python string literal for `s`, so Windows backslashes survive the trip. */
const py = (s) => JSON.stringify(String(s));

/** Marks the one line of stdout that is ours, among FreeCAD's startup banner. */
const SENTINEL = "__FORGE_RESULT__";

/**
 * Build a script headlessly, with the same semantics as sending it to the GUI.
 *
 * The point of routing through the addon's own `handle()` rather than just
 * executing the file is that there is then exactly **one** definition of what a
 * Forge script may assume. Both paths pre-bind `doc`, `App`, `Part` and
 * `FreeCAD`, both recompute afterwards, both report objects added, and both
 * return the traceback verbatim on failure. Without this, `exec` and `run`
 * would quietly disagree and a script that worked in one would break in the
 * other — which is the sort of thing that gets blamed on the model.
 *
 * The addon is imported from the repo, not from the installed copy, so headless
 * builds work on a machine where `install` has never been run.
 */
export function buildHeadless(scriptPath, { name = null, timeoutMs = 300_000 } = {}) {
  const addon = path.join(import.meta.dirname, "..", "freecad", "ForgeBridge");
  const job = { kind: "script", path: path.resolve(scriptPath), name: name ?? path.basename(scriptPath, ".py") };

  const driver = [
    "import sys, json",
    `sys.path.insert(0, ${py(addon)})`,
    "import forge_bridge",
    'forge_bridge.MODE = "console"',
    `print(${py(SENTINEL)} + json.dumps(forge_bridge.handle(json.loads(${py(JSON.stringify(job))}))))`,
  ].join("\n");

  const r = runHeadless(null, { code: driver, timeoutMs });

  const line = (r.stdout || "").split(/\r?\n/).reverse().find((l) => l.includes(SENTINEL));
  if (!line) {
    // No sentinel means FreeCAD died before our code ran — a missing module, a
    // bad install. Its stderr is the only useful thing we have.
    return { ok: false, detail: (r.stderr || r.stdout || "FreeCADCmd produced no output").trim() };
  }
  try {
    // The script's own output arrives inside the result, captured Python-side
    // — the process stream also carries FreeCAD's banner and its recompute
    // progress bar, which is written from C++ and cannot be told apart from
    // real output by looking at it.
    return JSON.parse(line.slice(line.indexOf(SENTINEL) + SENTINEL.length));
  } catch {
    return { ok: false, detail: `could not parse the bridge result:\n${line}` };
  }
}

/** Everything `claudbot forge freecad doctor` needs to say. */
export function status() {
  return {
    installed: installed(),
    gui: gui(),
    console: console_(),
    userAppData: userAppData(),
    modDir: modDir(),
    addIn: installedAt(),
    addInPresent: existsSync(installedAt()),
    jobs: jobsDir(),
    running: running(),
    bridge: bridgeStatus(),
  };
}
