/**
 * forge/src/render.mjs — shaded previews that look like a CAD viewport.
 *
 * Forge's other preview path is OpenSCAD's own `-o preview.png`, and it looks
 * like OpenSCAD: flat-shaded facets, a hard yellow, no ground. That is fine for
 * checking that a cube is a cube and useless for judging a filleted part, which
 * is exactly the kind of part the B-rep backend exists to make. A fillet only
 * reads as a fillet when the shading across it is smooth.
 *
 * So previews are rendered here instead, from the mesh, for both backends. The
 * look is deliberately modern-CAD — soft gradient ground, three-point studio
 * lighting, hemispherical ambient, contact darkening, crisp feature lines — the
 * conventions Fusion and Onshape use, because that is what the user asked for
 * and because those conventions exist for a reason: they make curvature legible.
 *
 * Hand-rolled rather than taken from npm. The repo has four dependencies, none
 * native, and every 3D or image library for Node either wants a C++ toolchain
 * or drags in a headless GL stack. A z-buffer rasteriser and a PNG writer are
 * each about a hundred lines, and `node:zlib` already does the only hard part.
 *
 * Everything is linear-light internally; sRGB happens once, on the way out.
 */

import zlib from "node:zlib";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { parseStl } from "./stl.mjs";

// ─── Vector helpers ──────────────────────────────────────────────────────────
// Plain arrays, not classes: these run in the innermost loop over millions of
// pixels, and V8 optimises small array arithmetic far better than object churn.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

// ─── Camera ──────────────────────────────────────────────────────────────────

/**
 * Eye directions, as unit vectors pointing *from the model toward the camera*.
 *
 * `iso` is the one that matters. Z-up with the camera front-right-and-above is
 * the home view every modern CAD package opens on, and matching it means a
 * Forge preview and a screenshot of the same part are directly comparable. The
 * Z component is under 1 on purpose: a true 45° isometric hides the top face's
 * proportions, and a slightly lower eye reads better on a printed part.
 */
const VIEWS = {
  iso: [1, -1, 0.85],
  front: [0, -1, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
};

/**
 * Orthonormal view basis for an eye direction.
 *
 * Orthographic, not perspective: CAD previews are measured against, and a
 * perspective preview makes a straight extrusion look tapered. The world up is
 * Z (the print bed's normal) except when looking straight down it, where Z is
 * degenerate as a reference and world Y takes over.
 */
function basis(eye) {
  const w = norm(eye); // toward the camera
  const ref = Math.abs(w[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const u = norm(cross(ref, w)); // screen right
  const v = cross(w, u); // screen up
  return { u, v, w };
}

// ─── Normals ─────────────────────────────────────────────────────────────────

/** Faces meeting at a shallower angle than this are treated as one smooth surface. */
const CREASE_DEG = 35;

/**
 * Per-corner shading normals, smoothed across surfaces but not across edges.
 *
 * An STL has no vertex normals and no notion of a face group — a filleted
 * corner and a sharp corner are both just triangles that happen to share
 * points. Averaging every face at a vertex would round off the sharp edges of
 * a bracket; averaging none would facet the fillets into visible strips.
 *
 * So the average is taken *per corner, over a cluster*: a corner's normal
 * averages only those faces at that position whose own normal is within
 * CREASE_DEG of this face's. The obvious cheaper version — average everything,
 * then discard the result when it has drifted too far from the face normal —
 * looks right and is not. At a vertex where a large flat face meets a small
 * perpendicular one, the average tilts only slightly, passes the test, and that
 * tilt is then interpolated across the whole of a large triangle. On a
 * tessellated flat top face it shows up as soft streaks radiating from every
 * hole, which is exactly what it did here before this was fixed.
 *
 * Weighting is by area, because CAD tessellation is wildly uneven and one
 * sliver triangle should not steer the normal of the face it sits in.
 *
 * Positions are keyed by rounding to a micron. Exporters emit float32, so two
 * triangles that share a vertex mathematically often differ in the last bits,
 * and an exact-match key would silently smooth nothing at all.
 */
function shadingNormals(tris) {
  const key = (p) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;

  const faceN = new Float32Array(tris.length * 3); // unit
  const rawN = new Float32Array(tris.length * 3); // area-weighted
  const at = new Map(); // position -> indices of the faces meeting there

  for (let i = 0; i < tris.length; i++) {
    const [a, b, c] = tris[i].v;
    // Recomputed rather than trusting the STL's stored normal: plenty of
    // exporters write zeroes there, and a zero normal shades as pure black.
    const n = cross(sub(b, a), sub(c, a));
    const area2 = Math.hypot(n[0], n[1], n[2]); // twice the triangle's area
    const unit = area2 > 1e-12 ? [n[0] / area2, n[1] / area2, n[2] / area2] : [0, 0, 1];

    faceN[i * 3] = unit[0]; faceN[i * 3 + 1] = unit[1]; faceN[i * 3 + 2] = unit[2];
    rawN[i * 3] = n[0]; rawN[i * 3 + 1] = n[1]; rawN[i * 3 + 2] = n[2];

    if (area2 <= 1e-12) continue; // degenerate: contributes nothing to shading
    for (const p of tris[i].v) {
      const k = key(p);
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  }

  const minDot = Math.cos((CREASE_DEG * Math.PI) / 180);
  const out = new Float32Array(tris.length * 9);

  for (let i = 0; i < tris.length; i++) {
    const fx = faceN[i * 3], fy = faceN[i * 3 + 1], fz = faceN[i * 3 + 2];
    for (let j = 0; j < 3; j++) {
      let sx = 0, sy = 0, sz = 0;
      for (const k of at.get(key(tris[i].v[j])) ?? []) {
        if (faceN[k * 3] * fx + faceN[k * 3 + 1] * fy + faceN[k * 3 + 2] * fz < minDot) continue;
        sx += rawN[k * 3]; sy += rawN[k * 3 + 1]; sz += rawN[k * 3 + 2];
      }
      const l = Math.hypot(sx, sy, sz);
      const o = i * 9 + j * 3;
      if (l > 1e-12) { out[o] = sx / l; out[o + 1] = sy / l; out[o + 2] = sz / l; }
      else { out[o] = fx; out[o + 1] = fy; out[o + 2] = fz; }
    }
  }
  return out;
}

// ─── Lighting ────────────────────────────────────────────────────────────────

/**
 * A three-point studio rig, in *view* space rather than world space.
 *
 * Keeping the lights attached to the camera is what CAD viewports do, and it is
 * the reason a part never turns out unlit when you orbit it. Key from the upper
 * left, a cooler fill from the lower right to keep shadow sides readable, and a
 * rim from behind that separates the silhouette from the background.
 */
const KEY = norm([-0.55, 0.5, 0.75]);
const FILL = norm([0.7, -0.35, 0.45]);
const RIM = norm([0.2, 0.35, -0.85]);

/** Linear-light material. Roughly Fusion's default grey with a cool cast. */
const DEFAULT_MATERIAL = {
  albedo: [0.34, 0.37, 0.42],
  specular: 0.35,
  shininess: 48,
};

// Background gradient, linear light. Light at the top, settling to a cooler
// grey at the bottom so the part's lower silhouette always has contrast.
const BG_TOP = [0.90, 0.92, 0.95];
const BG_BOTTOM = [0.62, 0.66, 0.72];

// ─── Rendering ───────────────────────────────────────────────────────────────

const SS = 2; // supersampling factor; 2x is the whole anti-aliasing strategy

/**
 * Render a mesh to PNG bytes.
 *
 * `mesh` is what stl.mjs produces: { triangles: [{ normal, v: [[x,y,z]×3] }] }.
 * An empty mesh renders the empty studio rather than throwing — a caller that
 * got no geometry has a better error to report than one from the renderer.
 */
export function renderMesh(mesh, { width = 1200, height = 900, view = "iso", material } = {}) {
  const mat = { ...DEFAULT_MATERIAL, ...material };
  const tris = mesh?.triangles ?? [];

  const W = width * SS;
  const H = height * SS;

  const rgb = new Float32Array(W * H * 3); // linear light
  paintBackground(rgb, W, H);

  if (!tris.length) return encodePng(rgb, width, height, SS);

  const { u, v, w } = basis(VIEWS[view] ?? VIEWS.iso);
  const vn = shadingNormals(tris);

  // Project every vertex once. Three floats per vertex: screen x, screen y in
  // pixels, and view-space depth in mm (larger = nearer the camera).
  const P = new Float32Array(tris.length * 9);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < tris.length; i++) {
    for (let j = 0; j < 3; j++) {
      const p = tris[i].v[j];
      const x = dot(p, u), y = dot(p, v), z = dot(p, w);
      P[i * 9 + j * 3] = x;
      P[i * 9 + j * 3 + 1] = y;
      P[i * 9 + j * 3 + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  // Fit the projected extent to the frame. Done per render rather than from a
  // fixed scale so a 5mm washer and a 200mm plate both fill the image — the
  // preview is for judging shape, and an accurate but 6-pixel-wide part is not.
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W * 0.84) / spanX, (H * 0.84) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Screen Y is flipped: image rows run downward, the view basis runs upward.
  const sx = (x) => (x - cx) * scale + W / 2;
  const sy = (y) => H / 2 - (y - cy) * scale;

  const depth = new Float32Array(W * H).fill(-Infinity);
  const nx = new Float32Array(W * H);
  const ny = new Float32Array(W * H);
  const nz = new Float32Array(W * H);

  for (let i = 0; i < tris.length; i++) {
    const b = i * 9;
    const x0 = sx(P[b]), y0 = sy(P[b + 1]), z0 = P[b + 2];
    const x1 = sx(P[b + 3]), y1 = sy(P[b + 4]), z1 = P[b + 5];
    const x2 = sx(P[b + 6]), y2 = sy(P[b + 7]), z2 = P[b + 8];

    // Twice the signed screen area. Zero means the triangle is edge-on or
    // degenerate; either way there is nothing to fill and dividing by it would
    // produce NaN barycentrics that poison the depth buffer.
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-9)) continue;

    // No backface culling. It would be faster, but a mesh whose faces are
    // inside-out is exactly the failure the printability gates exist to catch,
    // and a preview that quietly renders it as if it were fine is a preview
    // that lies. The z-buffer resolves visibility correctly either way, and
    // shading flips the normal toward the camera below.
    const lo = (a, b_, c) => Math.max(0, Math.floor(Math.min(a, b_, c)));
    const hi = (a, b_, c, lim) => Math.min(lim - 1, Math.ceil(Math.max(a, b_, c)));
    const px0 = lo(x0, x1, x2), px1 = hi(x0, x1, x2, W);
    const py0 = lo(y0, y1, y2), py1 = hi(y0, y1, y2, H);
    if (px1 < px0 || py1 < py0) continue;

    const inv = 1 / area;

    for (let py = py0; py <= py1; py++) {
      const yc = py + 0.5;
      for (let px = px0; px <= px1; px++) {
        const xc = px + 0.5;

        // Barycentric coordinates as ratios of sub-triangle areas. Sign-agnostic
        // (multiplied by `inv`, which carries the winding), so a triangle wound
        // either way still fills.
        const w0 = ((x1 - xc) * (y2 - yc) - (x2 - xc) * (y1 - yc)) * inv;
        const w1 = ((x2 - xc) * (y0 - yc) - (x0 - xc) * (y2 - yc)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = w0 * z0 + w1 * z1 + w2 * z2;
        const idx = py * W + px;
        if (z <= depth[idx]) continue;

        depth[idx] = z;
        const a = vn.subarray(i * 9, i * 9 + 9);
        nx[idx] = w0 * a[0] + w1 * a[3] + w2 * a[6];
        ny[idx] = w0 * a[1] + w1 * a[4] + w2 * a[7];
        nz[idx] = w0 * a[2] + w1 * a[5] + w2 * a[8];
      }
    }
  }

  // Depth range of the actual geometry, used to scale the occlusion and edge
  // thresholds. Both are "is this neighbour meaningfully in front of me", and
  // meaningful is relative to the part, not to millimetres — otherwise the
  // effect vanishes on a washer and swallows a plate.
  const zSpan = Math.max(maxZ - minZ, 1e-6);

  shade(rgb, W, H, depth, nx, ny, nz, u, v, w, mat, zSpan, scale);

  return encodePng(rgb, width, height, SS);
}

/** Vertical gradient plus a soft vignette, painted before any geometry. */
function paintBackground(rgb, W, H) {
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    // Smoothstep rather than linear: a linear ramp bands visibly at 8 bits
    // across a large flat area, and the eye picks the bands out immediately.
    const s = t * t * (3 - 2 * t);
    const r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * s;
    const g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * s;
    const b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * s;
    for (let x = 0; x < W; x++) {
      // Radial falloff, strongest in the corners, keeps the eye on the part.
      const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
      const vig = 1 - 0.16 * Math.min(1, (dx * dx + dy * dy) * 0.7);
      const i = (y * W + x) * 3;
      rgb[i] = r * vig;
      rgb[i + 1] = g * vig;
      rgb[i + 2] = b * vig;
    }
  }
}

/** Ambient-occlusion sample ring, in supersampled pixels. */
const AO_TAPS = [
  [-6, 0], [6, 0], [0, -6], [0, 6],
  [-4, -4], [4, -4], [-4, 4], [4, 4],
  [-11, 0], [11, 0], [0, -11], [0, 11],
];

function shade(rgb, W, H, depth, nx, ny, nz, u, v, w, mat, zSpan, scale) {
  const [ar, ag, ab] = mat.albedo;
  // Occlusion counts a neighbour as blocking once it is this far in front, in
  // mm. Tied to the part's depth range so the effect is scale-invariant.
  const aoBias = zSpan * 0.004;
  const aoRange = zSpan * 0.12;
  const edgeStep = zSpan * 0.02;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const z = depth[idx];
      if (z === -Infinity) continue; // background stays as painted

      // View-space normal. Flipped toward the camera when it faces away, so an
      // inside-out mesh renders as a solid rather than as black holes — the
      // gates report that defect; the preview should still be readable.
      let n = [nx[idx], ny[idx], nz[idx]];
      let vnn = [dot(n, u), dot(n, v), dot(n, w)];
      const len = Math.hypot(vnn[0], vnn[1], vnn[2]);
      if (len < 1e-9) continue;
      vnn = [vnn[0] / len, vnn[1] / len, vnn[2] / len];
      if (vnn[2] < 0) vnn = [-vnn[0], -vnn[1], -vnn[2]];

      // --- ambient occlusion -------------------------------------------------
      let occ = 0, taps = 0;
      for (const [ox, oy] of AO_TAPS) {
        const qx = x + ox, qy = y + oy;
        if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        taps++;
        const qz = depth[qy * W + qx];
        if (qz === -Infinity) continue;
        const d = qz - z; // positive: the neighbour is nearer the camera
        if (d > aoBias) occ += Math.min(1, d / aoRange);
      }
      const ao = taps ? 1 - 0.55 * (occ / taps) : 1;

      // --- lighting ----------------------------------------------------------
      // Hemispherical ambient: sky above, bounce below, blended on the normal's
      // up component. This is what keeps unlit faces from going flat black and
      // is most of the difference between "rendered" and "CSG preview".
      const sky = (vnn[1] + 1) * 0.5;
      const amb = (0.30 * sky + 0.16 * (1 - sky)) * ao;

      const kd = Math.max(0, dot(vnn, KEY)) * 0.78;
      const fd = Math.max(0, dot(vnn, FILL)) * 0.26;
      const rd = Math.max(0, dot(vnn, RIM)) * 0.18;
      const diff = amb + kd + fd + rd;

      // Blinn-Phong against the key light only. A second specular lobe costs
      // as much again and is invisible on a matte print material.
      const half = norm([KEY[0], KEY[1], KEY[2] + 1]); // view dir is +Z in view space
      const spec = mat.specular * Math.pow(Math.max(0, dot(vnn, half)), mat.shininess);

      // Grazing-angle brightening. Physically it is Fresnel; practically it is
      // what makes a cylinder read as round instead of as a shaded rectangle.
      const fres = 0.10 * Math.pow(1 - vnn[2], 4);

      const i3 = idx * 3;
      rgb[i3] = ar * diff + spec + fres;
      rgb[i3 + 1] = ag * diff + spec + fres;
      rgb[i3 + 2] = ab * diff + spec + fres;
    }
  }

  outline(rgb, W, H, depth, nx, ny, nz, edgeStep);
}

/**
 * Darken pixels where the surface breaks.
 *
 * Two kinds of break matter and they need different tests: a depth jump is a
 * silhouette (part against background, or one feature in front of another), and
 * a normal jump is a crease (the edge between two faces at the same depth,
 * where a depth test sees nothing at all). CAD viewports draw both, and without
 * them a shaded grey part loses every edge that happens to face the light the
 * same way as its neighbour.
 */
function outline(rgb, W, H, depth, nx, ny, nz, edgeStep) {
  const out = new Float32Array(W * H); // edge strength, written before applying
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const z = depth[i];
      if (z === -Infinity) continue;

      let edge = 0;
      for (const o of [-1, 1, -W, W]) {
        const q = i + o;
        const qz = depth[q];
        if (qz === -Infinity) { edge = 1; break; } // silhouette against the background
        if (Math.abs(qz - z) > edgeStep) { edge = Math.max(edge, 0.9); continue; }
        const d = nx[i] * nx[q] + ny[i] * ny[q] + nz[i] * nz[q];
        if (d < 0.72) edge = Math.max(edge, (0.72 - d) / 0.72); // ~44° crease
      }
      out[i] = edge;
    }
  }

  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (!e) continue;
    const k = 1 - 0.55 * e;
    rgb[i * 3] *= k;
    rgb[i * 3 + 1] *= k;
    rgb[i * 3 + 2] *= k;
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** The sRGB transfer function. Not a plain 2.2 power — the toe near black is
 * linear, and skipping it visibly crushes the shadow side of a part. */
function srgb(c) {
  if (!(c > 0)) return 0;
  if (c >= 1) return 255;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Encode linear-light RGB to a PNG, box-downsampling by `ss` on the way.
 *
 * Averaging in linear light rather than after the sRGB conversion is the whole
 * point of doing it here: averaging gamma-encoded values darkens every edge
 * pixel, which on a grey part against a light ground shows up as a grubby
 * fringe around the silhouette.
 */
function encodePng(rgb, width, height, ss = 1) {
  const W = width * ss;
  // Each row: one filter byte (0 = None) then RGBA. Filtering would compress
  // better; it also costs a pass over every scanline for images that already
  // deflate to a couple hundred KB.
  const stride = width * 4 + 1;
  const raw = Buffer.allocUnsafe(stride * height);
  const inv = 1 / (ss * ss);

  for (let y = 0; y < height; y++) {
    let o = y * stride;
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * W + (x * ss + dx)) * 3;
          r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2];
        }
      }
      raw[o++] = srgb(r * inv);
      raw[o++] = srgb(g * inv);
      raw[o++] = srgb(b * inv);
      raw[o++] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  // 10..12 stay zero: deflate compression, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** length + type + data + CRC32(type ++ data), all big-endian. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Standard PNG/zlib CRC32: reflected polynomial 0xEDB88320, built once on first
// use rather than as a 256-entry literal.
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Render an STL to a set of preview PNGs. Returns { view: pngPath }.
 *
 * Both backends use this, so a part looks the same whichever one made it — the
 * previews are for judging whether the model is the thing that was asked for,
 * and that judgement is harder if the picture changes style with the toolchain.
 *
 * The default set is the three a person actually looks at. `iso` shows the
 * shape; `front` and `top` are where a wrong dimension shows up, because both
 * project it flat against the frame instead of foreshortening it.
 */
export function renderViews(stlPath, outDir, {
  name = "part",
  views = ["iso", "front", "top"],
  width = 1200,
  height = 900,
  material,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  // Parsed once for all views: on a 200k-triangle part the parse costs more
  // than a render does.
  const mesh = parseStl(stlPath);

  const out = {};
  for (const view of views) {
    const png = path.join(outDir, `${name}-${view}.png`);
    writeFileSync(png, renderMesh(mesh, { width, height, view, material }));
    out[view] = png;
  }
  return out;
}

export { encodePng, VIEWS };
