/**
 * forge/src/slice.mjs — driving the OrcaSlicer CLI.
 *
 * Three things about this interface cost real time to discover, so they are
 * written down rather than rediscovered:
 *
 * 1. **Machine and process go in one `--load-settings`, semicolon-joined.** Two
 *    separate flags silently drop the settings instead of erroring.
 * 2. **Exactly one profile of each type.** Appending an override file next to
 *    the vendor process profile fails with "duplicate process config file", so
 *    an override has to *replace* the vendor profile, not accompany it.
 * 3. **`inherits` only resolves inside OrcaSlicer's own resources tree.** A user
 *    profile that inherits from a vendor one fails with no message at all — just
 *    "found error, exit". So an override has to be *flattened*: the chain
 *    resolved into one self-contained file (see `flatten`).
 * 4. **Only the process profile may be flattened.** Tested all four
 *    combinations: a flattened process works, and a flattened *machine* profile
 *    is rejected — presumably the machine preset is matched against the vendor
 *    registry by identity, which a rewritten copy no longer satisfies. So the
 *    machine profile is always passed through as the vendor's own file. That
 *    costs nothing, since process is the only one Forge overrides.
 *
 * The Ender 3 Pro's stock firmware also needs `layer_change_gcode: "G92 E0\n"`.
 * Without it OrcaSlicer refuses outright: relative extruder addressing loses
 * floating-point accuracy over a long print unless E is reset each layer.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { require_, find } from "../toolchain.mjs";

/** OrcaSlicer's bundled vendor profiles, which we read but never modify. */
function profileRoot() {
  const exe = require_("orca");
  return path.join(path.dirname(exe), "resources", "profiles");
}

/**
 * Locate a vendor profile by its `name` field's filename.
 *
 * Profiles reference each other by name, not path, and the commons
 * (`fdm_process_common`) sit in the same directories as the leaves, so a plain
 * directory scan per vendor is the honest way to resolve one.
 */
function findProfile(name, vendor = "Creality") {
  const root = profileRoot();
  for (const kind of ["process", "machine", "filament"]) {
    const p = path.join(root, vendor, kind, `${name}.json`);
    if (existsSync(p)) return p;
  }
  const atRoot = path.join(root, vendor, `${name}.json`);
  return existsSync(atRoot) ? atRoot : null;
}

/**
 * Resolve a profile's `inherits` chain into one self-contained object.
 *
 * Merges base-first so a leaf overrides its parent, and drops `inherits` from
 * the result — the whole point is that the output needs no further resolution.
 * `setting_id` goes too: it identifies the *vendor's* preset, and leaving it on
 * a modified copy claims to be something it isn't.
 */
export function flatten(name, overrides = {}, vendor = "Creality") {
  const chain = [];
  let current = name;

  for (let depth = 0; current && depth < 16; depth++) {
    const file = findProfile(current, vendor);
    if (!file) throw new Error(`profile "${current}" not found under ${profileRoot()}`);
    const json = JSON.parse(readFileSync(file, "utf8"));
    chain.unshift(json);
    current = json.inherits;
  }

  const merged = Object.assign({}, ...chain, overrides);
  delete merged.inherits;
  delete merged.setting_id;
  merged.from = "User";
  return merged;
}

/** Absolute path to a vendor profile file, passed through untouched. */
export function vendorProfile(kind, name, vendor = "Creality") {
  const p = path.join(profileRoot(), vendor, kind, `${name}.json`);
  if (!existsSync(p)) throw new Error(`vendor ${kind} profile "${name}" not found at ${p}`);
  return p;
}

/**
 * The Ender 3 Pro: vendor machine and filament by path, process flattened so it
 * can carry Forge's overrides. See header note 4 for why the split.
 *
 * `layer_change_gcode` is the one non-negotiable override.
 */
export function ender3ProProfiles(overrides = {}) {
  return {
    machine: vendorProfile("machine", "Creality Ender-3 Pro 0.4 nozzle"),
    // Flattened only to fix the density. "Creality Generic PLA" is a base other
    // profiles inherit from, and it ships filament_density: 0 — which makes
    // OrcaSlicer report "total filament used [g] = 0.00" for every print. Weight
    // is one of the numbers the printability gate judges, so it has to be real.
    // 1.24 g/cm³ is standard PLA.
    filament: flatten("Creality Generic PLA", { filament_density: "1.24" }),
    process: flatten("0.20mm Standard @Creality Ender3 Pro 0.4", {
      name: "Forge 0.20mm Ender-3 Pro 0.4",
      layer_change_gcode: "G92 E0\n",
      ...overrides,
    }),
  };
}

/**
 * Slice an STL to G-code. Returns { gcode, estimate, profileDir }.
 *
 * `outDir` receives OrcaSlicer's output, which is always named `plate_1.gcode`
 * regardless of the input filename — renamed here to match the part so a
 * directory of prints is readable.
 */
export function slice(stlPath, outDir, { profiles = ender3ProProfiles(), name } = {}) {
  const exe = require_("orca");
  mkdirSync(outDir, { recursive: true });

  // A profile is either a path to a vendor file (passed straight through) or a
  // flattened object that has to be written out first. Derived files go
  // somewhere temporary, never into the repo: they are large and they change
  // whenever OrcaSlicer is upgraded.
  const profileDir = path.join(os.tmpdir(), `forge-profiles-${process.pid}`);
  mkdirSync(profileDir, { recursive: true });
  const resolve = (kind) => {
    const p = profiles[kind];
    if (typeof p === "string") return p;
    const f = path.join(profileDir, `${kind}.json`);
    writeFileSync(f, JSON.stringify(p, null, 2));
    return f;
  };
  const machine = resolve("machine");
  const process_ = resolve("process");
  const filament = resolve("filament");

  // Slice into an empty scratch directory rather than straight into outDir.
  // Success is judged by which .gcode files appear, and a previous run's output
  // sitting in outDir would be counted as this run's — which shows up as a
  // bogus "the part needs two plates".
  const stage = path.join(profileDir, "out");
  mkdirSync(stage, { recursive: true });

  const r = spawnSync(exe, [
    "--slice", "1",
    // One flag, semicolon-joined. See header note 1.
    "--load-settings", `${machine};${process_}`,
    "--load-filaments", filament,
    "--outputdir", stage,
    stlPath,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });

  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  // OrcaSlicer exits 0 on some failures, so success is judged by whether a
  // G-code file actually appeared, not by the exit code.
  const produced = readdirSync(stage).filter((f) => f.endsWith(".gcode")).sort();

  if (!produced.length) {
    throw new Error(`slicing failed:\n${output.trim() || "(no output from the slicer)"}`);
  }

  // Multiple plates mean the part didn't fit on one and OrcaSlicer split it.
  // That should have been caught by the bed-fit gate, so it is worth saying.
  if (produced.length > 1) {
    throw new Error(`slicer produced ${produced.length} plates — the part does not fit on one bed`);
  }

  // OrcaSlicer always names its output plate_1.gcode regardless of the input
  // filename, so a directory of prints would otherwise be unreadable.
  const gcode = path.join(outDir, `${name ?? path.parse(stlPath).name}.gcode`);
  renameSync(path.join(stage, produced[0]), gcode);

  return { gcode, estimate: estimateFrom(gcode), output };
}

/**
 * Print time and filament use, read back out of the G-code.
 *
 * Reading the file rather than parsing stdout means the numbers always describe
 * the artefact on disk, which is what the printability gate needs to judge.
 *
 * The summary is split across the file: `total layer number` sits in the header,
 * while filament and time land in a block near the end, after the last move. So
 * both ends get read — and only both ends, because these files reach tens of
 * megabytes and none of the middle is summary.
 */
export function estimateFrom(gcodePath) {
  const buf = readFileSync(gcodePath);
  const WINDOW = 96 * 1024;
  const text = buf.length <= WINDOW * 2
    ? buf.toString("utf8")
    : buf.subarray(0, WINDOW).toString("utf8") + "\n" + buf.subarray(buf.length - WINDOW).toString("utf8");

  // A missing value must stay null, never 0 — Number(null) is 0, and a silent
  // zero here reads as "this print uses no filament", which is a lie the gates
  // would act on.
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };

  const timeText = text.match(/;\s*estimated printing time \(normal mode\)\s*=\s*(.+)/i)?.[1]?.trim() ?? null;

  return {
    timeText,
    minutes: timeText ? parseDuration(timeText) : null,
    grams: num(/;\s*total filament used \[g\]\s*=\s*([\d.]+)/i),
    cm3: num(/;\s*filament used \[cm3\]\s*=\s*([\d.]+)/i),
    millimetres: num(/;\s*filament used \[mm\]\s*=\s*([\d.]+)/i),
    layers: num(/;\s*total layer number:\s*(\d+)/i),
  };
}

/** "1h 3m 20s" / "2d 4h" → minutes. */
function parseDuration(text) {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*([dhms])/gi)) {
    total += Number(n) * { d: 1440, h: 60, m: 1, s: 1 / 60 }[unit.toLowerCase()];
  }
  return total ? Math.round(total) : null;
}

/** Is a slicer available at all? Lets callers degrade instead of throwing. */
export const available = () => Boolean(find("orca"));
