/**
 * forge/toolchain.mjs — finding the external binaries Forge drives.
 *
 * Forge orchestrates three tools it does not ship: OpenSCAD (mesh/CSG),
 * OrcaSlicer (slicing), and cad-khana (build123d/B-rep). None of them are Node
 * packages, none install into the repo, and on Windows none of them reliably
 * land on PATH — winget drops OpenSCAD and OrcaSlicer under Program Files with
 * no shim, and `uv tool install` puts its shims in a per-user bin directory that
 * only gets onto PATH after a shell restart.
 *
 * So every lookup is: explicit env override, then PATH, then the known install
 * locations for this platform. A tool that isn't found is not an error here —
 * `missing()` reports it and the caller decides. Forge is useful without a
 * slicer (you can still model and export) and useful without cad-khana (you can
 * still do OpenSCAD parts), so nothing should hard-fail at import time.
 */

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

/** Candidate absolute paths per tool, in preference order, per platform. */
const KNOWN = {
  openscad: {
    win32: [
      "C:\\Program Files\\OpenSCAD\\openscad.exe",
      "C:\\Program Files (x86)\\OpenSCAD\\openscad.exe",
      // Nightly snapshots install alongside, not over, the stable release.
      "C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe",
    ],
    darwin: ["/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"],
    linux: ["/usr/bin/openscad", "/usr/local/bin/openscad"],
  },
  orca: {
    // The executable is `orca-slicer.exe`, but the installer directory and the
    // Start Menu entry both say "OrcaSlicer". Easy to get wrong.
    win32: [
      "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe",
      "C:\\Program Files (x86)\\OrcaSlicer\\orca-slicer.exe",
    ],
    darwin: ["/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"],
    linux: ["/usr/bin/orca-slicer", "/usr/local/bin/orca-slicer"],
  },
  khana: {
    win32: [path.join(os.homedir(), ".local", "bin", "khana.exe")],
    darwin: [path.join(os.homedir(), ".local", "bin", "khana")],
    linux: [path.join(os.homedir(), ".local", "bin", "khana")],
  },
};

/** Env var that pins each tool, for hosts where the guesses are all wrong. */
const OVERRIDE = {
  openscad: "FORGE_OPENSCAD",
  orca: "FORGE_ORCA",
  khana: "FORGE_KHANA",
};

/** Bare command names to try on PATH. */
const ON_PATH = {
  openscad: "openscad",
  orca: "orca-slicer",
  khana: "khana",
};

/**
 * Is `cmd` runnable as a bare name? Uses where/which rather than spawning the
 * tool itself — OpenSCAD with no arguments opens a GUI window, which is not
 * something a lookup should ever do.
 */
function onPath(cmd) {
  const probe = WIN ? "where.exe" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
  return first?.trim() || null;
}

const cache = new Map();

/**
 * Absolute path to `tool` ("openscad" | "orca" | "khana"), or null if it is not
 * installed. Results are cached — these lookups shell out, and the pipeline asks
 * repeatedly.
 */
export function find(tool) {
  if (cache.has(tool)) return cache.get(tool);

  const pinned = process.env[OVERRIDE[tool]];
  let found = null;

  if (pinned) {
    // An explicit override that points at nothing is a misconfiguration worth
    // surfacing, not something to quietly fall through.
    if (!existsSync(pinned)) {
      throw new Error(`${OVERRIDE[tool]} is set to "${pinned}" but nothing is there.`);
    }
    found = pinned;
  } else {
    found = onPath(ON_PATH[tool])
      ?? (KNOWN[tool][process.platform] ?? []).find((p) => existsSync(p))
      ?? null;
  }

  cache.set(tool, found);
  return found;
}

/** Like find(), but throws with an install hint instead of returning null. */
export function require_(tool) {
  const found = find(tool);
  if (found) return found;
  throw new Error(`${tool} is not installed. ${INSTALL[tool]}`);
}

/** How to get each tool, quoted back to the user when one is missing. */
export const INSTALL = {
  openscad: WIN
    ? "winget install -e --id OpenSCAD.OpenSCAD"
    : "https://openscad.org/downloads.html",
  orca: WIN
    ? "winget install -e --id SoftFever.OrcaSlicer"
    : "https://github.com/SoftFever/OrcaSlicer/releases",
  khana: "uv tool install git+https://github.com/cyberchitta/cad-khana",
};

/** Every tool that isn't installed, as [{ tool, install }]. */
export function missing() {
  return Object.keys(KNOWN)
    .filter((t) => !find(t))
    .map((t) => ({ tool: t, install: INSTALL[t] }));
}

/** Human-readable status of the whole toolchain, for `claudbot forge doctor`. */
export function status() {
  return Object.keys(KNOWN).map((tool) => ({ tool, path: find(tool) }));
}
