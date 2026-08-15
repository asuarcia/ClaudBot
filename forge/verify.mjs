/**
 * forge/verify.mjs — does the whole chain actually work on this machine?
 *
 * The unit tests under test/ deliberately touch nothing external, so they pass
 * on a machine with no OpenSCAD, no slicer and no cad-khana. This is the other
 * half: it drives the real binaries end to end and proves the plumbing, which
 * is the only way to catch a toolchain that moved, an upgrade that renamed a
 * profile, or a vendor JSON that changed shape.
 *
 * Run: node forge/verify.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { find, status, INSTALL } from "./toolchain.mjs";
import { checkPrintable, formatReport } from "./src/printable.mjs";
import { slice, ender3ProProfiles } from "./src/slice.mjs";

const work = mkdtempSync(path.join(tmpdir(), "forge-verify-"));
let failures = 0;

const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const skip = (msg) => console.log(`  skip  ${msg}`);

console.log(`\nForge toolchain check   (scratch: ${work})\n`);

// --- 1. Are the tools present? ----------------------------------------------
console.log("toolchain");
for (const s of status()) {
  if (s.path) ok(`${s.tool.padEnd(9)} ${s.path}`);
  else bad(`${s.tool.padEnd(9)} not found — ${INSTALL[s.tool]}`);
}

// --- 2. OpenSCAD: .scad -> STL ----------------------------------------------
console.log("\nopenscad backend");
let scadStl = null;
if (!find("openscad")) {
  skip("no OpenSCAD, skipping mesh backend");
} else {
  const scad = path.join(work, "cube.scad");
  writeFileSync(scad, [
    "// 20mm cube with a 6mm bore — small, fast, and unambiguous.",
    "difference() {",
    "  cube([20, 20, 20], center = true);",
    "  cylinder(h = 30, r = 3, center = true, $fn = 64);",
    "}",
  ].join("\n"));

  scadStl = path.join(work, "cube.stl");
  const r = spawnSync(find("openscad"), ["--backend=Manifold", "-o", scadStl, scad],
    { encoding: "utf8", windowsHide: true });

  if (!existsSync(scadStl)) {
    bad(`export produced nothing:\n${(r.stderr ?? "").trim()}`);
    scadStl = null;
  } else {
    ok(`exported STL (${(readFileSync(scadStl).length / 1024).toFixed(0)}KB)`);
    // OpenSCAD's Manifold backend reports on the solid it built. Free second
    // opinion on the check the gates do independently.
    const summary = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (/manifold/i.test(summary)) ok("openscad reports the result is manifold");
  }
}

// --- 3. The gates -----------------------------------------------------------
console.log("\nprintability gates");
if (!scadStl) {
  skip("no STL to check");
} else {
  const report = checkPrintable(scadStl);
  for (const line of formatReport(report).split("\n").slice(1)) console.log(` ${line}`);
  report.printable ? ok("a 20mm cube is judged printable") : bad("a 20mm cube was rejected");
}

// --- 4. OrcaSlicer: STL -> G-code -------------------------------------------
console.log("\nslicer");
if (!scadStl) {
  skip("no STL to slice");
} else if (!find("orca")) {
  skip("no OrcaSlicer, skipping");
} else {
  try {
    const profiles = ender3ProProfiles();
    ok(`profiles resolved (process "${profiles.process.name}", ${Object.keys(profiles.process).length} keys)`);

    const { gcode, estimate } = slice(scadStl, path.join(work, "gcode"), { name: "cube" });
    ok(`sliced to ${path.basename(gcode)}`);

    // Every field must be a real number. A null here means OrcaSlicer changed
    // its summary format and the estimate parser needs updating — which matters,
    // because the printability gate judges prints on these.
    for (const [k, v] of Object.entries(estimate)) {
      v === null || v === 0 ? bad(`estimate.${k} is ${v}`) : ok(`estimate.${k} = ${v}`);
    }
  } catch (err) {
    bad(err.message.split("\n")[0]);
  }
}

// --- 5. build123d via cad-khana: -> STEP ------------------------------------
console.log("\nb-rep backend");
if (!find("khana")) {
  skip("no cad-khana, skipping");
} else {
  const example = path.join(import.meta.dirname, "examples", "bracket.py");
  const out = path.join(work, "b3d");
  const r = spawnSync(find("khana"), ["export", example, "--out", out],
    { encoding: "utf8", windowsHide: true });

  const step = path.join(out, "assembly.step");
  const stl = path.join(out, "assembly.stl");

  if (!existsSync(step)) {
    bad(`no STEP produced:\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-2).join("\n")}`);
  } else {
    const text = readFileSync(step, "utf8");
    /ISO-10303-21/.test(text)
      ? ok("STEP exported (ISO-10303-21)")
      : bad("STEP file is not ISO-10303-21");

    // The bracket has four filleted uprights and one bore. If the STEP came
    // back with no curved surfaces, the fillet silently didn't happen — which
    // is the entire reason this backend exists.
    const cyl = (text.match(/CYLINDRICAL_SURFACE/g) ?? []).length;
    cyl >= 5
      ? ok(`${cyl} cylindrical surfaces — fillets and bore survived as B-rep`)
      : bad(`only ${cyl} cylindrical surfaces; expected 5 (4 fillets + bore)`);
  }

  // The mesh from this backend must satisfy the same gates as the OpenSCAD one.
  // Both feed the same printer.
  if (existsSync(stl)) {
    const report = checkPrintable(stl);
    report.printable
      ? ok("build123d mesh passes the same gates")
      : bad(`build123d mesh rejected: ${report.blockers.map((b) => b.name).join(", ")}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);
