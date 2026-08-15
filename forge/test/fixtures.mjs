/**
 * forge/test/fixtures.mjs — meshes built to fail one gate each.
 *
 * The fixtures are generated rather than committed as binary blobs, so the
 * defect in each one is visible in the diff. Every gate needs a mesh that fails
 * it and passes everything else, otherwise a test that goes green proves only
 * that *something* was wrong.
 */

import { writeFileSync } from "node:fs";

/**
 * A closed axis-aligned box, 12 triangles, wound counter-clockwise seen from
 * outside. This is the "good" mesh every other fixture is a corruption of.
 */
export function box([sx, sy, sz], origin = [0, 0, 0]) {
  const [ox, oy, oz] = origin;
  const p = (x, y, z) => [ox + x * sx, oy + y * sy, oz + z * sz];

  const v = [
    p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), // 0-3 bottom
    p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1), // 4-7 top
  ];

  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom, -Z
    [4, 5, 6], [4, 6, 7], // top, +Z
    [0, 1, 5], [0, 5, 4], // front, -Y
    [1, 2, 6], [1, 6, 5], // right, +X
    [2, 3, 7], [2, 7, 6], // back, +Y
    [3, 0, 4], [3, 4, 7], // left, -X
  ];

  return faces.map((f) => ({ v: f.map((i) => v[i]) }));
}

/**
 * A triangular prism with one steeply sloped underside — a real overhang.
 *
 * Translating a box upwards does *not* make an overhang, which is the trap this
 * fixture exists to avoid: slicers drop a part onto the plate, so a box floating
 * at z=10 prints exactly like one at z=0 and its underside is still the first
 * layer. A genuine overhang needs a downward face that is above the model's own
 * lowest point, which means the shape has to actually slope.
 *
 * Cross-section in XZ, extruded along Y:
 *
 *     (0,20) ┐
 *            │ ╲            the ╱ underside faces down at ~76° from vertical
 *            │   ╲ (20,5)
 *     (0,0)  └ ─ ╱
 */
export function wedge(depth = 20) {
  const a0 = [0, 0, 0], a1 = [20, 0, 5], a2 = [0, 0, 20];
  const b0 = [0, depth, 0], b1 = [20, depth, 5], b2 = [0, depth, 20];

  return [
    { v: [a0, a1, a2] }, { v: [b0, b2, b1] },           // end caps
    { v: [a0, b0, b1] }, { v: [a0, b1, a1] },           // sloped underside
    { v: [a1, b1, b2] }, { v: [a1, b2, a2] },           // upper face
    { v: [a2, b2, b0] }, { v: [a2, b0, a0] },           // back, x=0
  ];
}

/** Drop a face: leaves four unmatched edges where the hole is. */
export function withHole(triangles) {
  return triangles.slice(0, -1);
}

/** Reverse one triangle's winding: its edges now run the same way as its neighbours'. */
export function withFlippedFace(triangles) {
  const out = triangles.map((t) => ({ v: [...t.v] }));
  out[0].v.reverse();
  return out;
}

/** Collapse a triangle to a line: zero area, no usable normal. */
export function withDegenerate(triangles) {
  const out = triangles.map((t) => ({ v: [...t.v] }));
  out.push({ v: [out[0].v[0], out[0].v[0], out[0].v[1]] });
  return out;
}

/**
 * Write triangles as a binary STL.
 *
 * The normal field is written as zeroes on purpose. Real exporters fill it in,
 * but the parser recomputes normals from the winding anyway — writing zeroes
 * here proves it genuinely does, rather than quietly trusting the file.
 */
export function writeStl(file, triangles) {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.write("forge test fixture", 0);
  buf.writeUInt32LE(triangles.length, 80);

  triangles.forEach((t, i) => {
    const o = 84 + i * 50;
    for (let j = 0; j < 3; j++) {
      for (let a = 0; a < 3; a++) {
        buf.writeFloatLE(t.v[j][a], o + 12 + j * 12 + a * 4);
      }
    }
  });

  writeFileSync(file, buf);
  return file;
}

/** Same triangles, ASCII encoding — for the format-detection test. */
export function writeAsciiStl(file, triangles) {
  const body = triangles.map((t) => [
    "  facet normal 0 0 0",
    "    outer loop",
    ...t.v.map((p) => `      vertex ${p[0]} ${p[1]} ${p[2]}`),
    "    endloop",
    "  endfacet",
  ].join("\n")).join("\n");

  writeFileSync(file, `solid forge\n${body}\nendsolid forge\n`);
  return file;
}
