/**
 * forge/src/viewer.mjs — the part, in a window you can spin.
 *
 * The PNG previews answer "is this the right shape". They do not answer "what
 * does the back look like", "is that wall as thin as it seems", or "does that
 * boss actually clear the rib" — all of which are one drag away and impossible
 * from three fixed views. So a build now also writes a viewer and opens it.
 *
 * It is a single self-contained HTML file with the geometry embedded, opened in
 * the default browser. That choice over the alternatives:
 *
 * - **A desktop 3D viewer.** Windows dropped the built-in 3D Viewer from the
 *   default install, so `start part.stl` opens whatever is associated, which on
 *   most machines is nothing, and on some is a slicer that takes ten seconds to
 *   load. Not something to hand a user unannounced.
 *
 * - **khana's `view`.** Pushes to the OCP viewer on port 3939, which needs a
 *   VS Code extension running. `khana status` on this machine reports it
 *   unreachable, and a viewer that depends on an editor being open is not a
 *   viewer that pops up.
 *
 * - **Three.js from a CDN.** Would be a hundred lines shorter and would break
 *   on a machine with no internet, which includes the portable-drive case this
 *   repo exists to support. The WebGL below is hand-written for the same reason
 *   the rasteriser is.
 *
 * The lighting deliberately matches render.mjs term for term, so the thing you
 * orbit looks like the thing in the PNG.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { parseStl, bounds } from "./stl.mjs";

/**
 * Geometry, packed for the browser.
 *
 * Positions only — normals are computed on the other side. Sending both would
 * double a file that is already megabytes, and the crease-smoothing pass costs
 * a couple of hundred milliseconds once, at load, on a mesh this size. Base64
 * of a Float32Array rather than JSON numbers: a 51k-triangle part is 1.8MB
 * packed and about 12MB as text, and the browser parses the text far slower
 * than it decodes the base64.
 */
function packPositions(mesh) {
  const f = new Float32Array(mesh.triangles.length * 9);
  let i = 0;
  for (const t of mesh.triangles) {
    for (const v of t.v) {
      f[i++] = v[0];
      f[i++] = v[1];
      f[i++] = v[2];
    }
  }
  return Buffer.from(f.buffer).toString("base64");
}

/**
 * Build the viewer page for an STL.
 *
 * `printer` is optional; when given, the bed outline is drawn so you can see
 * where the part sits on it rather than inferring it from three numbers.
 */
export function viewerHtml(stlPath, { name = "part", printer = null } = {}) {
  const mesh = parseStl(stlPath);
  const b = bounds(mesh);
  const data = packPositions(mesh);

  const meta = {
    name,
    triangles: mesh.triangles.length,
    size: b.size,
    min: b.min,
    max: b.max,
    bed: printer?.bed ?? null,
  };

  return PAGE.replace("__META__", JSON.stringify(meta)).replace("__DATA__", data);
}

/** Write the viewer next to the part. Returns its path. */
export function writeViewer(stlPath, outDir, opts = {}) {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${opts.name ?? "part"}.html`);
  writeFileSync(file, viewerHtml(stlPath, opts), "utf8");
  return file;
}

/**
 * Hand a file to the OS to open however it likes.
 *
 * Detached and unref'd so Forge exits immediately instead of waiting on a
 * browser that may stay open for an hour. Failures are swallowed: not being
 * able to open a window is not a reason to fail a build that produced a good
 * part, and the path was already printed.
 */
export function open(file) {
  try {
    const [cmd, args] =
      // explorer.exe rather than `cmd /c start`. Both hand the file to the
      // default handler, but `start` is a cmd builtin, so it needs a shell that
      // then stays attached to the child — and in a sandboxed or non-interactive
      // shell that hangs instead of returning. explorer takes the path directly,
      // returns at once, and reports a nonzero exit even on success, which is
      // why nothing here reads the exit code.
      process.platform === "win32" ? ["explorer.exe", [file]]
      : process.platform === "darwin" ? ["open", [file]]
      : ["xdg-open", [file]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Build the viewer and open it. Returns its path. */
export function show(stlPath, outDir, opts = {}) {
  const file = writeViewer(stlPath, outDir, opts);
  open(file);
  return file;
}

// ─── The page ────────────────────────────────────────────────────────────────
//
// One file, no requests. __META__ and __DATA__ are substituted above.

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge — part</title>
<style>
  :root {
    --ink: #2b3038;
    --muted: #6b7480;
    --panel: rgba(255,255,255,0.72);
    --edge: rgba(20,28,40,0.10);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    /* The same ground the PNG previews are rendered against. */
    background: linear-gradient(#f2f4f7 0%, #d3d9e1 100%);
    font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    color: var(--ink);
    overflow: hidden;
    -webkit-user-select: none; user-select: none;
  }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas.dragging { cursor: grabbing; }

  .panel {
    position: fixed;
    background: var(--panel);
    border: 1px solid var(--edge);
    border-radius: 10px;
    padding: 10px 13px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 1px 2px rgba(20,28,40,0.06), 0 8px 24px rgba(20,28,40,0.07);
  }
  #info { top: 14px; left: 14px; }
  #info h1 { margin: 0 0 4px; font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
  #info dl { margin: 0; display: grid; grid-template-columns: auto auto; gap: 1px 14px; }
  #info dt { color: var(--muted); }
  #info dd { margin: 0; font-variant-numeric: tabular-nums; }

  #help { bottom: 14px; left: 14px; color: var(--muted); }
  #help b { color: var(--ink); font-weight: 600; }

  #views { top: 14px; right: 14px; display: flex; gap: 4px; padding: 6px; }
  #views button {
    font: inherit; font-size: 12px;
    padding: 5px 11px; border-radius: 6px;
    border: 1px solid transparent; background: transparent; color: var(--muted);
    cursor: pointer;
  }
  #views button:hover { background: rgba(20,28,40,0.06); color: var(--ink); }

  #loading {
    position: fixed; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 14px;
  }
</style>
</head>
<body>
<canvas id="c"></canvas>

<div id="loading">building the view…</div>

<div class="panel" id="info" hidden>
  <h1 id="pname"></h1>
  <dl>
    <dt>size</dt><dd id="psize"></dd>
    <dt>triangles</dt><dd id="ptris"></dd>
  </dl>
</div>

<div class="panel" id="views" hidden>
  <button data-view="iso">Iso</button>
  <button data-view="front">Front</button>
  <button data-view="right">Right</button>
  <button data-view="top">Top</button>
</div>

<div class="panel" id="help" hidden>
  <b>drag</b> orbit &nbsp; <b>wheel</b> zoom &nbsp; <b>shift+drag</b> pan &nbsp; <b>double-click</b> reset
</div>

<script>
"use strict";
const META = __META__;
const DATA = "__DATA__";

// ─── geometry ────────────────────────────────────────────────────────────────

function decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Per-corner normals, smoothed within a surface but not across an edge.
 *
 * Same rule as the offline renderer: a corner averages only those faces at its
 * position whose own normal is within 35 degrees of this face's. Averaging
 * everything would round off the sharp edges; averaging nothing would facet the
 * spheres into strips. Positions are keyed to a micron because exporters write
 * float32 and two triangles that share a vertex usually differ in the last bits.
 */
function shadingNormals(pos) {
  const tris = pos.length / 9;
  const faceN = new Float32Array(tris * 3);
  const rawN = new Float32Array(tris * 3);
  const at = new Map();
  const key = (i) =>
    Math.round(pos[i] * 1e3) + "," + Math.round(pos[i + 1] * 1e3) + "," + Math.round(pos[i + 2] * 1e3);

  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz); // twice the area

    rawN[t * 3] = nx; rawN[t * 3 + 1] = ny; rawN[t * 3 + 2] = nz;
    if (len > 1e-12) {
      faceN[t * 3] = nx / len; faceN[t * 3 + 1] = ny / len; faceN[t * 3 + 2] = nz / len;
      for (let j = 0; j < 3; j++) {
        const k = key(o + j * 3);
        const list = at.get(k);
        if (list) list.push(t); else at.set(k, [t]);
      }
    } else {
      faceN[t * 3 + 2] = 1; // degenerate: no meaningful normal
    }
  }

  const MIN_DOT = Math.cos(35 * Math.PI / 180);
  const out = new Float32Array(pos.length);
  for (let t = 0; t < tris; t++) {
    const fx = faceN[t * 3], fy = faceN[t * 3 + 1], fz = faceN[t * 3 + 2];
    for (let j = 0; j < 3; j++) {
      let sx = 0, sy = 0, sz = 0;
      const list = at.get(key(t * 9 + j * 3));
      if (list) {
        for (let n = 0; n < list.length; n++) {
          const k = list[n];
          if (faceN[k * 3] * fx + faceN[k * 3 + 1] * fy + faceN[k * 3 + 2] * fz < MIN_DOT) continue;
          sx += rawN[k * 3]; sy += rawN[k * 3 + 1]; sz += rawN[k * 3 + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz);
      const o = t * 9 + j * 3;
      if (l > 1e-12) { out[o] = sx / l; out[o + 1] = sy / l; out[o + 2] = sz / l; }
      else { out[o] = fx; out[o + 1] = fy; out[o + 2] = fz; }
    }
  }
  return out;
}

// ─── tiny mat4 ───────────────────────────────────────────────────────────────
// Column-major, the order WebGL wants.

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, at, up) {
  const z = norm([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** Upper-left 3x3 of a rigid transform — orthonormal, so it is its own normal matrix. */
function mat3(m) {
  return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
}

// ─── gl ──────────────────────────────────────────────────────────────────────

const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false });
if (!gl) {
  document.getElementById("loading").textContent = "This browser has no WebGL. The PNG previews are next to this file.";
  throw new Error("no webgl");
}

function shader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// The part. Lighting is in view space and camera-attached, exactly as in
// render.mjs — which is why orbiting never leaves a face unlit.
const partProg = program(
  "attribute vec3 aPos; attribute vec3 aNormal;" +
  "uniform mat4 uMVP; uniform mat4 uMV; uniform mat3 uN;" +
  "varying vec3 vN; varying vec3 vP;" +
  "void main(){ vN = uN * aNormal; vP = (uMV * vec4(aPos,1.0)).xyz; gl_Position = uMVP * vec4(aPos,1.0); }",

  "precision highp float;" +
  "varying vec3 vN; varying vec3 vP;" +
  "uniform vec3 uAlbedo;" +
  "void main(){" +
  "  vec3 KEY = normalize(vec3(-0.55, 0.5, 0.75));" +
  "  vec3 FILL = normalize(vec3(0.7, -0.35, 0.45));" +
  "  vec3 RIM = normalize(vec3(0.2, 0.35, -0.85));" +
  "  vec3 N = normalize(vN);" +
  "  vec3 V = normalize(-vP);" +
  // Two-sided: flip toward the camera so an inside-out mesh still reads as a
  // solid. The gates are what report that defect; the viewer stays legible.
  "  if (dot(N, V) < 0.0) N = -N;" +
  // Hemispherical ambient — sky above, bounce below, blended on screen-up.
  "  float sky = (N.y + 1.0) * 0.5;" +
  "  float amb = 0.30 * sky + 0.16 * (1.0 - sky);" +
  "  float kd = max(0.0, dot(N, KEY)) * 0.78;" +
  "  float fd = max(0.0, dot(N, FILL)) * 0.26;" +
  "  float rd = max(0.0, dot(N, RIM)) * 0.18;" +
  "  vec3 H = normalize(KEY + V);" +
  "  float spec = 0.35 * pow(max(0.0, dot(N, H)), 48.0);" +
  // Grazing-angle brightening: what makes a cylinder read as round.
  "  float fres = 0.10 * pow(1.0 - max(0.0, dot(N, V)), 4.0);" +
  "  vec3 c = uAlbedo * (amb + kd + fd + rd) + spec + fres;" +
  "  gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);" +
  "}"
);

// The bed grid.
const lineProg = program(
  "attribute vec3 aPos; uniform mat4 uMVP; varying float vFade;" +
  "void main(){ vFade = aPos.z; gl_Position = uMVP * vec4(aPos.xy, 0.0, 1.0); }",
  "precision mediump float; varying float vFade;" +
  "void main(){ gl_FragColor = vec4(0.36, 0.41, 0.48, vFade); }"
);

function buffer(data) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}

const positions = decode(DATA);
const normals = shadingNormals(positions);
const posBuf = buffer(positions);
const nrmBuf = buffer(normals);
const vertexCount = positions.length / 3;

// ─── bed grid ────────────────────────────────────────────────────────────────
// Z is packed into the third component as a per-line alpha: the axis lines
// through the origin are drawn stronger than the rest, which is the cheapest
// way to keep the ground readable without a second draw call.

function gridLines(size, step) {
  const v = [];
  const n = Math.ceil(size / step);
  for (let i = -n; i <= n; i++) {
    const p = i * step;
    // Three weights. Anything fainter than about 0.15 disappears entirely
    // against the light ground, which leaves the part looking like it is
    // floating rather than standing on something.
    const a = i === 0 ? 0.55 : (i % 5 === 0 ? 0.34 : 0.17);
    v.push(-size, p, a, size, p, a);
    v.push(p, -size, a, p, size, a);
  }
  return new Float32Array(v);
}

// Big enough to give the part somewhere to stand, small enough not to shrink it.
const footprint = Math.max(META.size[0], META.size[1]);
const gridSize = Math.max(60, Math.ceil(footprint * 0.9 / 10) * 10);
const gridData = gridLines(gridSize, 10);
const gridBuf = buffer(gridData);

// ─── camera ──────────────────────────────────────────────────────────────────

const centre = [
  (META.min[0] + META.max[0]) / 2,
  (META.min[1] + META.max[1]) / 2,
  (META.min[2] + META.max[2]) / 2,
];
const radius = Math.max(1, Math.hypot(META.size[0], META.size[1], META.size[2]) / 2);

// Matches the offline renderer's iso: front-right and above, with the eye a
// little lower than a true 45 degrees so the top face keeps its proportions.
const HOME = { yaw: -0.75, pitch: 0.62, dist: radius * 3.2 };
const VIEWS = {
  iso: HOME,
  front: { yaw: -Math.PI / 2, pitch: 0.001, dist: radius * 3.0 },
  right: { yaw: 0, pitch: 0.001, dist: radius * 3.0 },
  top: { yaw: -Math.PI / 2, pitch: Math.PI / 2 - 0.001, dist: radius * 3.0 },
};

let cam = Object.assign({}, HOME);
let target = centre.slice();
let want = Object.assign({}, cam);
let wantTarget = target.slice();

function eye() {
  const cp = Math.cos(cam.pitch);
  return [
    target[0] + cam.dist * cp * Math.cos(cam.yaw),
    target[1] + cam.dist * cp * Math.sin(cam.yaw),
    target[2] + cam.dist * Math.sin(cam.pitch),
  ];
}

// ─── interaction ─────────────────────────────────────────────────────────────

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 || e.button === 2 };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointerup", (e) => {
  drag = null;
  canvas.releasePointerCapture(e.pointerId);
  canvas.classList.remove("dragging");
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;

  if (drag.pan) {
    // Pan along the camera's own right/up, scaled by distance so the part
    // tracks the cursor at any zoom.
    const e0 = eye();
    const fwd = norm([target[0] - e0[0], target[1] - e0[1], target[2] - e0[2]]);
    const right = norm(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const k = want.dist * 0.0016;
    for (let i = 0; i < 3; i++) wantTarget[i] += (-dx * right[i] + dy * up[i]) * k;
  } else {
    want.yaw -= dx * 0.008;
    // Stop just short of the poles: at exactly vertical the up vector and the
    // view direction are parallel and lookAt produces a NaN matrix.
    want.pitch = Math.max(-1.5533, Math.min(1.5533, want.pitch + dy * 0.008));
  }
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  want.dist = Math.max(radius * 0.25, Math.min(radius * 40, want.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

canvas.addEventListener("dblclick", () => setView("iso"));

function setView(name) {
  const v = VIEWS[name] || HOME;
  want.yaw = v.yaw; want.pitch = v.pitch; want.dist = v.dist;
  wantTarget = centre.slice();
}
for (const b of document.querySelectorAll("#views button")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}
addEventListener("keydown", (e) => {
  const k = { "1": "iso", "2": "front", "3": "right", "4": "top" }[e.key];
  if (k) setView(k);
});

// ─── draw ────────────────────────────────────────────────────────────────────

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

gl.enable(gl.DEPTH_TEST);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(0, 0, 0, 0); // the CSS gradient shows through

function frame() {
  resize();

  // Ease toward the wanted camera. Purely so a view button glides instead of
  // cutting — a jump loses your sense of which way the part turned.
  const e = 0.22;
  cam.yaw += (want.yaw - cam.yaw) * e;
  cam.pitch += (want.pitch - cam.pitch) * e;
  cam.dist += (want.dist - cam.dist) * e;
  for (let i = 0; i < 3; i++) target[i] += (wantTarget[i] - target[i]) * e;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const view = lookAt(eye(), target, [0, 0, 1]);
  const proj = perspective(0.72, canvas.width / canvas.height, Math.max(0.05, cam.dist * 0.01), cam.dist * 20 + 1000);
  const mvp = mul(proj, view);

  gl.useProgram(lineProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, "uMVP"), false, mvp);
  const lPos = gl.getAttribLocation(lineProg, "aPos");
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
  gl.enableVertexAttribArray(lPos);
  gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.LINES, 0, gridData.length / 3);

  gl.useProgram(partProg);
  gl.uniformMatrix4fv(gl.getUniformLocation(partProg, "uMVP"), false, mvp);
  gl.uniformMatrix4fv(gl.getUniformLocation(partProg, "uMV"), false, view);
  gl.uniformMatrix3fv(gl.getUniformLocation(partProg, "uN"), false, mat3(view));
  gl.uniform3f(gl.getUniformLocation(partProg, "uAlbedo"), 0.34, 0.37, 0.42);

  const aPos = gl.getAttribLocation(partProg, "aPos");
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const aNrm = gl.getAttribLocation(partProg, "aNormal");
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.enableVertexAttribArray(aNrm);
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

  requestAnimationFrame(frame);
}

// ─── chrome ──────────────────────────────────────────────────────────────────

document.title = "Forge — " + META.name;
document.getElementById("pname").textContent = META.name;
document.getElementById("psize").textContent =
  META.size.map((d) => d.toFixed(1)).join(" x ") + " mm";
document.getElementById("ptris").textContent = META.triangles.toLocaleString();

document.getElementById("loading").remove();
for (const id of ["info", "views", "help"]) document.getElementById(id).hidden = false;

frame();
</script>
</body>
</html>
`;
