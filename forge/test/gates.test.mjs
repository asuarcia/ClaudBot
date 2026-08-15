/**
 * forge/test/gates.test.mjs — each gate, against a mesh built to fail exactly it.
 *
 * The assertion that matters in most of these is not "the bad mesh failed" but
 * "the bad mesh failed *this* gate and nothing else". A gate that fires on
 * everything is as useless as one that never fires, and only the second half of
 * that pair catches it.
 *
 * Run: node --test forge/test/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStl, bounds, manifold, overhangs } from "../src/stl.mjs";
import { checkPrintable, ENDER3_PRO } from "../src/printable.mjs";
import { box, wedge, withHole, withFlippedFace, withDegenerate, writeStl, writeAsciiStl } from "./fixtures.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "forge-test-"));
const at = (name) => path.join(dir, name);

/** Which gates failed, by name. */
const failed = (report) => report.gates.filter((g) => !g.pass).map((g) => g.name);

test("parses binary STL", () => {
  const f = writeStl(at("cube.stl"), box([20, 20, 20]));
  const mesh = parseStl(f);
  assert.equal(mesh.triangles.length, 12);
  assert.deepEqual(bounds(mesh).size, [20, 20, 20]);
});

test("parses ASCII STL, and detects the format by size not by the word 'solid'", () => {
  const f = writeAsciiStl(at("cube-ascii.stl"), box([20, 20, 20]));
  const mesh = parseStl(f);
  assert.equal(mesh.triangles.length, 12);
  assert.deepEqual(bounds(mesh).size, [20, 20, 20]);
});

test("a binary STL whose header starts with 'solid' still parses as binary", () => {
  // The exact trap the size check exists for: this file looks ASCII by its
  // first five bytes and is not.
  const tris = box([10, 10, 10]);
  const f = writeStl(at("solid-header.stl"), tris);
  const buf = readFileSync(f);
  buf.write("solid but actually binary", 0);
  writeFileSync(f, buf);

  assert.equal(parseStl(f).triangles.length, 12);
});

test("a good cube passes every gate", () => {
  const f = writeStl(at("good.stl"), box([20, 20, 20]));
  const report = checkPrintable(f);
  assert.deepEqual(failed(report), [], "no gate should fail on a clean 20mm cube");
  assert.equal(report.printable, true);
});

test("manifold gate: a hole in the surface blocks, and nothing else fires", () => {
  const f = writeStl(at("holed.stl"), withHole(box([20, 20, 20])));
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), ["manifold"]);
  assert.equal(report.printable, false);
  assert.equal(report.blockers[0].name, "manifold");
  assert.match(report.blockers[0].detail, /open edge/);
});

test("manifold gate: an inside-out face is caught even though the mesh is closed", () => {
  const f = writeStl(at("flipped.stl"), withFlippedFace(box([20, 20, 20])));
  const report = checkPrintable(f);

  // The surface is still watertight — every edge has two faces. Only the
  // winding check distinguishes this from a good mesh.
  assert.deepEqual(failed(report), ["manifold"]);
  assert.match(report.blockers[0].detail, /inside-out/);
});

test("manifold gate: zero-area triangles are reported but do not block", () => {
  // A zero-area triangle carries no surface, every slicer discards it, and
  // OpenCascade emits one at the pole of every sphere it tessellates. Blocking
  // on them would make the B-rep backend unable to produce any rounded part.
  const f = writeStl(at("degenerate.stl"), withDegenerate(box([20, 20, 20])));
  const report = checkPrintable(f);

  assert.ok(report.measured.manifold.degenerateTriangles > 0, "still counted");
  assert.ok(report.printable, "a closed mesh with a zero-area sliver is printable");
  assert.match(report.gates.find((g) => g.name === "manifold").detail, /zero-area/);
});

test("manifold gate: a zero-area triangle does not fake a non-manifold edge", () => {
  // The regression this exists for. A degenerate triangle's two surviving
  // edges are the *same* undirected edge, so counting them adds two uses to an
  // edge that already has two — reading as non-manifold — and the duplicate
  // traversal reads as an inverted face. One bad triangle produced three
  // separate failures, and a nine-sphere caterpillar reported "9 open edges, 9
  // inverted faces, 9 zero-area triangles" for a mesh that was watertight.
  const clean = manifold({ triangles: box([20, 20, 20]) });
  const withSliver = manifold({ triangles: withDegenerate(box([20, 20, 20])) });

  assert.equal(withSliver.nonManifoldEdges, clean.nonManifoldEdges, "no invented non-manifold edges");
  assert.equal(withSliver.flippedFaces, clean.flippedFaces, "no invented inverted faces");
  assert.equal(withSliver.openEdges, clean.openEdges, "no invented open edges");
  assert.ok(withSliver.ok, "the mesh is still judged watertight");
});

test("bed-fit gate: an oversized part blocks", () => {
  const f = writeStl(at("huge.stl"), box([300, 300, 50]));
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), ["bed-fit"]);
  assert.equal(report.printable, false);
  assert.match(report.blockers[0].detail, /exceeds/);
});

test("bed-fit gate: too tall blocks even when the footprint is fine", () => {
  const f = writeStl(at("tall.stl"), box([50, 50, 400]));
  const report = checkPrintable(f);
  assert.deepEqual(failed(report), ["bed-fit"]);
});

test("bed-fit gate: a part that only fits turned is flagged but not blocked", () => {
  // 260mm is wider than the 210mm usable square, inside the ~297mm diagonal.
  const f = writeStl(at("diagonal.stl"), box([260, 40, 20]));
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), ["bed-fit"]);
  assert.equal(report.printable, true, "rotating is the user's call, not a hard stop");
  assert.match(report.warnings[0].detail, /rotated/);
});

test("has-volume gate: a film thinner than the nozzle blocks", () => {
  const f = writeStl(at("film.stl"), box([20, 20, 0.1]));
  const report = checkPrintable(f);

  assert.ok(failed(report).includes("has-volume"));
  assert.equal(report.printable, false);
  assert.match(report.blockers.find((b) => b.name === "has-volume").detail, /nozzle/);
});

test("overhang gate: a flat bottom on the bed is not an overhang", () => {
  const f = writeStl(at("onbed.stl"), box([20, 20, 20]));
  const report = checkPrintable(f);

  assert.equal(report.measured.overhangs.overhangArea, 0);
  assert.ok(!failed(report).includes("overhangs"));
});

test("overhang gate: a box translated upwards is still not an overhang", () => {
  // Slicers drop the part onto the plate, so this prints identically to a box
  // at z=0 — its underside becomes the first layer. Flagging it would fire on
  // every model whose author didn't bother sitting it on the origin.
  const f = writeStl(at("floating.stl"), box([20, 20, 20], [0, 0, 10]));
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), []);
  assert.equal(report.measured.overhangs.overhangArea, 0);
});

test("overhang gate: a sloped underside warns but does not block", () => {
  const f = writeStl(at("wedge.stl"), wedge());
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), ["overhangs"]);
  assert.equal(report.printable, true, "supports are a legitimate answer, so this must not block");
  assert.equal(Math.round(report.measured.overhangs.worstAngleDeg), 76);
  // The sloped quad: 20mm deep × hypot(20,5) long.
  assert.ok(Math.abs(report.measured.overhangs.overhangArea - 20 * Math.hypot(20, 5)) < 0.1);
});

test("overhang threshold comes from the printer profile", () => {
  const mesh = parseStl(writeStl(at("wedge2.stl"), wedge()));

  assert.ok(overhangs(mesh, { thresholdDeg: 45 }).overhangArea > 0);
  // The steepest face here is ~76°, so an 80° threshold must find nothing.
  assert.equal(overhangs(mesh, { thresholdDeg: 80 }).overhangArea, 0);
});

test("bed-fit measures size, not position — the slicer centres the part", () => {
  const f = writeStl(at("offset.stl"), box([20, 20, 20], [900, 900, 0]));
  const report = checkPrintable(f);

  assert.deepEqual(failed(report), [], "a part far from the origin is still printable");
});

test("ENDER3_PRO margin is applied to the usable area", () => {
  // 212mm fits inside the raw 220mm bed but not the 210mm usable area.
  const f = writeStl(at("margin.stl"), box([212, 100, 20]));
  const report = checkPrintable(f, ENDER3_PRO);
  assert.ok(failed(report).includes("bed-fit"));
});

test("a corrupt file is rejected rather than read as an empty mesh", () => {
  const f = at("garbage.stl");
  writeFileSync(f, "this is not an STL at all");
  assert.throws(() => parseStl(f), /no triangles found/);
});
