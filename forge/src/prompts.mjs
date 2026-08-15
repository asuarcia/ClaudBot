/**
 * forge/src/prompts.mjs — what the model is told before it writes CAD.
 *
 * Kept apart from the chain that calls it because these are findings, not
 * plumbing. Every rule below is here because leaving it out produced a part
 * that was wrong in a way nothing downstream would have caught: a model that
 * compiles, exports, slices, and comes off the bed useless.
 *
 * The printing rules are not style. A 0.6mm wall on a 0.4mm nozzle prints as
 * one bead with no strength; a 5mm hole comes out at 4.7mm and the bolt does
 * not fit; a fillet on the bottom edge lifts the part off the bed and it warps.
 * None of those are visible in a preview and none fail a gate.
 */

/** Rules that hold whatever the backend is — they are about the printer. */
const PRINTING = `
Design for FDM printing on an Ender 3 Pro (0.4mm nozzle, PLA):
- Millimetres. Nothing is dimensionless.
- Z is up. The part must sit ON the bed: its lowest point is z = 0, not
  centred on the origin. A part floating below z=0 slices as a hollow shell.
- Minimum wall thickness 1.2mm (three beads). Below that there is no strength.
- Holes print undersize. Add 0.2mm to the radius of any hole a fastener or
  shaft passes through, and say in a comment that you did.
- Never round or chamfer the bottom edge — the part needs full bed contact.
  Chamfering the TOP edge is good practice and costs nothing.
- Prefer geometry that needs no supports: keep unsupported overhangs under 45°
  from vertical, and bridge no more than about 5mm.
- Use named constants for every dimension, at the top, so the part is
  parametric. This is the difference between a model and a one-off.`.trim();

const OUTPUT = `
Return ONLY the source. No explanation, no markdown fences, no commentary
before or after. Comments inside the source are welcome and should say WHY a
dimension is what it is, not restate what the line does.`.trim();

/** Per-backend system prompt. */
export const SYSTEM = {
  b3d: `
You write build123d (Python) for a 3D printing pipeline. build123d is B-rep
solid modelling on the OpenCascade kernel — the same kind of tool as Fusion 360
— so model the way you would in Fusion: real fillets and chamfers on selected
edges, not unions of cylinders approximating them.

Structure:
- Import from build123d.
- Build inside \`with BuildPart() as part:\`.
- Select edges and faces to operate on rather than modelling around them:
  \`part.edges().filter_by(Axis.Z)\`, \`part.faces().sort_by(Axis.Z)[-1]\`,
  \`.group_by()\`, \`.filter_by(GeomType.CIRCLE)\`.
- End with a module-level \`assembly\`:
      from cad_khana.mechanism.assembly import Assembly
      assembly = Assembly().with_part("<name>", part.part)
  A bare Part is accepted too, but the Assembly is preferred.

Fillet radii must be smaller than the material around them. A fillet larger
than half the thickness of the wall it is on fails to build, and the error is
"Failed creating a fillet with radius of N".

${PRINTING}

${OUTPUT}`.trim(),

  openscad: `
You write OpenSCAD for a 3D printing pipeline.

Structure:
- Named constants at the top, then the geometry.
- Set \`$fn\` on every curved primitive — the default is 30 and a 20mm cylinder
  at $fn=30 has visible flats. Use 64 for holes and 96 for visible curves.
- Overlap solids by 0.01mm before union, and overshoot cutting solids past both
  faces they cut, so coincident surfaces never produce a non-manifold result.

OpenSCAD has no real fillets. Do not fake one with hull() or minkowski() on a
part that needs a rounded edge — say so instead, and it will be routed to the
B-rep backend.

${PRINTING}

${OUTPUT}`.trim(),
};

/** The first attempt at a part. */
export function firstPass(request, backend, { name = "part" } = {}) {
  return [
    `Model this part. Call it "${name}".`,
    "",
    request.trim(),
  ].join("\n");
}

/**
 * A retry, after something downstream rejected the model.
 *
 * The previous source goes back in full, and the failure goes back verbatim —
 * a compiler's own message names the line and the value, and paraphrasing it
 * into "the fillet failed" throws away the part the model needs. The
 * instruction to change only what is broken exists because models given a bare
 * error will happily rewrite the part from scratch and lose the parts that
 * worked.
 */
export function retryPass(request, previousSource, failure, attempt) {
  return [
    `Attempt ${attempt} of this part failed. Fix it and return the corrected source.`,
    "",
    "The part was asked for like this:",
    request.trim(),
    "",
    "This is the source that failed:",
    "",
    previousSource,
    "",
    "This is what went wrong:",
    "",
    failure.trim(),
    "",
    "Change only what is necessary to fix it. Keep every dimension and feature",
    "that was not implicated. Return ONLY the corrected source.",
  ].join("\n");
}

/**
 * Strip the fences a model wraps code in even when told not to.
 *
 * Worth doing rather than failing the attempt: a fenced-but-correct part is a
 * formatting slip, and spending a retry on it wastes a call and teaches the
 * model nothing, because the retry prompt would have to explain the formatting
 * rule it was already given.
 */
export function extractCode(text) {
  const s = (text ?? "").trim();
  const fenced = s.match(/```(?:python|py|openscad|scad|c)?\s*\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : s).trim();
}
