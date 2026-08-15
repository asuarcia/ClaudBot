/**
 * forge/src/printable.mjs — the gates between "a model" and "a print".
 *
 * Forge's two jobs are different verbs. Making a model is cheap and reversible;
 * making an object commits an hour of machine time, a metre of filament, and a
 * hot nozzle moving over a bed unattended. Everything that separates the two
 * lives here, and `forge_print` is not allowed to run without a pass.
 *
 * Gates are graded, not boolean. A non-manifold mesh is a hard block — the
 * slicer's output would be meaningless. A steep overhang is a warning, because
 * the answer might legitimately be "yes, and I'll turn supports on". Blocking on
 * warnings would train the user to bypass the gates, which is worse than not
 * having them.
 */

import { parseStl, bounds, manifold, overhangs, volume } from "./stl.mjs";

/**
 * The Ender 3 Pro, from the machine itself rather than the marketing number.
 *
 * 220×220×250 is the advertised volume. The margin exists because the nominal
 * area is not all reachable: the bed clips are physically in the way at the
 * corners, and a skirt or brim needs room outside the part's own footprint.
 */
export const ENDER3_PRO = {
  name: "Ender 3 Pro",
  bed: [220, 220, 250],
  margin: 5,
  nozzle: 0.4,
  // Unsupported PLA starts misbehaving past ~45°, and this machine has no part
  // cooling worth the name beyond stock, so the threshold stays conservative.
  overhangDeg: 45,
};

/** A gate result. `block: true` stops a print; `block: false` is advisory. */
const gate = (name, pass, block, detail) => ({ name, pass, block, detail });

/**
 * Run every printability gate against an STL.
 *
 * Returns { printable, blockers, warnings, gates, measured } — `printable` is
 * true only when no blocking gate failed. `measured` carries the raw numbers so
 * a caller (the MCP tool, the workbench, a retry prompt) can report specifics
 * instead of "it failed".
 */
export function checkPrintable(stlPath, printer = ENDER3_PRO) {
  const mesh = parseStl(stlPath);
  const b = bounds(mesh);
  const m = manifold(mesh);
  const o = overhangs(mesh, { thresholdDeg: printer.overhangDeg });
  const vol = volume(mesh);
  const boxVol = b.size[0] * b.size[1] * b.size[2];

  const gates = [];

  // --- Watertightness -------------------------------------------------------
  gates.push(gate(
    "manifold",
    m.ok,
    true,
    m.ok
      // Zero-area triangles are worth mentioning and not worth blocking on:
      // OpenCascade puts one at the pole of every sphere it tessellates, and
      // slicers drop them. Saying so beats a silent count nobody can interpret.
      ? `closed surface, ${m.triangles} triangles`
        + (m.degenerateTriangles
          ? ` (${m.degenerateTriangles} zero-area, which slicers discard)`
          : "")
      : [
          m.openEdges && `${m.openEdges} open edge(s) — the surface has holes`,
          m.nonManifoldEdges && `${m.nonManifoldEdges} edge(s) shared by more than two faces`,
          m.flippedFaces && `${m.flippedFaces} inverted face(s) — part of the model is inside-out`,
        ].filter(Boolean).join("; "),
  ));

  // --- Does it fit on the bed ----------------------------------------------
  // Compare size, never position: the slicer centres the part on the plate, so
  // a model sitting at x=900 in its own coordinates is fine. Only its extent
  // matters.
  const [bx, by, bz] = printer.bed;
  const usable = [bx - printer.margin * 2, by - printer.margin * 2, bz];
  const [sx, sy, sz] = b.size;
  const fitsSquare = sx <= usable[0] && sy <= usable[1] && sz <= usable[2];

  // A part too wide axis-aligned may still fit turned 45° on the plate. Say so
  // rather than rejecting it outright — rotating is the user's call, and it is
  // one click in the slicer.
  const diagonal = Math.hypot(usable[0], usable[1]);
  const fitsTurned = !fitsSquare && sz <= usable[2]
    && Math.max(sx, sy) <= diagonal && Math.min(sx, sy) <= Math.min(usable[0], usable[1]);

  gates.push(gate(
    "bed-fit",
    fitsSquare,
    !fitsTurned, // only a hard block if turning it can't save it either
    fitsSquare
      ? `${fmt(b.size)} mm fits the ${usable[0]}×${usable[1]}×${usable[2]} usable area`
      : fitsTurned
        ? `${fmt(b.size)} mm doesn't fit square, but would fit rotated on the plate`
        : `${fmt(b.size)} mm exceeds the ${usable[0]}×${usable[1]}×${usable[2]} usable area`,
  ));

  // --- Is it actually a solid object ---------------------------------------
  // A zero-thickness result is the classic LLM CAD failure: a difference() that
  // removed everything, or a 2D shape never extruded. It compiles, it exports,
  // and it slices to nothing.
  const degenerate = b.size.some((d) => d < printer.nozzle);
  gates.push(gate(
    "has-volume",
    !degenerate,
    true,
    degenerate
      ? `${fmt(b.size)} mm — at least one dimension is thinner than the ${printer.nozzle}mm nozzle, so this can't be printed at all`
      : `${fmt(b.size)} mm`,
  ));

  // --- Overhangs ------------------------------------------------------------
  const hasOverhang = o.overhangArea > 1; // mm²; below this it's chamfer noise
  gates.push(gate(
    "overhangs",
    !hasOverhang,
    false, // advisory: supports are a legitimate answer
    hasOverhang
      ? `${o.overhangArea.toFixed(0)}mm² steeper than ${o.thresholdDeg}° (worst ${o.worstAngleDeg.toFixed(0)}°) — needs supports or a reorientation`
      : `nothing past ${o.thresholdDeg}°`,
  ));

  const blockers = gates.filter((g) => !g.pass && g.block);
  const warnings = gates.filter((g) => !g.pass && !g.block);

  return {
    printable: blockers.length === 0,
    blockers,
    warnings,
    gates,
    measured: {
      size: b.size,
      bounds: b,
      manifold: m,
      overhangs: o,
      volumeMm3: vol,
      // How much of its own bounding box the part actually fills. Not a gate —
      // a spacer legitimately fills nearly all of it — but the number that says
      // "this is a plain block", which is what a subtractive step that quietly
      // removed nothing leaves behind. See `looksUncut` in generate.mjs.
      fill: boxVol > 0 ? vol / boxVol : 0,
    },
  };
}

const fmt = (s) => s.map((d) => d.toFixed(1)).join("×");

/** One-line-per-gate rendering, for the CLI and for feeding a retry prompt. */
export function formatReport(report) {
  const lines = report.gates.map((g) => {
    const mark = g.pass ? "PASS" : g.block ? "FAIL" : "WARN";
    return `  [${mark}] ${g.name}: ${g.detail}`;
  });
  lines.unshift(report.printable ? "Printable." : "Not printable.");
  return lines.join("\n");
}
