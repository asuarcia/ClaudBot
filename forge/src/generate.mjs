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
 * Never Claude. Modelling is a bounded, well-specified task with a compiler
 * behind it — exactly the shape of work that belongs on a cheap endpoint — and
 * routing it through the registry means Forge inherits the roster, the usage
 * metering and the timeout handling instead of growing its own copy.
 *
 * Defaults to the `cad` agent, which exists to keep CAD spend metered
 * separately and to be repointable without disturbing general code work. The
 * specialisation is not the model, it is `prompts.mjs` — passed explicitly here,
 * so it overrides whatever jobDescription the registry entry carries.
 *
 * `FORGE_AGENT` picks a different agent; a caller can pass its own `ask` to
 * bypass the registry entirely, which is what the tests do so they never touch
 * the network.
 */
async function defaultAsk(system, prompt) {
  const { runAgent } = await import("../../providers/agents.mjs");
  return runAgent(process.env.FORGE_AGENT || "cad", prompt, system);
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

    // Passing the gates is not the same as being the right object. This is the
    // one wrongness that is cheap to detect, so it is checked before declaring
    // success — and it is a retry, not a warning, because the model can fix it.
    const uncut = looksUncut(request, report);
    if (uncut) {
      const repeated = attempts.some((a) => a.stage === "uncut");
      attempts.push({ n, source, dir, built, report, failure: uncut, stage: "uncut" });
      onProgress({ phase: "failed", attempt: n, stage: "shape", failure: uncut.split("\n")[0] });
      if (!repeated && n < maxAttempts) {
        prompt = retryPass(request, source, uncut, n + 1);
        continue;
      }
      // Told once and it did not land. Hand the part back anyway rather than
      // throwing the work away — but say plainly that it looks wrong, because
      // the alternative is the user finding out from the printer.
      onProgress({ phase: "suspect", attempt: n, failure: uncut });
    }

    const previews = render ? backend.render(built.stl, path.join(dir, "preview"), { name }) : {};
    attempts.push({ n, source, dir, built, report, previews, stage: uncut ? "suspect" : "ok" });
    onProgress({ phase: "built", attempt: n, stl: built.stl, step: built.step });

    return {
      ok: true,
      suspect: uncut ?? null,
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
 * Words that mean a *substantial* void, not merely some material removed.
 *
 * Deliberately excludes "hole", "bore", "countersink" and friends. A 3mm hole
 * through a 100mm plate leaves the part filling 99.9% of its bounding box, so a
 * fill-based test cannot tell that part from one where the drill missed — and
 * firing on it would cost a wasted generation on a part that was already right.
 * Every word here implies a void big enough that its absence is unambiguous.
 */
const BIG_VOID = /\b(slot|pocket|hollow|recess|channel|cavity|socket|window|c-?shaped?|u-?shaped?|l-?shaped?|clip|hook|clamp|bracket\s+arm|cradle|holder|tray|box|enclosure|lid|cup|shell)\b/i;

/** How full a part has to be before "nothing was removed" is the likely story. */
const SOLID_FILL = 0.985;

/**
 * A solid block where a cut was asked for.
 *
 * The failure this exists for: a model writes a sketch on the wrong plane, or
 * extrudes a subtraction in the wrong direction, and the cut removes nothing.
 * What comes back is a clean, watertight, perfectly printable solid that is not
 * the requested object at all — and every numeric gate passes it, because there
 * is nothing wrong with it as geometry. A C-shaped desk clip came back as a
 * rounded rectangular block exactly the size of its own bounding box.
 *
 * The signal is cheap: a part that fills essentially all of its bounding box has
 * no substantial void anywhere. That is perfectly legitimate for a spacer or a
 * plate, so it is only a fault when the request itself asked for a big void.
 * Both halves have to agree, and both are deliberately narrow — the cost of a
 * false positive is a wasted generation on a part that was already correct.
 *
 * Not 1.0, because a fillet or chamfer removes a little and a tessellated curve
 * a little more. A real slot removes far more than the margin.
 */
export function looksUncut(request, report) {
  const asked = request.match(BIG_VOID);
  if (!asked) return null;
  const fill = report.measured.fill;
  if (!(fill >= SOLID_FILL)) return null;

  return [
    `The part built and passes every printability gate, but it is a plain solid block:`,
    `it fills ${(fill * 100).toFixed(1)}% of its own bounding box (${report.measured.size.map((n) => n.toFixed(1)).join(" x ")} mm),`,
    `so nothing was actually removed from it.`,
    "",
    `The request asks for "${asked[0]}", which means material has to come out. A`,
    `subtraction that silently removes nothing is almost always a sketch on the`,
    `wrong plane, an extrude going the wrong way, or a cutting solid that does not`,
    `reach the material it is meant to cut.`,
    "",
    `Check that the cutting profile is positioned inside the body, and that it`,
    `overshoots every face it passes through. Make the cut, then verify the result`,
    `is no longer a plain box.`,
  ].join("\n");
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
