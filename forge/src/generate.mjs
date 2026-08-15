/**
 * forge/src/generate.mjs — request in, printable part out.
 *
 * The loop that ties the pieces together: route the request to a backend, ask a
 * model for source, build it, run the printability gates, and on failure hand
 * the exact error back for another attempt.
 *
 * The retry loop is the point of this module. A model writing CAD gets it wrong
 * often, and it gets it wrong in two distinguishable ways: source that does not
 * build (the kernel says so, precisely, and a retry fixes it nearly every time)
 * and source that builds into the wrong solid (nothing says so, and only the
 * gates and a human looking at the preview will catch it). Both go back as
 * feedback; only the first is worth many attempts, which is why a gate failure
 * that repeats itself stops the loop instead of grinding through the budget.
 *
 * Nothing here decides whether to print. `checkPrintable` grades, this reports,
 * and the print verb stays a separate, human-initiated act.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { pick } from "./backends/index.mjs";
import { checkPrintable, formatReport, ENDER3_PRO } from "./printable.mjs";
import { SYSTEM, firstPass, retryPass, extractCode } from "./prompts.mjs";

/** Attempts before giving up, unless the caller says otherwise. */
const DEFAULT_ATTEMPTS = 3;

/**
 * The model that writes the CAD.
 *
 * Resolved through Claudbot's sub-agent registry rather than called directly,
 * so Forge inherits the roster, the metering and the timeout handling instead
 * of growing its own copy. `FORGE_AGENT` overrides which agent; a caller can
 * pass its own `ask` to bypass the registry entirely, which is what the tests
 * do so they never touch the network.
 */
async function defaultAsk(system, prompt) {
  const { runAgent } = await import("../../providers/agents.mjs");
  return runAgent(process.env.FORGE_AGENT || "coder", prompt, system);
}

/**
 * Model a part from a natural-language request.
 *
 * Returns { ok, part, attempts, backend, why }. `part` carries the paths that
 * were produced (stl, step, source, previews) and the gate report. `attempts`
 * is the full history including failures, because "it worked on the third try
 * after the fillet radius came down" is the interesting part of the record.
 *
 * Does not throw on a model that cannot be built — a request that no attempt
 * satisfied is a result, not an exception, and the caller wants the transcript.
 * It does throw when there is no backend at all, or when the model endpoint is
 * unreachable, because those are the caller's problem to fix.
 */
export async function generatePart(request, outDir, {
  name = "part",
  prefer,
  fast = false,
  maxAttempts = DEFAULT_ATTEMPTS,
  printer = ENDER3_PRO,
  render = true,
  ask = defaultAsk,
  onProgress = () => {},
} = {}) {
  const routed = pick(request, { prefer, fast });
  const backend = routed.backend;
  const system = SYSTEM[backend.name];
  if (!system) throw new Error(`No prompt defined for backend "${backend.name}".`);

  mkdirSync(outDir, { recursive: true });
  onProgress({ phase: "routed", backend: backend.name, why: routed.why, unmet: routed.unmet });

  const attempts = [];
  let prompt = firstPass(request, backend, { name });
  let lastSource = null;

  for (let n = 1; n <= maxAttempts; n++) {
    onProgress({ phase: "asking", attempt: n });
    const source = extractCode(await ask(system, prompt));

    if (!source) {
      attempts.push({ n, source: "", failure: "the model returned nothing" });
      prompt = retryPass(request, lastSource ?? "(nothing)", "You returned an empty response.", n + 1);
      continue;
    }
    lastSource = source;

    // Each attempt builds into its own directory. Sharing one would leave the
    // previous attempt's STL in place when a build fails, and everything
    // downstream would happily grade the wrong part.
    const dir = path.join(outDir, `attempt-${n}`);
    let built;
    try {
      onProgress({ phase: "building", attempt: n });
      built = backend.build(source, dir, { name });
    } catch (err) {
      // The kernel's own message. Precise, actionable, and worth every retry.
      attempts.push({ n, source, dir, failure: err.message, stage: "build" });
      onProgress({ phase: "failed", attempt: n, stage: "build", failure: err.message });
      prompt = retryPass(request, source, err.message, n + 1);
      continue;
    }

    const report = checkPrintable(built.stl, printer);
    if (!report.printable) {
      const failure = formatReport(report);
      const repeated = attempts.some((a) => a.stage === "gates" && sameGates(a.failure, failure));
      attempts.push({ n, source, dir, built, report, failure, stage: "gates" });
      onProgress({ phase: "failed", attempt: n, stage: "gates", failure });

      // The same gates failing the same way twice means the feedback is not
      // landing. More attempts at that price buy nothing; stop and report.
      if (repeated) break;
      prompt = retryPass(request, source, failure, n + 1);
      continue;
    }

    const previews = render ? backend.render(built.stl, path.join(dir, "preview"), { name }) : {};
    attempts.push({ n, source, dir, built, report, previews, stage: "ok" });
    onProgress({ phase: "built", attempt: n, stl: built.stl, step: built.step });

    return {
      ok: true,
      backend: backend.name,
      why: routed.why,
      unmet: routed.unmet,
      attempts,
      part: {
        name,
        dir,
        source: built.source,
        stl: built.stl,
        step: built.step,
        previews,
        geometry: built.geometry,
        report,
      },
    };
  }

  return {
    ok: false,
    backend: backend.name,
    why: routed.why,
    unmet: routed.unmet,
    attempts,
    part: null,
    failure: attempts.at(-1)?.failure ?? "no attempts were made",
  };
}

/**
 * Did two gate reports fail for the same reasons?
 *
 * Compares which gates failed, not their wording — the numbers in the detail
 * change between attempts even when the mistake is identical, and comparing the
 * whole text would never find a repeat.
 */
function sameGates(a, b) {
  const names = (text) => text.split("\n")
    .filter((l) => l.includes("[FAIL]"))
    .map((l) => l.split(":")[0].trim())
    .sort()
    .join(",");
  return names(a) === names(b);
}
