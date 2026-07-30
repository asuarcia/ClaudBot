/**
 * portable/discover.mjs — find the Claudbot drive, wherever it mounted.
 *
 * The marker is `portable/manifest.json`. Looking for that rather than a volume
 * label means the drive is recognised even if it's been renamed, and that a
 * random USB stick is never mistaken for a Claudbot drive.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Candidate mount roots for this platform. */
function searchRoots() {
  if (process.platform === "win32") {
    // Skip A: and B: (historic floppy letters, slow to probe) and C: (the system
    // disk — a desktop install is not the portable drive).
    return "DEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`);
  }
  const roots = [];
  const parents = process.platform === "darwin"
    ? ["/Volumes"]
    : ["/media", "/run/media", "/mnt"];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const entry of safeList(parent)) {
      const full = path.join(parent, entry);
      roots.push(full);
      // /media/<user>/<label> and /run/media/<user>/<label> nest one deeper.
      for (const sub of safeList(full)) roots.push(path.join(full, sub));
    }
  }
  return roots;
}

function safeList(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch { return []; }
}

/** Is this directory a Claudbot portable drive? Returns its manifest or null. */
export function readDriveManifest(root) {
  const file = path.join(root, "portable", "manifest.json");
  try {
    if (!statSync(file).isFile()) return null;
    const m = JSON.parse(readFileSync(file, "utf8"));
    // A manifest without a mode isn't ours (or is corrupt) — don't claim it.
    return m && typeof m.mode === "string" ? m : null;
  } catch { return null; }
}

/**
 * Every Claudbot drive currently attached.
 * @returns {Array<{root: string, manifest: object}>}
 */
export function findDrives() {
  const found = [];
  for (const root of searchRoots()) {
    const manifest = readDriveManifest(root);
    if (manifest) found.push({ root, manifest });
  }
  return found;
}

/**
 * Resolve the drive to act on.
 *
 * @param {string|null} explicit  a path the user passed with --drive
 * @returns {{root: string, manifest: object}}
 * @throws if nothing is found, or if the choice is ambiguous
 */
export function resolveDrive(explicit = null) {
  if (explicit) {
    const root = path.resolve(explicit);
    const manifest = readDriveManifest(root);
    if (!manifest) {
      throw new Error(
        `${root} doesn't look like a Claudbot drive ` +
        `(no readable portable/manifest.json).`,
      );
    }
    return { root, manifest };
  }

  const drives = findDrives();
  if (drives.length === 0) {
    throw new Error(
      "No Claudbot drive found.\n" +
      "  Plug it in, or point at it directly:  claudbot sync --drive E:\\",
    );
  }
  if (drives.length > 1) {
    throw new Error(
      `Found ${drives.length} Claudbot drives — say which one:\n` +
      drives.map((d) => `  claudbot sync --drive ${d.root}`).join("\n"),
    );
  }
  return drives[0];
}
