/**
 * forge/test/render.test.mjs — the previews, checked as pixels rather than by eye.
 *
 * A renderer is easy to test badly: "it produced a file" passes for a PNG full
 * of noise, and "it looks right" is not a test. So these decode the image back
 * and assert on what it contains, and the one that matters most is the flat-face
 * check — the first version of the normal smoothing shaded flat faces with soft
 * streaks radiating from every hole, and every other assertion here passed while
 * it did.
 *
 * Run: node --test forge/test/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { renderMesh } from "../src/render.mjs";
import { box, withHole } from "./fixtures.mjs";

/**
 * Decode a PNG this module produced, back to { width, height, at(x, y) }.
 *
 * Only handles what renderMesh emits — 8-bit RGBA, filter 0 on every scanline,
 * one IDAT — which is the point: it verifies the encoder wrote exactly that,
 * not merely something a tolerant decoder would accept.
 */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");

  const chunks = {};
  let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString("ascii", o + 4, o + 8);
    chunks[type] = png.subarray(o + 8, o + 8 + len);
    o += 12 + len; // length + type + data + crc
  }

  assert.ok(chunks.IHDR, "has IHDR");
  assert.ok(chunks.IDAT, "has IDAT");
  assert.ok(chunks.IEND, "has IEND");

  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  assert.equal(chunks.IHDR[8], 8, "8 bits per channel");
  assert.equal(chunks.IHDR[9], 6, "colour type 6 (RGBA)");

  const raw = zlib.inflateSync(chunks.IDAT);
  const stride = width * 4 + 1;
  assert.equal(raw.length, stride * height, "one filter byte per scanline");

  return {
    width,
    height,
    at(x, y) {
      const i = y * stride + 1 + x * 4; // +1 skips the filter byte
      assert.equal(raw[y * stride], 0, "filter type 0");
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

test("produces a decodable PNG at the requested size", () => {
  const img = decode(renderMesh({ triangles: box([20, 20, 20]) }, { width: 200, height: 150 }));
  assert.equal(img.width, 200);
  assert.equal(img.height, 150);
  assert.equal(img.at(0, 0)[3], 255, "opaque");
});

test("an empty mesh renders the background instead of throwing", () => {
  const img = decode(renderMesh({ triangles: [] }, { width: 60, height: 40 }));
  // Every pixel is background, so the corner and the centre agree to within the
  // vignette — what must not happen is a throw or a blank (all-zero) image.
  assert.ok(img.at(30, 20)[0] > 0, "not black");
  assert.equal(img.at(0, 0)[3], 255);
});

test("the part is visibly darker than the ground behind it", () => {
  const img = decode(renderMesh({ triangles: box([20, 20, 20]) }, { width: 200, height: 150 }));
  const corner = img.at(2, 2); // background: the part is fitted with padding
  const middle = img.at(100, 75); // solid
  assert.ok(middle[0] < corner[0] - 20, `part (${middle[0]}) should read darker than ground (${corner[0]})`);
});

test("a flat face shades flat — no streaks from the smoothing", () => {
  // Looking straight down, the whole silhouette is one horizontal face. Every
  // pixel across it must be the same colour: it has one normal, one distance to
  // the lights, and nothing in front of it to occlude it. This is the exact
  // case that broke when the crease test compared the averaged normal to the
  // face normal instead of clustering the faces that meet at each corner.
  const mesh = { triangles: withHole(box([40, 40, 10])) };
  const img = decode(renderMesh(mesh, { width: 200, height: 200, view: "top" }));

  const seen = new Set();
  // A band across the middle of the face, kept well clear of the silhouette and
  // of the hole so neither the outline nor the occlusion term is in play.
  for (let x = 70; x < 130; x++) seen.add(img.at(x, 40).join(","));

  assert.ok(seen.size <= 2, `flat face should be one flat colour, saw ${seen.size} distinct: ${[...seen].slice(0, 4)}`);
});

test("different views produce different images", () => {
  // Three distinct dimensions on purpose. A 40×10×10 box renders identically
  // from the top and the front — same silhouette, same face-on normal — and it
  // is the box that is symmetric, not the camera that is broken.
  const mesh = { triangles: box([40, 25, 10]) };
  const top = renderMesh(mesh, { width: 120, height: 90, view: "top" });
  const front = renderMesh(mesh, { width: 120, height: 90, view: "front" });
  assert.ok(!top.equals(front), "top and front should not be identical");
});

test("the silhouette is outlined", () => {
  // Walking in from the edge, the first covered pixels are the outline and must
  // be darker than the face behind them. Without this the part reads as a flat
  // grey blob against a grey ground.
  const img = decode(renderMesh({ triangles: box([30, 30, 30]) }, { width: 200, height: 200, view: "top" }));

  let edge = null;
  let interior = null;
  for (let x = 0; x < 100; x++) {
    const p = img.at(x, 100)[0];
    if (edge === null && p < 150) edge = p; // stepped onto the part
    else if (edge !== null && x > 60) { interior = p; break; }
  }
  assert.ok(edge !== null, "found the part");
  assert.ok(edge < interior, `edge (${edge}) should be darker than the interior (${interior})`);
});
