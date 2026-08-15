# Forge — CAD for the printer

Forge turns a description into a part you can print: it models it, checks
whether it can actually be printed, renders it so you can see what you got, and
slices it. It does not print it. That stays a separate, deliberate act.

```
claudbot forge doctor                 what's installed, and what each backend can do
claudbot forge make "<description>"   model a part, gate it, render it
claudbot forge build <part.py|.scad>  build source you wrote yourself
claudbot forge view <part.stl>        open it in an interactive 3D viewer
claudbot forge check <part.stl>       run the printability gates on any mesh
claudbot forge render <part.stl>      shaded preview PNGs
claudbot forge slice <part.stl>       G-code and a time/filament estimate
```

`make` and `build` pop the viewer open when they finish. `--no-open` writes it
without launching anything, which is what you want on a headless machine or in a
loop that builds twenty parts.

## Who writes the CAD

Not Claude. `make` sends the request to the `cad` agent on NVIDIA NIM — modelling
is a bounded, well-specified task with a compiler behind it, which is exactly the
shape of work that belongs on a cheap endpoint. Override with `FORGE_AGENT`.

The specialisation is the system prompt in `src/prompts.mjs`, not the model, and
Forge passes it explicitly so it overrides the registry's `jobDescription`. `cad`
exists as its own roster entry rather than reusing `coder` so CAD spend is
metered separately in `.claudbot/usage.json` — and so it can be repointed without
disturbing general code work.

Model choice is measured, not assumed. Five candidates were sent the real prompt
and the same request, and whatever came back was built:

| model | tokens out | result |
|---|---|---|
| deepseek-v4-flash-0731 | **352** | built, correct, printable, STEP |
| nemotron-3-nano-30b | 3145 | invented `drill_hole` |
| nemotron-3-super-120b | 4096 | hallucinated `BuildPart.fillet` |
| glm-5.2 | 331 | invented `regular_polygon` |
| minimax-m3 | 376 | used a 2D `Rectangle` in a 3D context |

Only one produced a part that compiles, and it was also the cheapest. Note the
two reasoning models: they spent an order of magnitude more tokens thinking and
still failed. Keep `cad` pointed at a fast instruct model.

`build123d` is an obscure enough API that models confabulate freely in it. That
is what the retry loop is for — the kernel's own error goes back verbatim, and
it usually lands on the second attempt.

## Two backends, and why the default is the slower one

| | `b3d` (default) | `openscad` |
|---|---|---|
| kernel | OpenCascade B-rep | mesh CSG |
| fillets / chamfers | exact, one call | none |
| STEP export | yes | no |
| assemblies | yes | no |
| a 20mm spacer | ~3s | ~0.2s |

`b3d` is [build123d](https://build123d.readthedocs.io) driven through the
[cad-khana](https://github.com/cyberchitta/cad-khana) CLI. It is the same family
of tool as Fusion 360 or Onshape — a real solid modelling kernel — which is why
it is the default despite being an order of magnitude slower. `fillet(edges, r)`
is one call and produces an exact surface; the OpenSCAD equivalent is a hand-built
union of cylinders and spheres that is approximate, slow to render, and cannot be
edited afterwards. And a part that exports as STEP is a part you can open in real
CAD and keep working on, rather than a bag of triangles.

`openscad` remains the fast path for shapes that are only prisms and holes, where
the result would be identical and the wait would not.

The router reads the request for words that imply a capability — *fillet*,
*rounded corners*, *chamfer*, *bevel*, *STEP*, *assembly* — and reports which
word decided it. It over-matches on purpose: sending a plain part to the capable
backend costs seconds, and sending a filleted part to the mesh backend costs a
part with mitred corners that looks fine in the preview and is wrong in the hand.

Force one with `--backend b3d|openscad`, or ask for speed with `--fast`.

## The gates

`src/printable.mjs` stands between "a model" and "a print", because the two are
not the same verb: making a model is cheap and reversible, and making an object
commits an hour of machine time and a hot nozzle moving unattended.

| gate | blocks? | catches |
|---|---|---|
| manifold | yes | open edges, inverted faces, degenerate triangles |
| has-volume | yes | a dimension thinner than the nozzle — the classic empty `difference()` |
| bed-fit | only if rotating won't save it | a part larger than the usable bed |
| overhangs | no, warns | anything past 45°, which is a supports decision, not an error |

Graded rather than boolean on purpose. A non-manifold mesh blocks because the
slicer's output would be meaningless. A steep overhang only warns, because "yes,
with supports" is a real answer, and blocking on it would train you to bypass
the gates — which is worse than not having them.

`forge slice` runs the gates again itself rather than trusting that someone
already did. The OrcaSlicer CLI documents that it slices out-of-bounds parts
without complaining, and the G-code it hands back crashes the gantry.

## When it builds, gates clean, and is still wrong

The gates check that a part *can* be printed. Nothing checks that it is the part
you asked for, and those are different questions. A C-shaped desk clip came back
as a rounded rectangular block: the slot had been sketched on the wrong plane, so
the subtraction removed nothing, and what was left was a flawless, watertight,
perfectly printable solid that passed every gate.

There is one cheap signal for that class of failure. A part that fills
essentially all of its own bounding box has no substantial void in it — so when
the *request* asked for a slot, pocket, clip, hook, shell or cavity and the
result fills ≥98.5% of its box, the cut almost certainly did nothing. `make`
treats that as a failed attempt and retries with an explanation; if the second
attempt is no better it hands the part over anyway with a loud warning, because
throwing away the work would be worse than flagging it.

The word list deliberately excludes "hole" and "bore". A 3mm hole through a
100mm plate leaves the part 99.9% full and completely correct, and firing on it
would waste a generation on a part that was already right.

Everything else in this category is what the previews and the viewer are for.

## Previews

Both backends render through `src/render.mjs` — Forge's own rasteriser — rather
than through OpenSCAD's PNG export or khana's line-art drawings. Three reasons:
a part should look the same whichever backend built it; flat-shaded facets make
a fillet impossible to judge, which defeats the point of having a B-rep backend;
and hidden-line drawings are for a drawing sheet, not for answering "is this the
thing I asked for".

There is also an interactive viewer — a single self-contained HTML file with the
geometry embedded and hand-written WebGL, opened in the default browser. Drag to
orbit, wheel to zoom, shift-drag to pan, and the number keys jump to the standard
views. Three fixed PNGs cannot answer "what does the back look like" or "does
that boss actually clear the rib", and both are one drag away.

Not a desktop 3D viewer, because Windows dropped the built-in one from the
default install and `start part.stl` opens whatever happens to be associated.
Not khana's `view`, because it needs a VS Code extension running. Not Three.js
from a CDN, because that breaks with no internet — including the portable-drive
case this repo exists to support.

The offline renderer is hand-rolled and dependency-free — a z-buffer rasteriser and a PNG writer
are about a hundred lines each, and every 3D or image library for Node wants
either a C++ toolchain or a headless GL stack. Orthographic camera (a
perspective preview makes a straight extrusion look tapered), three-point studio
lighting, hemispherical ambient, screen-space occlusion, and outlines on both
depth and normal discontinuities.

The one subtle part is normal smoothing. An STL has no vertex normals and no
face groups, so a filleted corner and a sharp one are both just triangles that
share points. Each corner averages only the faces at that position whose normals
are within 35° of its own — fillets shade smooth, real edges stay crisp. The
obvious cheaper version (average everything, discard if it drifted too far) is
wrong in a way that is hard to see and easy to ship: it puts soft streaks across
every large flat face.

## Toolchain

Three external programs, none of them Node packages, none reliably on PATH on
Windows. `toolchain.mjs` looks in this order: an env override
(`FORGE_OPENSCAD`, `FORGE_ORCA`, `FORGE_KHANA`), Forge's own portable copy, then
PATH, then the known install locations for the platform. A missing tool is not
an error at import time — Forge is useful without a slicer, and useful without
cad-khana.

Portable copies live under `%LOCALAPPDATA%\Claudbot\tools` as unpacked ZIPs
rather than installed programs: a system-wide install needs elevation this
machine refuses, and a portable build pins an exact version and uninstalls by
deleting a directory.

```
uv tool install git+https://github.com/cyberchitta/cad-khana   # b3d backend
winget install -e --id OpenSCAD.OpenSCAD                        # mesh backend
winget install -e --id SoftFever.OrcaSlicer                     # slicing
```

## Things about the tools that cost real time to find out

**OrcaSlicer CLI.** Machine and process profiles go in *one* `--load-settings`,
semicolon-joined; two flags silently drop the settings. Exactly one profile of
each type — an extra one fails with "duplicate process config file". `inherits`
only resolves inside OrcaSlicer's own resources tree, and a user profile that
inherits a vendor one fails with *no message whatsoever*, so Forge flattens the
process profile. Only the process profile may be flattened; a flattened machine
profile is rejected. Creality's Generic PLA ships `filament_density: 0`, so every
print reported 0.00g until it was overridden to 1.24.

**cad-khana.** It resolves the module-level name `assembly` and it must be an
`Assembly`, not a bare `Part` — exit code 2, and generated modules end at the
Part almost every time, so the b3d backend appends an epilogue that normalises
whatever the module left behind. Outputs are always named `assembly.stl` and
`assembly.step` regardless of the input filename. Exit 1 means the model failed
to build, and the last line before it is the message worth feeding back.

**OpenSCAD.** It prints `ERROR:` to stderr and still exits 0 for several classes
of problem, so success is judged by reading stderr and checking that an STL
actually appeared.

## Verifying

```
node --test forge/test/*.test.mjs   # offline: gates, router, renderer
node forge/verify.mjs               # drives the real binaries end to end
```

The unit tests touch nothing external and pass on a machine with none of the
tools installed. `verify.mjs` is the other half — it catches a toolchain that
moved, an upgrade that renamed a profile, and a vendor JSON that changed shape.
