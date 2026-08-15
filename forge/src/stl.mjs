/**
 * forge/src/stl.mjs — reading STL, and measuring the things that decide whether
 * a model is real geometry or a plausible-looking mess.
 *
 * An LLM will happily emit OpenSCAD that compiles cleanly and produces a solid
 * that is inside-out, has a 0.2mm wall, or is 400mm wide. None of that shows up
 * as an error anywhere upstream — OpenSCAD exports it, and the OrcaSlicer CLI
 * (per its own documented behaviour) will slice an out-of-bounds part without
 * complaint and hand back G-code that crashes the gantry. The checks here are
 * the only place those get caught, so they run before anything reaches a slicer.
 *
 * Everything is deliberately dependency-free. An STL is a list of triangles;
 * parsing one is fifty lines, and taking a mesh library for it would drag a
 * native build into a repo that currently has none.
 */

import { readFileSync } from "node:fs";

/**
 * Parse an STL, binary or ASCII, into { triangles: [{ normal, v: [a,b,c] }] }.
 *
 * Format detection is by size, not by content. The usual trick — "does it start
 * with the word solid" — is wrong: plenty of binary writers put a product name
 * in the 80-byte header and it often begins with "solid", which makes ASCII
 * parsers read a binary file as one enormous broken line. The triangle count at
 * byte 80 gives an exact expected length for a binary file, and that either
 * matches or it doesn't.
 */
export function parseStl(file) {
  const buf = readFileSync(file);
  if (buf.length < 84) {
    // Too short to be a binary header; could still be a tiny ASCII file.
    return parseAscii(buf.toString("utf8"), file);
  }

  const count = buf.readUInt32LE(80);
  if (buf.length === 84 + count * 50) return parseBinary(buf, count);

  return parseAscii(buf.toString("utf8"), file);
}

function parseBinary(buf, count) {
  const triangles = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50;
    triangles[i] = {
      normal: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      v: [
        [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)],
        [buf.readFloatLE(o + 24), buf.readFloatLE(o + 28), buf.readFloatLE(o + 32)],
        [buf.readFloatLE(o + 36), buf.readFloatLE(o + 40), buf.readFloatLE(o + 44)],
      ],
    };
  }
  return { triangles };
}

function parseAscii(text, file) {
  const triangles = [];
  const nums = /[-+0-9.eE]+/g;
  let normal = [0, 0, 0];
  let verts = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("facet normal")) {
      normal = (line.match(nums) ?? []).map(Number).slice(-3);
      verts = [];
    } else if (line.startsWith("vertex")) {
      verts.push((line.match(nums) ?? []).map(Number).slice(-3));
    } else if (line.startsWith("endfacet")) {
      // A malformed facet is a corrupt file, not something to average over.
      if (verts.length !== 3) {
        throw new Error(`${file}: facet with ${verts.length} vertices, expected 3`);
      }
      triangles.push({ normal, v: verts });
    }
  }

  if (!triangles.length) throw new Error(`${file}: no triangles found — not a readable STL`);
  return { triangles };
}

/** Axis-aligned bounds and size, in millimetres. */
export function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const t of mesh.triangles) {
    for (const p of t.v) {
      for (let a = 0; a < 3; a++) {
        if (p[a] < min[a]) min[a] = p[a];
        if (p[a] > max[a]) max[a] = p[a];
      }
    }
  }

  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Vertices are quantised before edges are compared.
 *
 * STL stores every triangle's corners independently, so a shared corner is
 * written three or more times over. Those copies are usually bit-identical, but
 * only usually — a generator that computes the same point by two different
 * routes lands a few ULPs apart, and then a perfectly closed mesh looks like it
 * has thousands of unmatched edges. Snapping to 1e-5 mm (well below any printer's
 * resolution, well above float noise) makes the comparison mean what it should.
 */
const QUANT = 1e5;
const key = (p) => `${Math.round(p[0] * QUANT)},${Math.round(p[1] * QUANT)},${Math.round(p[2] * QUANT)}`;

/**
 * Is the mesh watertight and consistently oriented?
 *
 * A closed surface has every edge shared by exactly two triangles. Fewer means a
 * hole; more means self-intersecting or duplicated geometry. Both slice into
 * garbage, in the specific and expensive way where the slicer succeeds and the
 * print is wrong.
 *
 * Orientation is checked at the same time and almost for free: in a correctly
 * oriented mesh the two triangles sharing an edge traverse it in opposite
 * directions. If they traverse it the same way, one of them is flipped, and the
 * model is partly inside-out.
 */
export function manifold(mesh) {
  const edges = new Map(); // "a|b" (undirected, sorted) -> { count, sameWay }
  const directed = new Set(); // "a>b", to spot two triangles walking an edge alike

  let degenerate = 0;

  for (const t of mesh.triangles) {
    const k = t.v.map(key);

    // A triangle with two coincident corners has no area, so it is not part of
    // the surface and must be left out of the topology entirely — not merely
    // have its collapsed edge skipped. Skipping only that one pair leaves the
    // other two, which are the *same* undirected edge, so a single degenerate
    // triangle would contribute it twice: the shared edge then has three uses
    // and reads as non-manifold, and the duplicate traversal reads as an
    // inverted face. Every sphere OpenCascade tessellates ends in one of these
    // at each pole, so a nine-sphere model came back with nine open edges, nine
    // inverted faces and nine zero-area triangles — the same nine triangles
    // reported three ways, hard-blocking a mesh that is in fact watertight.
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) {
      degenerate++;
      continue;
    }

    for (let i = 0; i < 3; i++) {
      const a = k[i];
      const b = k[(i + 1) % 3];

      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      const rec = edges.get(id) ?? { count: 0, sameWay: false };
      rec.count++;
      if (directed.has(`${a}>${b}`)) rec.sameWay = true;
      directed.add(`${a}>${b}`);
      edges.set(id, rec);
    }
  }

  let open = 0;
  let excess = 0;
  let flipped = 0;
  for (const rec of edges.values()) {
    if (rec.count < 2) open++;
    else if (rec.count > 2) excess++;
    if (rec.sameWay) flipped++;
  }

  return {
    // Zero-area triangles deliberately do not make a mesh non-manifold. They
    // carry no surface, every slicer discards them, and CAD kernels emit them
    // routinely at the poles of a sphere. They are still counted and reported,
    // because a mesh that is mostly degenerate is worth knowing about — but as
    // something to mention, not something to refuse to print.
    ok: open === 0 && excess === 0 && flipped === 0,
    openEdges: open,
    nonManifoldEdges: excess,
    flippedFaces: flipped,
    degenerateTriangles: degenerate,
    triangles: mesh.triangles.length,
  };
}

/**
 * Enclosed volume in mm³.
 *
 * Divergence theorem: the signed volume of the tetrahedron from the origin to
 * each triangle, summed. Where the origin sits does not matter — the outside
 * contributions cancel — so this needs no centring and works on any closed
 * surface. Taken absolute, because an inverted mesh gives the right magnitude
 * with the wrong sign and the manifold gate is what reports the inversion.
 *
 * Meaningless on a mesh that is not closed, which is why callers should read
 * `manifold().ok` first.
 */
export function volume(mesh) {
  let v = 0;
  for (const t of mesh.triangles) {
    const [a, b, c] = t.v;
    v += (
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
  }
  return Math.abs(v);
}

/** Unit normal, recomputed from the winding rather than trusted from the file. */
function faceNormal(t) {
  const [a, b, c] = t.v;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * w[2] - u[2] * w[1],
    u[2] * w[0] - u[0] * w[2],
    u[0] * w[1] - u[1] * w[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  // Zero-area triangle: no meaningful normal, and area 0 means it can't
  // contribute to any overhang total anyway.
  return len === 0 ? { n: [0, 0, 0], area: 0 } : { n: n.map((x) => x / len), area: len / 2 };
}

/**
 * Downward-facing surface too shallow to print without support.
 *
 * Angle is measured from vertical, the convention every slicer's "support
 * threshold" setting uses: a vertical wall is 0°, a flat ceiling is 90°, and the
 * usual limit for unsupported PLA is around 45°.
 *
 * Faces sitting on the bed are excluded — the first layer is the one horizontal
 * surface that needs no support, and counting it would flag every flat-bottomed
 * part ever made. `area` matters as much as angle: a 3mm² overhang is a chamfer
 * artefact, a 3000mm² one is a print that fails at layer 40.
 */
export function overhangs(mesh, { thresholdDeg = 45, bedTolerance = 0.05 } = {}) {
  const zmin = bounds(mesh).min[2];
  let area = 0;
  let worst = 0;

  for (const t of mesh.triangles) {
    const { n, area: a } = faceNormal(t);
    if (a === 0 || n[2] >= 0) continue; // not facing downward

    if (t.v.every((p) => Math.abs(p[2] - zmin) <= bedTolerance)) continue; // on the bed

    const deg = (Math.asin(Math.min(1, -n[2])) * 180) / Math.PI;
    if (deg > thresholdDeg) {
      area += a;
      if (deg > worst) worst = deg;
    }
  }

  return { thresholdDeg, overhangArea: area, worstAngleDeg: worst };
}
