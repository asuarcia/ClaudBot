/**
 * forge/test/freecad.test.mjs — the FreeCAD bridge, and the traps it fell into.
 *
 * These run on a machine with no FreeCAD installed, so they cover the pure path
 * logic plus two static assertions about the addon source. Those two are the
 * valuable ones: both encode a failure that already happened, and neither
 * produces an error message at the point it goes wrong.
 *
 * Run: node --test forge/test/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { jobsDir, console_, gui, modDir, installedAt } from "../src/freecad.mjs";

const addon = (f) =>
  readFileSync(path.join(import.meta.dirname, "..", "freecad", "ForgeBridge", f), "utf8");

/**
 * The file with its docstrings and comments removed.
 *
 * Needed because these files *explain* the traps they avoid, so a plain
 * substring search finds the warning as readily as the mistake. Asserting on
 * prose would mean the fix is to stop documenting it.
 */
const code = (f) =>
  addon(f)
    .replace(/"""[\s\S]*?"""/g, "")
    .replace(/'''[\s\S]*?'''/g, "")
    .replace(/#.*$/gm, "");

// ─── the addon's two silent killers ──────────────────────────────────────────

test("the exec'd entry points never touch __file__", () => {
  // FreeCAD does not import Init.py/InitGui.py, it exec()s them in a bare
  // namespace where __file__ is undefined. A single os.path.dirname(__file__)
  // raises NameError on the first line and takes the whole addon down, and the
  // only trace is one line in a log file. forge_bridge.py is exempt — it is a
  // real import, so __file__ is defined there and is how it finds its config.
  for (const f of ["Init.py", "InitGui.py"]) {
    assert.ok(!code(f).includes("__file__"), `${f} must not reference __file__`);
  }
});

test("the poll timer is owned by the module, not by InitGui", () => {
  // Same root cause, worse symptom: a QTimer referenced only from InitGui.py's
  // throwaway namespace is garbage-collected the moment the file finishes, so
  // the bridge starts, writes its alive marker, reports no error, and never
  // answers a job. It has to be parked on forge_bridge, which is in sys.modules.
  assert.ok(!code("InitGui.py").includes("QTimer"), "InitGui.py must not build the timer");
  assert.ok(code("forge_bridge.py").includes("QTimer"), "forge_bridge.py should own the timer");
  assert.ok(code("InitGui.py").includes("start_gui()"), "InitGui.py should delegate to start_gui");
});

test("a result is named for the job id, not for the claimed file", () => {
  // The claim renames <id>.job.json to <id>.taken. Deriving the result name
  // from the claimed file yields <id>.taken.result.json, which the client polls
  // for forever because it is waiting on <id>.result.json.
  const src = addon("forge_bridge.py");
  assert.ok(src.includes('name[: -len(".job.json")]'),
    "the id must come from the original job filename");
});

test("the script namespace pre-binds what every generated script needs", () => {
  const src = addon("forge_bridge.py");
  for (const binding of ['"FreeCAD"', '"App"', '"Part"', '"doc"']) {
    assert.ok(src.includes(binding), `the exec namespace should bind ${binding}`);
  }
  // __main__ would make a script ending in the usual main guard run twice.
  assert.ok(src.includes('"__name__": "forge_job"'));
});

// ─── path resolution ─────────────────────────────────────────────────────────

test("the jobs dir honours its override", () => {
  const before = process.env.FORGE_FREECAD_JOBS;
  process.env.FORGE_FREECAD_JOBS = path.join("X:", "elsewhere");
  try {
    assert.equal(jobsDir(), path.join("X:", "elsewhere"));
  } finally {
    if (before === undefined) delete process.env.FORGE_FREECAD_JOBS;
    else process.env.FORGE_FREECAD_JOBS = before;
  }
});

test("the jobs dir is FreeCAD's own, not Fusion's", () => {
  const before = process.env.FORGE_FREECAD_JOBS;
  delete process.env.FORGE_FREECAD_JOBS;
  try {
    assert.match(jobsDir(), /freecad-jobs$/);
  } finally {
    if (before !== undefined) process.env.FORGE_FREECAD_JOBS = before;
  }
});

test("the addon installs under the user Mod folder", () => {
  assert.equal(installedAt(), path.join(modDir(), "ForgeBridge"));
  assert.match(modDir(), /Mod$/);
});

test("FreeCADCmd is looked for beside the GUI binary, not under bin/", () => {
  // The portable unpack puts both at the top level. Looking in bin/ finds the
  // libraries and no executable, which reads as "not installed".
  const g = gui();
  const c = console_();
  if (!g || !c) return; // not installed here; the doctor covers that case
  assert.equal(path.dirname(c), path.dirname(g));
  assert.match(path.basename(c), /^FreeCADCmd(\.exe)?$/);
});
