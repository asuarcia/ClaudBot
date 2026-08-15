#!/usr/bin/env node
/**
 * forge/forge.mjs — Forge's command line. Reached as `claudbot forge …`.
 *
 * Five verbs, and the split between them is deliberate: everything here makes
 * or inspects a file, and none of it starts a printer. Committing an hour of
 * machine time to a hot nozzle stays a separate, human-initiated act, so there
 * is no `forge print` — by design, not by omission.
 *
 *   doctor           what is installed and what each backend can do
 *   make <request>   model a part from a description, gate it, preview it
 *   build <file>     build a .py or .scad you wrote yourself
 *   check <stl>      run the printability gates on an existing mesh
 *   render <stl>     shaded preview PNGs
 *   slice <stl>      G-code and an estimate, for a part that passed
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { status as toolStatus, INSTALL, find } from "./toolchain.mjs";
import { status as backendStatus, get as getBackend, pick } from "./src/backends/index.mjs";
import { checkPrintable, formatReport } from "./src/printable.mjs";

import { renderViews } from "./src/render.mjs";
import { show as showViewer, writeViewer } from "./src/viewer.mjs";
import { slice } from "./src/slice.mjs";
import { generatePart } from "./src/generate.mjs";
import { ENDER3_PRO } from "./src/printable.mjs";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

/** Where parts land when the caller does not say. */
const workDir = () => process.env.FORGE_OUT || path.join(process.cwd(), "forge-out");

// ─── doctor ──────────────────────────────────────────────────────────────────

function cmdDoctor() {
  console.log(`\n${C.bold}Forge${C.reset}\n`);

  console.log("  tools");
  for (const { tool, path: p } of toolStatus()) {
    if (p) console.log(`    ${C.green}✓${C.reset} ${tool.padEnd(9)} ${C.dim}${p}${C.reset}`);
    else console.log(`    ${C.red}✗${C.reset} ${tool.padEnd(9)} ${C.dim}${INSTALL[tool]}${C.reset}`);
  }

  console.log("\n  backends");
  for (const b of backendStatus()) {
    const can = Object.entries(b.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ");
    const mark = b.available ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`    ${mark} ${b.name.padEnd(9)} ${C.dim}${b.language.padEnd(9)} ${can}${C.reset}`);
  }

  const usable = backendStatus().filter((b) => b.available);
  console.log(
    usable.length
      ? `\n  ${C.dim}Default backend: ${usable[0].name}.${C.reset}\n`
      : `\n  ${C.yellow}No backend installed — Forge cannot model anything yet.${C.reset}\n`,
  );
  return usable.length ? 0 : 1;
}

// ─── make ────────────────────────────────────────────────────────────────────

async function cmdMake(args) {
  const opts = flags(args);
  const request = opts._.join(" ").trim();
  if (!request) {
    console.error('Usage: claudbot forge make "a 40x20x10 bracket with rounded corners and a 5mm bore"');
    return 2;
  }

  const name = opts.name || slug(request);
  const out = path.join(opts.out || workDir(), name);

  const res = await generatePart(request, out, {
    name,
    prefer: opts.backend,
    fast: Boolean(opts.fast),
    maxAttempts: Number(opts.attempts) || 3,
    onProgress: (e) => {
      if (e.phase === "routed") {
        console.log(`\n  ${C.cyan}${e.backend}${C.reset} ${C.dim}— ${e.why}${C.reset}`);
        if (e.unmet?.length) {
          console.log(`  ${C.yellow}⚠${C.reset}  it cannot do: ${e.unmet.join(", ")}`);
        }
      } else if (e.phase === "asking") {
        process.stdout.write(`  attempt ${e.attempt}: modelling… `);
      } else if (e.phase === "building") {
        process.stdout.write("building… ");
      } else if (e.phase === "failed") {
        console.log(`${C.red}${e.stage} failed${C.reset}\n${C.dim}${indent(e.failure)}${C.reset}`);
      } else if (e.phase === "built") {
        console.log(`${C.green}ok${C.reset}`);
      }
    },
  });

  if (!res.ok) {
    console.log(`\n  ${C.red}Gave up after ${res.attempts.length} attempt(s).${C.reset}`);
    console.log(`${C.dim}${indent(res.failure)}${C.reset}`);
    console.log(`\n  ${C.dim}Every attempt's source is under ${out}.${C.reset}\n`);
    return 1;
  }

  res.part.viewer = viewerFor(res.part, opts);
  report(res.part, res);

  // A part that built, passed every gate, and still does not look like what was
  // asked for. Said loudly and last, so it is the thing left on screen.
  if (res.suspect) {
    console.log(`  ${C.yellow}⚠  This may not be the part you asked for.${C.reset}`);
    console.log(`${C.dim}${indent(res.suspect)}${C.reset}\n`);
  }
  return 0;
}

/**
 * Write the interactive viewer and pop it open.
 *
 * On by default, because the whole point of building a part is to look at it
 * and three fixed PNGs do not answer "what does the back look like". `--no-open`
 * writes the file without launching anything, which is what you want on a
 * machine with no desktop or in a loop that builds twenty parts.
 */
function viewerFor(part, opts, dir = null) {
  const into = dir ?? path.join(part.dir ?? path.dirname(part.stl), "view");
  const args = { name: part.name, printer: ENDER3_PRO };
  if (opts["no-open"]) return writeViewer(part.stl, into, args);
  part.opened = true;
  return showViewer(part.stl, into, args);
}

function report(part, res) {
  console.log(`\n  ${C.bold}${part.name}${C.reset}`);
  console.log(formatReport(part.report).split("\n").map((l) => `  ${l}`).join("\n"));

  if (part.geometry) {
    const g = part.geometry;
    const bits = [
      g.volumeMm3 != null && `${(g.volumeMm3 / 1000).toFixed(1)}cm³`,
      g.faces != null && `${g.faces} faces`,
      g.valid === false && `${C.red}invalid B-rep${C.reset}`,
      g.facets != null && `${g.facets} facets`,
      g.status && `status ${g.status}`,
    ].filter(Boolean);
    if (bits.length) console.log(`  ${C.dim}${bits.join("  ·  ")}${C.reset}`);
  }

  console.log("");
  console.log(`  stl     ${part.stl}`);
  if (part.step) console.log(`  step    ${part.step}`);
  console.log(`  source  ${part.source}`);
  if (part.viewer) {
    console.log(`  view    ${part.viewer}${part.opened ? `  ${C.green}← opening in your browser${C.reset}` : ""}`);
  }
  for (const [view, png] of Object.entries(part.previews ?? {})) {
    console.log(`  ${view.padEnd(7)} ${png}`);
  }
  if (res.attempts.length > 1) {
    console.log(`\n  ${C.dim}Took ${res.attempts.length} attempts.${C.reset}`);
  }
  console.log("");
}

// ─── build ───────────────────────────────────────────────────────────────────

async function cmdBuild(args) {
  const opts = flags(args);
  const file = opts._[0];
  if (!file || !existsSync(file)) {
    console.error("Usage: claudbot forge build <part.py|part.scad>");
    return 2;
  }

  // The extension picks the backend. Unambiguous, and it means a hand-written
  // .scad never gets fed to a Python interpreter with a confusing error.
  const ext = path.extname(file).toLowerCase();
  const name = opts.name || path.basename(file, ext);
  const backend = getBackend(ext === ".py" ? "b3d" : "openscad");
  const out = path.join(opts.out || workDir(), name);

  const { readFileSync } = await import("node:fs");
  let built;
  try {
    built = backend.build(readFileSync(file, "utf8"), out, { name });
  } catch (err) {
    console.error(`\n  ${C.red}${backend.name} rejected it${C.reset}\n${C.dim}${indent(err.message)}${C.reset}\n`);
    return 1;
  }

  const previews = opts["no-render"] ? {} : renderViews(built.stl, path.join(out, "preview"), { name });
  const part = { name, dir: out, ...built, previews, report: checkPrintable(built.stl) };
  part.viewer = viewerFor(part, opts);
  report(part, { attempts: [1] });
  return 0;
}

// ─── view ────────────────────────────────────────────────────────────────────

function cmdView(args) {
  const opts = flags(args);
  const stl = opts._[0];
  if (!stl || !existsSync(stl)) {
    console.error("Usage: claudbot forge view <part.stl>");
    return 2;
  }
  const name = opts.name || path.basename(stl, path.extname(stl));
  const file = viewerFor({ name, stl }, opts, opts.out || null);
  console.log(`\n  ${file}\n`);
  return 0;
}

// ─── check / render / slice ──────────────────────────────────────────────────

function cmdCheck(args) {
  const opts = flags(args);
  const stl = opts._[0];
  if (!stl || !existsSync(stl)) {
    console.error("Usage: claudbot forge check <part.stl>");
    return 2;
  }
  const r = checkPrintable(stl);
  console.log("");
  console.log(formatReport(r).split("\n").map((l) => `  ${l}`).join("\n"));
  console.log("");
  return r.printable ? 0 : 1;
}

function cmdRender(args) {
  const opts = flags(args);
  const stl = opts._[0];
  if (!stl || !existsSync(stl)) {
    console.error("Usage: claudbot forge render <part.stl> [--out dir] [--views iso,front,top]");
    return 2;
  }
  const name = opts.name || path.basename(stl, path.extname(stl));
  const out = opts.out || path.dirname(stl);
  mkdirSync(out, { recursive: true });

  const views = renderViews(stl, out, {
    name,
    views: (opts.views || "iso,front,top").split(",").map((v) => v.trim()).filter(Boolean),
    width: Number(opts.width) || 1200,
    height: Number(opts.height) || 900,
  });
  console.log("");
  for (const [view, png] of Object.entries(views)) console.log(`  ${view.padEnd(7)} ${png}`);
  console.log("");
  return 0;
}

function cmdSlice(args) {
  const opts = flags(args);
  const stl = opts._[0];
  if (!stl || !existsSync(stl)) {
    console.error("Usage: claudbot forge slice <part.stl> [--out dir]");
    return 2;
  }
  if (!find("orca")) {
    console.error(`\n  OrcaSlicer is not installed. ${INSTALL.orca}\n`);
    return 1;
  }

  // Slicing an ungated part is how a gantry crash happens. The gates are cheap;
  // run them here rather than trusting that someone already did.
  const gate = checkPrintable(stl);
  if (!gate.printable) {
    console.error(`\n  ${C.red}Not sliced — this part failed the gates.${C.reset}`);
    console.error(formatReport(gate).split("\n").map((l) => `  ${l}`).join("\n"));
    console.error("");
    return 1;
  }

  const name = opts.name || path.basename(stl, path.extname(stl));
  const { gcode, estimate } = slice(stl, opts.out || path.join(path.dirname(stl), "gcode"), { name });

  console.log(`\n  ${gcode}`);
  const parts = [
    estimate.timeText && estimate.timeText,
    estimate.grams != null && `${estimate.grams.toFixed(1)} g`,
    estimate.layers != null && `${estimate.layers} layers`,
  ].filter(Boolean);
  console.log(`  ${C.dim}${parts.join("  ·  ")}${C.reset}\n`);
  return 0;
}

// ─── plumbing ────────────────────────────────────────────────────────────────

/** Minimal flag parser: `--key value`, `--flag`, everything else positional. */
function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** A filesystem-safe part name from a request, when none was given. */
function slug(text) {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return s || "part";
}

const indent = (text) => text.split("\n").map((l) => `    ${l}`).join("\n");

function usage() {
  console.log(`
  ${C.bold}claudbot forge${C.reset} — CAD for the printer

    doctor                    what is installed, and what each backend can do
    make "<description>"      model a part, gate it, render it
    build <part.py|.scad>     build source you wrote yourself
    view <part.stl>           open it in an interactive 3D viewer
    check <part.stl>          run the printability gates
    render <part.stl>         shaded preview PNGs
    slice <part.stl>          G-code and a time/filament estimate

  ${C.dim}make/build options:  --name <n>  --out <dir>  --backend b3d|openscad
                       --fast  --attempts <n>  --no-open${C.reset}

  ${C.dim}make and build pop the viewer open when they finish. --no-open writes it
  without launching a browser.${C.reset}
`);
  return 0;
}

const [verb, ...rest] = process.argv.slice(2);
const run = {
  doctor: cmdDoctor,
  make: cmdMake,
  build: cmdBuild,
  view: cmdView,
  check: cmdCheck,
  render: cmdRender,
  slice: cmdSlice,
}[verb] ?? usage;

try {
  process.exitCode = (await run(rest)) ?? 0;
} catch (err) {
  console.error(`\n  ${C.red}${err.message}${C.reset}\n`);
  process.exitCode = 1;
}
