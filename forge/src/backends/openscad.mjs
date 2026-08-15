/**
 * forge/src/backends/openscad.mjs — the mesh/CSG backend.
 *
 * The fast path, and no longer the default. OpenSCAD builds a 20mm spacer in
 * about a fifth of a second where build123d takes several, and LLMs write
 * correct OpenSCAD more reliably than correct build123d for shapes that are
 * only boxes and cylinders. That is the whole of its advantage. It has no real
 * fillets, no chamfers, no assemblies and no STEP export — everything a part
 * needs to look and behave like it came out of modern CAD — so the b3d backend
 * takes anything that is not a plain prism. See backends/index.mjs for the
 * routing.
 *
 * Two things this wrapper exists to get right:
 *
 * - **A clean exit does not mean a good model.** OpenSCAD prints `ERROR:` to
 *   stderr and still exits 0 for several classes of problem, so success is
 *   judged by reading stderr and by whether an STL actually appeared.
 * - **The Manifold backend reports on the solid it built** — "Status: NoError",
 *   a genus, vertex and facet counts. That is a free second opinion from a
 *   completely different implementation than our own manifold gate, so it is
 *   captured rather than discarded.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { require_, find } from "../../toolchain.mjs";

export const name = "openscad";
export const language = "openscad";
export const extension = ".scad";
export const available = () => Boolean(find("openscad"));

/** What this backend can and cannot do, for the router and for prompts. */
export const capabilities = {
  fillets: false,
  chamfers: false,
  step: false,
  assemblies: false,
  fast: true,
};

/**
 * Compile source to an STL.
 *
 * Returns { stl, geometry, log }. Throws with the compiler's own message on
 * failure — that text goes straight back to the generator as retry feedback, so
 * it must stay verbatim rather than being summarised into "compile failed".
 */
export function build(source, outDir, { name: partName = "part" } = {}) {
  const exe = require_("openscad");
  mkdirSync(outDir, { recursive: true });

  const scad = path.join(outDir, `${partName}.scad`);
  const stl = path.join(outDir, `${partName}.stl`);
  writeFileSync(scad, source, "utf8");

  const r = spawnSync(exe, ["--backend=Manifold", "--export-format=binstl", "-o", stl, scad], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  // ERROR: lines are fatal even when the exit code says otherwise.
  const errors = log.split(/\r?\n/).filter((l) => /^\s*ERROR:/i.test(l));
  if (errors.length) throw new Error(errors.join("\n"));

  if (!existsSync(stl) || statSync(stl).size === 0) {
    // The most common cause of an empty export is a model that evaluates to
    // nothing — a difference() that removed everything, or a 2D shape never
    // extruded. Say so, because the generator can act on that.
    throw new Error(
      `OpenSCAD produced no geometry. The model may evaluate to an empty or 2D result.\n${log.trim()}`,
    );
  }

  return { stl, step: null, source: scad, geometry: parseGeometry(log), log, warnings: warningsFrom(log) };
}

/** OpenSCAD's own summary of the solid it built. */
function parseGeometry(log) {
  const n = (re) => {
    const m = log.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    // "Top level object is a 3D object (manifold):" — its own manifold verdict.
    manifold: /3D object \(manifold\)/i.test(log) ? true : /not manifold/i.test(log) ? false : null,
    status: log.match(/Status:\s*(\w+)/i)?.[1] ?? null,
    genus: n(/Genus:\s*(-?\d+)/i),
    vertices: n(/Vertices:\s*(\d+)/i),
    facets: n(/Facets:\s*(\d+)/i),
  };
}

function warningsFrom(log) {
  return log.split(/\r?\n/).filter((l) => /^\s*WARNING:/i.test(l)).map((l) => l.trim());
}

/**
 * Preview renders come from Forge's own renderer, not from OpenSCAD's
 * `--camera` PNG export.
 *
 * OpenSCAD renders what OpenSCAD is: flat-shaded facets in a hard yellow on a
 * flat ground. It is legible for a cube and close to useless for judging
 * curvature, and it would make a part look different depending on which backend
 * happened to build it. Both backends now render from the mesh instead, so the
 * previews are comparable and the OpenSCAD binary is only ever asked to do the
 * one thing it is good at.
 *
 * Renders are not decoration — they are how a human (and the `vision` agent)
 * judge whether the model is the thing that was asked for. Geometry can pass
 * every numeric gate and still be the wrong object.
 */
export { renderViews as render } from "../render.mjs";
