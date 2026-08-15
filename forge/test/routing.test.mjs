/**
 * forge/test/routing.test.mjs — which backend a request goes to, and why.
 *
 * These run on a machine with neither backend installed, so they exercise the
 * requirement detection and the code extraction directly and only assert on
 * `pick` when something is actually available. The routing decision is the one
 * place a wrong answer is invisible: a bracket that comes back with mitred
 * corners instead of filleted ones looks fine in a preview and is wrong in the
 * hand.
 *
 * Run: node --test forge/test/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { requirements, pick, get, BACKENDS } from "../src/backends/index.mjs";
import { extractCode, SYSTEM } from "../src/prompts.mjs";
import { looksUncut } from "../src/generate.mjs";

const anyAvailable = () => BACKENDS.some((b) => b.available());

test("a plain prism needs nothing special", () => {
  assert.deepEqual(requirements("a 20mm cube with a 5mm hole through it"), {});
});

test("rounded corners are detected however they are phrased", () => {
  for (const phrase of [
    "a bracket with filleted edges",
    "a plate with rounded corners",
    "round the corners of the base",
    "add a fillet where the rib meets the plate",
  ]) {
    assert.ok(requirements(phrase).fillets, `should detect fillets in: ${phrase}`);
  }
});

test("chamfers and bevels are the same requirement", () => {
  assert.ok(requirements("chamfer the top edge").chamfers);
  assert.ok(requirements("a bevelled lip").chamfers);
});

test("asking for a STEP file forces the B-rep backend", () => {
  assert.ok(requirements("model this and give me a STEP file").step);
  assert.ok(requirements("something I can open in Fusion 360").step);
});

test("a mesh word is not a fillet", () => {
  // "round" on its own is an adjective about shape, not an edge treatment, and
  // routing every round part to the slower backend would be a real cost.
  assert.deepEqual(requirements("a round spacer 20mm across"), {});
});

test("the detected phrase is reported, not just the flag", () => {
  // `pick` puts this in its explanation, so it has to be the user's own words.
  assert.equal(requirements("with chamfered edges").chamfers, "chamfered");
});

test("get() rejects an unknown backend by name", () => {
  assert.throws(() => get("solidworks"), /Unknown backend/);
});

test("every backend has a prompt", () => {
  for (const b of BACKENDS) {
    assert.ok(SYSTEM[b.name], `no system prompt for backend "${b.name}"`);
  }
});

test("a fillet request routes to a backend that can fillet", { skip: !anyAvailable() }, () => {
  const r = pick("a bracket with filleted corners");
  if (r.backend.capabilities.fillets) assert.deepEqual(r.unmet, []);
  // Otherwise b3d is not installed on this machine — which must be reported as
  // an unmet capability rather than silently modelled with sharp corners.
  else assert.deepEqual(r.unmet, ["fillets"]);
  assert.match(r.why, /filleted|most capable|default/);
});

test("--fast on a plain prism prefers the quick backend", { skip: !anyAvailable() }, () => {
  const r = pick("a 20mm spacer with a 5mm bore", { fast: true });
  const quick = BACKENDS.find((b) => b.available() && b.capabilities.fast);
  if (quick) assert.equal(r.backend.name, quick.name);
});

test("--fast does not override a stated requirement", { skip: !anyAvailable() }, () => {
  const r = pick("a spacer with a chamfered top", { fast: true });
  if (r.backend.capabilities.chamfers) assert.deepEqual(r.unmet, []);
  else assert.deepEqual(r.unmet, ["chamfers"]);
});

test("fenced code is unwrapped rather than costing a retry", () => {
  assert.equal(extractCode("```python\nfrom build123d import *\n```"), "from build123d import *");
  assert.equal(extractCode("```\ncube(10);\n```"), "cube(10);");
  assert.equal(extractCode("cube(10);"), "cube(10);");
});

test("prose around a fenced block is discarded", () => {
  const reply = 'Here is the part:\n\n```python\nBox(1, 2, 3)\n```\n\nLet me know if you want it thicker.';
  assert.equal(extractCode(reply), "Box(1, 2, 3)");
});

test("an empty response extracts to nothing, not to whitespace", () => {
  assert.equal(extractCode("   \n  "), "");
  assert.equal(extractCode(null), "");
});

// ─── the "it built, it gates clean, it is the wrong object" check ────────────

test("a solid block flags when the request asked for a big void", () => {
  // The real failure: a C-shaped desk clip came back as a rounded rectangular
  // block filling 99.1% of its own bounding box, because the slot was sketched
  // on the wrong plane and the subtraction removed nothing. Every gate passed.
  const solid = { measured: { fill: 0.991, size: [15, 25, 48] } };
  assert.ok(looksUncut("a C-shaped desk clip that clamps onto a 20mm desktop", solid));
  assert.match(looksUncut("a clip with a slot", solid), /99\.1%/);
});

test("a legitimately solid part does not flag", () => {
  const solid = { measured: { fill: 0.999, size: [30, 30, 8] } };
  // No void was asked for, so filling the box is exactly right.
  assert.equal(looksUncut("a 30x30x8 spacer plate", solid), null);
});

test("a small hole in a big plate does not flag", () => {
  // 99.9% full and completely correct — a 3mm hole through a 100mm plate. This
  // is why the word list excludes "hole" and "bore".
  const plate = { measured: { fill: 0.9993, size: [100, 100, 5] } };
  assert.equal(looksUncut("a 100x100x5 plate with a 3mm hole in the middle", plate), null);
});

test("a request for a void on a part that has one does not flag", () => {
  const clip = { measured: { fill: 0.42, size: [15, 25, 48] } };
  assert.equal(looksUncut("a C-shaped desk clip", clip), null);
});
