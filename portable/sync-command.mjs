/**
 * portable/sync-command.mjs — the "Sync drive" menu action and `claudbot sync`.
 *
 * Unlocks the drive, merges it with this desktop install in both directions,
 * then re-locks. The merge itself lives in sync.mjs; this file is the plumbing
 * and the human-facing part: showing the plan, asking before touching anything,
 * and making sure the drive gets re-encrypted no matter how we leave.
 */

import { existsSync, readFileSync, statSync, cpSync } from "node:fs";
import path from "node:path";

import { vaultPath, claudeHome, appDir } from "./paths.mjs";
import { resolveDrive } from "./discover.mjs";
import { unlock, lock, shred } from "./store.mjs";
import * as vc from "./veracrypt.mjs";
import { askHidden, askYesNo } from "./prompt.mjs";
import {
  scanFiles, planSync, applySync, readBaseline, writeBaseline, conflictTag,
} from "./sync.mjs";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

/**
 * What gets synced.
 *
 * `filter` exists because the desktop's ~/.claude/projects holds transcripts for
 * every repo you've ever opened with Claude Code — TradeAlgo, MUN, everything.
 * Only Claudbot's own history belongs on the drive.
 */
const SETS = [
  {
    name: "vault",
    localRoot: () => vaultPath(),
    driveRel: "vault",
    filter: null,
  },
  {
    name: "transcripts",
    localRoot: () => path.join(claudeHome(), "projects"),
    driveRel: "claude-home/projects",
    filter: (rel) => /claudbot/i.test(rel.split("/")[0] ?? ""),
  },
];

const applyFilter = (map, filter) => {
  if (!filter) return map;
  const out = new Map();
  for (const [rel, meta] of map) if (filter(rel)) out.set(rel, meta);
  return out;
};

/** Open the drive. Returns { work, relock } like boot.mjs does. */
async function openDrive(root, manifest) {
  if (manifest.mode === "veracrypt") {
    const status = vc.probe();
    if (!status.usable) throw new Error(`Can't open this drive here — ${status.reason}`);
    const pass = await askHidden("  Drive passphrase: ");
    const at = vc.mount(path.join(root, "vault.hc"), pass);
    return { work: at, relock: () => vc.dismount(at) };
  }

  const storeFile = path.join(root, "store.enc");
  if (!existsSync(storeFile)) throw new Error(`No store.enc on ${root}.`);
  const pass = await askHidden("  Drive passphrase: ");
  const work = path.join(root, "work");
  const n = unlock(storeFile, work, pass);
  console.log(`  ${C.green}✓${C.reset} unlocked ${n} file(s)`);
  return {
    work,
    relock: () => { lock(work, storeFile, pass); shred(work); },
  };
}

/** Render a plan compactly — the first few paths, then a count. */
function describe(plan, setName) {
  const lines = [];
  const show = (label, items, colour) => {
    if (items.length === 0) return;
    lines.push(`    ${colour}${label}${C.reset} ${items.length}`);
    for (const it of items.slice(0, 5)) {
      lines.push(`      ${C.dim}${it.rel}${it.reason ? ` — ${it.reason}` : ""}${C.reset}`);
    }
    if (items.length > 5) lines.push(`      ${C.dim}…and ${items.length - 5} more${C.reset}`);
  };
  show("→ to drive", plan.toDrive, C.cyan);
  show("← to desktop", plan.toLocal, C.cyan);
  if (plan.conflicts.length) {
    lines.push(`    ${C.yellow}! conflicts${C.reset} ${plan.conflicts.length} ${C.dim}(both sides changed — nothing will be lost)${C.reset}`);
    for (const c of plan.conflicts.slice(0, 5)) {
      lines.push(`      ${C.dim}${c.rel} — keeping ${c.winner}, other saved as ${path.posix.basename(c.sidecar)}${C.reset}`);
    }
    if (plan.conflicts.length > 5) lines.push(`      ${C.dim}…and ${plan.conflicts.length - 5} more${C.reset}`);
  }
  if (lines.length === 0) return `  ${C.dim}${setName}: already in sync (${plan.unchanged} file(s))${C.reset}`;
  return `  ${C.bold}${setName}${C.reset} ${C.dim}${plan.unchanged} unchanged${C.reset}\n${lines.join("\n")}`;
}

/**
 * Run a sync.
 * @param {object} opts
 * @param {string|null} opts.drive  explicit drive path (--drive)
 * @param {boolean} opts.yes        skip the confirmation
 * @returns {Promise<boolean>} true if it ran to completion
 */
export async function runSync({ drive = null, yes = false } = {}) {
  let found;
  try {
    found = resolveDrive(drive);
  } catch (err) {
    console.log(`\n${C.yellow}${err.message}${C.reset}\n`);
    return false;
  }

  const { root, manifest } = found;
  console.log(`\n${C.bold}Sync with drive${C.reset} ${C.dim}${root} · ${manifest.mode} mode${C.reset}\n`);

  let opened;
  try {
    opened = await openDrive(root, manifest);
  } catch (err) {
    console.log(`\n${C.red}${err.message}${C.reset}\n`);
    return false;
  }

  // Whatever happens from here, the drive must be re-encrypted.
  let relocked = false;
  const relock = () => {
    if (relocked) return;
    relocked = true;
    try {
      opened.relock();
      console.log(`\n${C.green}✓${C.reset} drive re-locked`);
    } catch (err) {
      console.log(`\n${C.red}⚠  Re-lock failed: ${err.message}${C.reset}`);
      console.log(`${C.yellow}   Decrypted data is still at ${opened.work}${C.reset}`);
    }
  };
  const onSignal = () => { relock(); process.exit(130); };
  process.once("SIGINT", onSignal);

  try {
    const baselineDoc = readBaseline(root);
    const tag = conflictTag();
    const plans = [];

    for (const set of SETS) {
      const localRoot = set.localRoot();
      const driveRoot = path.join(opened.work, ...set.driveRel.split("/"));
      const local = applyFilter(scanFiles(localRoot), set.filter);
      const onDrive = applyFilter(scanFiles(driveRoot), set.filter);
      const baseline = baselineDoc.sets?.[set.name] ?? {};
      const plan = planSync(local, onDrive, baseline, tag);
      plans.push({ set, localRoot, driveRoot, plan });
      console.log(describe(plan, set.name));
    }

    const work = plans.reduce(
      (n, p) => n + p.plan.toDrive.length + p.plan.toLocal.length + p.plan.conflicts.length, 0,
    );

    // .env is reported but never touched automatically — silently overwriting
    // API keys is a worse failure than telling you they differ.
    const localEnv = path.join(appDir(), ".env");
    const driveEnv = path.join(opened.work, ".env");
    if (existsSync(localEnv) && existsSync(driveEnv)) {
      const a = readFileSync(localEnv, "utf8");
      const b = readFileSync(driveEnv, "utf8");
      if (a !== b) {
        const newer = statSync(localEnv).mtimeMs >= statSync(driveEnv).mtimeMs ? "desktop" : "drive";
        console.log(`\n  ${C.yellow}.env differs${C.reset} ${C.dim}(${newer} is newer) — not synced automatically${C.reset}`);
        console.log(`  ${C.dim}Credentials are too easy to break silently. Copy by hand if you meant to change them.${C.reset}`);
      }
    }

    if (work === 0) {
      console.log(`\n${C.green}Everything already in sync.${C.reset}`);
      relock();
      return true;
    }

    if (!yes) {
      console.log("");
      const go = await askYesNo(`  Apply these ${work} change(s)?`, { defaultYes: true });
      if (!go) {
        console.log(`  ${C.dim}Nothing changed.${C.reset}`);
        relock();
        return false;
      }
    }

    const newSets = { ...(baselineDoc.sets ?? {}) };
    for (const { set, localRoot, driveRoot, plan } of plans) {
      const res = applySync(plan, localRoot, driveRoot);
      newSets[set.name] = res.baseline;
      const bits = [];
      if (res.copiedToDrive) bits.push(`${res.copiedToDrive} → drive`);
      if (res.copiedToLocal) bits.push(`${res.copiedToLocal} → desktop`);
      if (res.resolved) bits.push(`${res.resolved} conflict(s) kept both ways`);
      if (bits.length) console.log(`  ${C.green}✓${C.reset} ${set.name}: ${bits.join(", ")}`);
    }

    writeBaseline(root, {
      sets: newSets,
      lastSync: new Date().toISOString(),
      lastSyncHost: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "",
    });
    console.log(`  ${C.green}✓${C.reset} baseline recorded for next time`);

    const conflicts = plans.flatMap((p) => p.plan.conflicts);
    if (conflicts.length) {
      console.log(`\n${C.yellow}${conflicts.length} file(s) changed in both places.${C.reset}`);
      console.log(`${C.dim}Both versions were kept — look for .conflict-${tag} files and merge them by hand.${C.reset}`);
    }

    relock();
    return true;
  } catch (err) {
    console.log(`\n${C.red}Sync failed: ${err.message}${C.reset}`);
    relock();
    return false;
  } finally {
    process.removeListener("SIGINT", onSignal);
  }
}
