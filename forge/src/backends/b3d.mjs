/**
 * forge/src/backends/b3d.mjs — the B-rep backend, and Forge's default.
 *
 * build123d driven through the cad-khana CLI. This is what makes Forge a modern
 * CAD tool rather than a mesh generator: OpenSCAD works on triangle soup, so a
 * "fillet" is a hand-built union of cylinders and spheres that is expensive,
 * approximate, and cannot be edited afterwards. build123d works on the same
 * OpenCascade kernel Fusion and Onshape are built on, so `fillet(edges, r)` is
 * one call, the result is an exact surface, and it exports as STEP — which is
 * the difference between a model you can only print and a model you can open in
 * a real CAD package and keep working on.
 *
 * Three things about khana that cost time to find out, kept here so they are
 * not rediscovered:
 *
 * - **It resolves the module-level name `assembly`, and it must be an
 *   Assembly.** A bare `Part` is rejected outright ("'assembly' is a Part, not
 *   a factory or an Assembly"), exit code 2. Generated modules end at the Part
 *   almost every time, so `EPILOGUE` below normalises whatever the module left
 *   behind instead of spending a retry on it.
 * - **Exit codes are meaningful**: 1 for a model that failed to build, 2 for a
 *   target it could not resolve. Both print a single clean summary line last,
 *   after the Python traceback, and that line is the useful retry feedback.
 * - **Outputs are named for the assembly, not the input file** — always
 *   `assembly.stl` and `assembly.step` in the output directory.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { require_, find } from "../../toolchain.mjs";

export const name = "b3d";
export const language = "python";
export const extension = ".py";
export const available = () => Boolean(find("khana"));

/** What this backend can do, for the router and for the generator's prompt. */
export const capabilities = {
  fillets: true,
  chamfers: true,
  step: true,
  assemblies: true,
  // Honest: a build123d part costs a Python interpreter start plus an
  // OpenCascade solve, which is seconds where OpenSCAD is tenths of one.
  fast: false,
};

/**
 * Appended to every generated module before it is handed to khana.
 *
 * Deliberately tolerant. The generator is told to end with an Assembly, and
 * most of the time it does; when it does not, the failure is not interesting —
 * it is a naming convention, not a modelling mistake — and burning a retry on
 * it teaches nothing. If the module defined none of these names, this leaves
 * everything alone so khana can report its own, clearer error.
 */
const EPILOGUE = (partName) => `

# ─── appended by Forge ───────────────────────────────────────────────────────
# khana resolves the module-level name \`assembly\` and requires an Assembly
# rather than a bare Part. Normalise whatever this module ended with.
from cad_khana.mechanism.assembly import Assembly as _forge_Assembly
from build123d import BuildPart as _forge_BuildPart

_forge_obj = None
for _forge_name in ("assembly", "part", "result", "model", "solid"):
    _forge_obj = globals().get(_forge_name)
    if _forge_obj is not None:
        break

if isinstance(_forge_obj, _forge_BuildPart):
    _forge_obj = _forge_obj.part

if _forge_obj is not None and not isinstance(_forge_obj, _forge_Assembly):
    assembly = _forge_Assembly().with_part(${JSON.stringify(partName)}, _forge_obj)
`;

/**
 * Compile build123d source to STL + STEP.
 *
 * Returns { stl, step, source, geometry, log }. Throws with khana's own last
 * line on failure — that text goes straight back to the generator as retry
 * feedback, so it stays verbatim rather than being flattened into "build
 * failed". A ValueError naming the fillet radius it could not apply is
 * actionable; "build failed" is not.
 */
export function build(source, outDir, { name: partName = "part" } = {}) {
  const exe = require_("khana");
  mkdirSync(outDir, { recursive: true });

  const py = path.join(outDir, `${partName}.py`);
  writeFileSync(py, source.replace(/\s*$/, "") + EPILOGUE(partName), "utf8");

  // A dedicated staging directory per build. khana names its outputs after the
  // assembly, so two parts built into one directory would overwrite each other
  // and a failed rebuild would leave the previous run's STL sitting there
  // looking like a success.
  const stage = path.join(outDir, "export");
  const r = spawnSync(exe, ["export", py, "--out", stage], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const stl = path.join(stage, "assembly.stl");
  const step = path.join(stage, "assembly.step");

  if (r.status !== 0 || !existsSync(stl)) throw new Error(summarise(log, r.status));

  // Rename off khana's fixed names so a directory of parts is readable and a
  // later build of a different part cannot be mistaken for this one.
  const outStl = path.join(outDir, `${partName}.stl`);
  const outStep = path.join(outDir, `${partName}.step`);
  renameSync(stl, outStl);
  if (existsSync(step)) renameSync(step, outStep);

  return {
    stl: outStl,
    step: existsSync(outStep) ? outStep : null,
    source: py,
    geometry: diagnose(exe, py, path.join(outDir, "diagnostics")),
    log,
    warnings: [],
  };
}

/**
 * khana's own measurements of the solid, from `khana check`.
 *
 * This is the B-rep equivalent of reading OpenSCAD's Manifold report: an
 * independent opinion on validity, volume and topology from the kernel that
 * built the thing, arrived at without going through a mesh. `is_valid: false`
 * with a mesh that still passes every printability gate is the case worth
 * catching — a solid that tessellates cleanly but is not a valid B-rep will
 * export a STEP that other CAD packages reject.
 *
 * Best-effort: a part is not less printable because diagnostics did not run.
 */
function diagnose(exe, py, outDir) {
  try {
    spawnSync(exe, ["check", py, "--out", outDir], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const file = path.join(outDir, "mechanism.json");
    if (!existsSync(file)) return null;

    const d = JSON.parse(readFileSync(file, "utf8"));
    const parts = Object.entries(d.parts ?? {});
    if (!parts.length) return { status: d.status ?? null };

    // One part is the normal case; for an assembly, report the totals, since
    // that is what gets printed.
    const sum = (k) => parts.reduce((t, [, p]) => t + (Number(p[k]) || 0), 0);
    return {
      status: d.status ?? null,
      valid: parts.every(([, p]) => p.is_valid !== false),
      parts: parts.length,
      volumeMm3: sum("volume_mm3"),
      surfaceAreaMm2: sum("surface_area_mm2"),
      faces: sum("face_count"),
      edges: sum("edge_count"),
      interferences: (d.interferences ?? []).length,
      failedAssertions: (d.assertions ?? []).filter((a) => a?.passed === false).length,
    };
  } catch {
    return null;
  }
}

/**
 * khana's most useful line out of a failed run.
 *
 * It prints a Python traceback and then one plain summary — "khana export
 * failed: ValueError: …" or "error: …". The summary is the part a generator can
 * act on, so it leads; the tail of the traceback follows for a human reading
 * the log, because occasionally the summary elides which line broke.
 */
function summarise(log, status) {
  const lines = log.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const headline = [...lines].reverse().find((l) => /^(khana .*failed|error):/i.test(l));

  if (!headline) {
    return `khana exited ${status} with no summary line.\n${lines.slice(-8).join("\n")}`;
  }
  // The last frame before the exception names the offending source line.
  const frame = [...lines].reverse().find((l) => /^\s*File ".*\.py", line \d+/.test(l));
  return frame ? `${headline}\n  (${frame.trim()})` : headline;
}

/**
 * Preview renders. Delegates to Forge's own renderer rather than khana's
 * `draw`, which produces hidden-line engineering drawings — correct for a
 * drawing sheet, and much harder to judge a shape from than a shaded view.
 */
export { renderViews as render } from "../render.mjs";

/** Byte size of a produced file, for reporting. Nonexistent reads as 0. */
export const sizeOf = (p) => (p && existsSync(p) ? statSync(p).size : 0);
