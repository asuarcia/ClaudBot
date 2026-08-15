/**
 * forge/src/backends/index.mjs — which modeller gets the job.
 *
 * Forge carries two, and they are not interchangeable. b3d (build123d on the
 * OpenCascade kernel) is the default: it is real B-rep solid modelling, the
 * same family of tool as Fusion or Onshape, so fillets and chamfers are exact
 * surfaces rather than unions of cylinders, and a part exports as STEP that
 * other CAD packages will open and edit. openscad is the fast path for shapes
 * that are only prisms and holes, where its tenth-of-a-second build beats
 * spinning up Python and a kernel solve for a result that would be identical.
 *
 * The router is deliberately conservative in one direction: it will drop from
 * b3d to openscad only when nothing in the request needs a curved edge, a STEP
 * file or more than one part. Getting that wrong the other way is much worse —
 * a part that quietly comes back with mitred corners instead of filleted ones
 * looks fine in a preview and is wrong in the hand.
 */

import * as b3d from "./b3d.mjs";
import * as openscad from "./openscad.mjs";

/** Preference order. First available wins when nothing more specific applies. */
export const BACKENDS = [b3d, openscad];

export function get(name) {
  const b = BACKENDS.find((x) => x.name === name);
  if (!b) {
    throw new Error(
      `Unknown backend "${name}". Available: ${BACKENDS.map((x) => x.name).join(", ")}`,
    );
  }
  return b;
}

/**
 * Words in a request that mean the mesh backend cannot do the job.
 *
 * Matched against the request text, not inferred by a model, because this
 * decision has to be explainable — `pick` reports which word sent the job where
 * — and because a router that needs an LLM call before it can route is a router
 * that fails when the endpoint is down.
 */
const NEEDS = {
  // The window between "round" and the noun exists because "round the corners"
  // and "rounded outer edges" are how people actually ask, and neither is
  // adjacent. It is allowed to over-match — "a round part with square corners"
  // would trip it — because over-matching sends the job to the more capable
  // backend, and that costs seconds. Under-matching costs a wrong part.
  fillets: /\b(?:fillets?|filleted|round(?:ed)?(?:\s+\w+){0,2}?\s+(?:edges?|corners?)|round\s+over|bull\s?nose)\b/i,
  chamfers: /\b(chamfer|chamfered|bevel|bevell?ed)\b/i,
  step: /\b(step\s*file|\.step\b|\.stp\b|b-?rep|brep|solidworks|fusion\s*360|onshape|parametric\s+cad)\b/i,
  assemblies: /\b(assembl(y|ies)|mating|mates?\b|multi-?part|two-?part|clearance\s+fit|interference)\b/i,
};

/**
 * Requirements implied by a request, as { fillets, chamfers, step, assemblies }.
 * Exported so a caller can show its work, and so the generator's prompt can
 * mention the specific capability that was asked for.
 */
export function requirements(request = "") {
  const out = {};
  for (const [k, re] of Object.entries(NEEDS)) {
    const m = request.match(re);
    if (m) out[k] = m[0];
  }
  return out;
}

/**
 * Choose a backend.
 *
 * Returns { backend, why, unmet } — `why` is a sentence for the user, and
 * `unmet` lists capabilities the chosen backend does not have, which happens
 * when the preferred one is not installed. It is not an error: a fillet-less
 * spacer is still a printable spacer, and saying so is more useful than
 * refusing to model anything until cad-khana is on the machine.
 */
export function pick(request = "", { prefer, fast = false } = {}) {
  const needs = requirements(request);
  const needed = Object.keys(needs);

  if (prefer) {
    const b = get(prefer);
    if (!b.available()) throw new Error(`Backend "${prefer}" is not installed.`);
    return { backend: b, why: `asked for the ${b.name} backend`, unmet: unmetOf(b, needed), needs };
  }

  const usable = BACKENDS.filter((b) => b.available());
  if (!usable.length) {
    throw new Error(
      "No CAD backend is installed. Forge needs cad-khana (preferred) or OpenSCAD; " +
      "run `claudbot forge doctor` for install commands.",
    );
  }

  // Every stated requirement satisfied, most preferred first.
  const capable = usable.find((b) => needed.every((n) => b.capabilities[n]));
  if (capable && !(fast && !needed.length)) {
    return {
      backend: capable,
      why: needed.length
        ? `the request asks for ${needed.map((n) => `"${needs[n]}"`).join(" and ")}, which needs ${capable.name}`
        : `${capable.name} is the default backend`,
      unmet: [],
      needs,
    };
  }

  // Explicitly asked to be quick, and nothing in the request needs a real
  // kernel: take the fastest available instead of the most capable.
  if (fast && !needed.length) {
    const quick = usable.find((b) => b.capabilities.fast) ?? usable[0];
    return { backend: quick, why: `no curved edges or STEP needed, so ${quick.name} is quicker`, unmet: [], needs };
  }

  // Nothing installed can do all of it. Take the most capable that is, and say
  // plainly what it will not be able to deliver.
  const best = usable[0];
  return {
    backend: best,
    why: `${best.name} is the most capable backend installed`,
    unmet: unmetOf(best, needed),
    needs,
  };
}

const unmetOf = (backend, needed) => needed.filter((n) => !backend.capabilities[n]);

/** Backend availability, for `claudbot forge doctor`. */
export function status() {
  return BACKENDS.map((b) => ({
    name: b.name,
    language: b.language,
    available: b.available(),
    capabilities: b.capabilities,
  }));
}
