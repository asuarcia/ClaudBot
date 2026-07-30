/**
 * portable/sync.mjs — reconcile the desktop install with the USB drive.
 *
 * Both sides are real, independent copies: work at your desk and the drive goes
 * stale, work from the drive and your desktop knows nothing about it. This
 * merges them in both directions.
 *
 * A two-way comparison is not enough. If a file differs between desktop and
 * drive, "which is newer" cannot tell you whether one side changed or both did —
 * and picking the newer one silently destroys the other edit. So each sync
 * records a BASELINE (a hash per file, as of that sync), and the next sync does
 * a three-way compare against it:
 *
 *   changed on one side only   -> copy it across
 *   changed on both, same hash -> nothing to do
 *   changed on both, differ    -> CONFLICT, keep both
 *
 * Two deliberate rules, both chosen to make data loss impossible:
 *
 *   1. Sync NEVER deletes. A file missing on one side is treated as new on the
 *      other and copied across. Propagating deletions would mean a stray rm
 *      could wipe your second brain from both places at once. If you want
 *      something gone, delete it in both — that's the trade for safety.
 *
 *   2. Conflicts never overwrite. The newer version stays in place and the
 *      older is written alongside it as `name.conflict-<host>-<date>.ext`, so
 *      you resolve it by reading both rather than discovering a loss later.
 *
 * Transcripts (*.jsonl) are the one special case: they're append-only, so the
 * longer file is strictly the more complete one and can be taken without a
 * conflict.
 */

import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

/** Directories we sync, relative to each side's root. */
export const SYNC_SETS = [
  { name: "vault",       local: null, drive: "vault" },        // local resolved at runtime
  { name: "transcripts", local: null, drive: "claude-home/projects" },
];

// ─── scanning ────────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Map every file under `root` to its size, mtime and content hash.
 * Returns an empty Map if the root doesn't exist, so a missing side is simply
 * "has nothing" rather than an error.
 */
export function scanFiles(root) {
  const out = new Map();
  if (!root || !existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip VCS and editor noise — syncing .git would be both huge and wrong.
      if (entry.name === ".git" || entry.name === ".obsidian") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      try {
        const st = statSync(full);
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, hash: sha256(readFileSync(full)) });
      } catch { /* unreadable, skip */ }
    }
  };
  walk(root);
  return out;
}

// ─── planning ────────────────────────────────────────────────────────────────

const isTranscript = (rel) => rel.endsWith(".jsonl");

/** `notes/a.md` + tag -> `notes/a.conflict-<tag>.md` */
export function conflictName(rel, tag) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const name = `${stem}.conflict-${tag}${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

/**
 * Decide what to do for every path across both sides.
 *
 * @param {Map} local     from scanFiles(desktop root)
 * @param {Map} drive     from scanFiles(drive root)
 * @param {object} baseline  { [rel]: hash } recorded at the last sync
 * @param {string} tag    suffix for conflict copies, e.g. "desktop-2026-07-29"
 * @returns {{toDrive: array, toLocal: array, conflicts: array, unchanged: number}}
 */
export function planSync(local, drive, baseline = {}, tag = "conflict") {
  const toDrive = [];
  const toLocal = [];
  const conflicts = [];
  let unchanged = 0;

  for (const rel of new Set([...local.keys(), ...drive.keys()])) {
    const l = local.get(rel);
    const d = drive.get(rel);
    const b = baseline[rel];

    // Present on one side only. Never a delete — always a copy across.
    if (l && !d) { toDrive.push({ rel, reason: b ? "missing on drive" : "new locally" }); continue; }
    if (!l && d) { toLocal.push({ rel, reason: b ? "missing locally" : "new on drive" }); continue; }

    if (l.hash === d.hash) { unchanged++; continue; }

    // Append-only transcripts: the longer file contains the shorter one.
    if (isTranscript(rel)) {
      if (l.size >= d.size) toDrive.push({ rel, reason: "longer transcript" });
      else toLocal.push({ rel, reason: "longer transcript" });
      continue;
    }

    const localChanged = !b || l.hash !== b;
    const driveChanged = !b || d.hash !== b;

    if (localChanged && !driveChanged) { toDrive.push({ rel, reason: "changed locally" }); continue; }
    if (driveChanged && !localChanged) { toLocal.push({ rel, reason: "changed on drive" }); continue; }

    // Both sides moved. Keep the newer in place, park the older beside it.
    const localWins = l.mtimeMs >= d.mtimeMs;
    conflicts.push({
      rel,
      winner: localWins ? "local" : "drive",
      // The losing copy is written on the winner's side under this name, so the
      // conflict is visible wherever you happen to be working.
      sidecar: conflictName(rel, tag),
      localMtime: l.mtimeMs,
      driveMtime: d.mtimeMs,
    });
  }

  const byRel = (a, b) => a.rel.localeCompare(b.rel);
  return {
    toDrive: toDrive.sort(byRel),
    toLocal: toLocal.sort(byRel),
    conflicts: conflicts.sort(byRel),
    unchanged,
  };
}

// ─── applying ────────────────────────────────────────────────────────────────

function copyFile(fromRoot, toRoot, rel) {
  const src = path.join(fromRoot, ...rel.split("/"));
  const dst = path.join(toRoot, ...rel.split("/"));
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst);
}

/**
 * Carry out a plan. Returns counts plus the baseline to record for next time.
 * The baseline is computed from the POST-sync state, so both sides agree.
 */
export function applySync(plan, localRoot, driveRoot) {
  let copiedToDrive = 0, copiedToLocal = 0, resolved = 0;

  for (const { rel } of plan.toDrive) { copyFile(localRoot, driveRoot, rel); copiedToDrive++; }
  for (const { rel } of plan.toLocal) { copyFile(driveRoot, localRoot, rel); copiedToLocal++; }

  for (const c of plan.conflicts) {
    const winnerRoot = c.winner === "local" ? localRoot : driveRoot;
    const loserRoot  = c.winner === "local" ? driveRoot : localRoot;

    // Park the losing version next to the winner, then make both sides match.
    const loserSrc = path.join(loserRoot, ...c.rel.split("/"));
    const sidecarDst = path.join(winnerRoot, ...c.sidecar.split("/"));
    mkdirSync(path.dirname(sidecarDst), { recursive: true });
    cpSync(loserSrc, sidecarDst);

    // Winner overwrites the loser's copy, and the sidecar goes across too, so
    // whichever side you next open shows both versions.
    copyFile(winnerRoot, loserRoot, c.rel);
    copyFile(winnerRoot, loserRoot, c.sidecar);
    resolved++;
  }

  // Recompute from disk rather than predicting — if a copy silently failed, the
  // baseline must reflect reality or the next sync will paper over it.
  const after = scanFiles(localRoot);
  const baseline = {};
  for (const [rel, meta] of after) baseline[rel] = meta.hash;

  return { copiedToDrive, copiedToLocal, resolved, baseline };
}

// ─── baseline persistence ────────────────────────────────────────────────────

/**
 * The baseline lives on the DRIVE, not the desktop. The drive is the thing that
 * travels between machines, so it is the only place that can hold a baseline
 * shared by every desktop it visits.
 */
export function baselineFile(driveRoot) {
  return path.join(driveRoot, "portable", "sync-baseline.json");
}

export function readBaseline(driveRoot) {
  try { return JSON.parse(readFileSync(baselineFile(driveRoot), "utf8")); }
  catch { return { sets: {} }; }
}

export function writeBaseline(driveRoot, data) {
  const file = baselineFile(driveRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** A short, filesystem-safe tag for naming conflict copies. */
export function conflictTag(when = new Date()) {
  const host = (os.hostname() || "host").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return `${host}-${when.toISOString().slice(0, 10)}`;
}
