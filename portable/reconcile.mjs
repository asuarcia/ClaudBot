/**
 * portable/reconcile.mjs — keep one continuous conversation history across
 * machines, even though the drive letter changes.
 *
 * The problem: Claude Code names each project's transcript directory after the
 * absolute cwd, with non-alphanumerics dashed out. Claudbot runs Claude with
 * cwd = <drive>/app/.claudbot, so the directory is:
 *
 *   plugged into machine A (E:)  ->  projects/E--app--claudbot
 *   plugged into machine B (F:)  ->  projects/F--app--claudbot
 *   /Volumes/CLAUDBOT on a Mac   ->  projects/-Volumes-CLAUDBOT-app--claudbot
 *
 * Without intervention every machine starts a fresh, empty history and `recall`
 * silently forgets everything from the other machines. So on each boot we
 * rename the previous session's directory to the one this machine will use, and
 * record the new name for next time.
 *
 * Renaming (not copying) is deliberate: it's atomic on the same filesystem, and
 * it guarantees exactly one canonical history rather than N diverging copies.
 */

import path from "node:path";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";

/** Read the small JSON file that remembers the last directory name we used. */
function readManifest(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

function writeManifest(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Move every transcript from `from` into `to`, then drop `from` if it empties.
 * Used when both directories somehow exist — e.g. the drive was plugged into
 * this same machine before, so its directory was already here.
 */
function mergeInto(from, to) {
  mkdirSync(to, { recursive: true });
  let moved = 0;
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    let dst = path.join(to, entry);
    // Name collision: same session id already present. Keep the larger file —
    // transcripts only ever grow, so the bigger one is the more complete one.
    if (existsSync(dst)) {
      try {
        if (statSync(src).size <= statSync(dst).size) continue;
      } catch { continue; }
    }
    try { renameSync(src, dst); moved++; } catch { /* skip locked files */ }
  }
  try { rmdirSync(from); } catch { /* not empty — leave it, it's harmless */ }
  return moved;
}

/**
 * Reconcile the transcript directory for this host.
 *
 * @param {object}  opts
 * @param {string}  opts.projectsDir   <claude-home>/projects
 * @param {string}  opts.currentName   encoded cwd this machine will use
 * @param {string}  opts.manifestFile  where to remember the name
 * @returns {{action: string, from?: string, to: string, moved?: number}}
 */
export function reconcileTranscripts({ projectsDir, currentName, manifestFile }) {
  const current = path.join(projectsDir, currentName);
  const manifest = readManifest(manifestFile);
  const previousName = manifest.lastProjectDir;

  const remember = (action, extra = {}) => {
    writeManifest(manifestFile, { ...manifest, lastProjectDir: currentName });
    return { action, to: currentName, ...extra };
  };

  // Nothing has ever run, or the drive was provisioned fresh.
  if (!existsSync(projectsDir)) {
    mkdirSync(current, { recursive: true });
    return remember("created");
  }

  // Same machine as last time — nothing to do.
  if (previousName === currentName && existsSync(current)) return remember("unchanged");

  // Find the directory holding the history. Prefer what the manifest recorded;
  // if that's missing (manifest lost, or the drive was used before this feature
  // existed) fall back to the most recently modified project directory.
  let source = null;
  if (previousName && existsSync(path.join(projectsDir, previousName))) {
    source = previousName;
  } else {
    const candidates = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== currentName)
      .map((d) => {
        const full = path.join(projectsDir, d.name);
        let mtime = 0, count = 0;
        try {
          mtime = statSync(full).mtimeMs;
          count = readdirSync(full).filter((f) => f.endsWith(".jsonl")).length;
        } catch { /* unreadable */ }
        return { name: d.name, mtime, count };
      })
      .filter((c) => c.count > 0)            // only dirs that hold real transcripts
      .sort((a, b) => b.mtime - a.mtime);
    source = candidates[0]?.name ?? null;
  }

  if (!source) {
    mkdirSync(current, { recursive: true });
    return remember("created");
  }

  const from = path.join(projectsDir, source);

  if (existsSync(current)) {
    const moved = mergeInto(from, current);
    return remember("merged", { from: source, moved });
  }

  try {
    renameSync(from, current);
    return remember("renamed", { from: source });
  } catch {
    // Cross-device or locked: fall back to a merge, which copies file by file.
    const moved = mergeInto(from, current);
    return remember("merged", { from: source, moved });
  }
}
