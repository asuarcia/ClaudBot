#!/usr/bin/env node
/**
 * portable/boot.mjs — what runs when you plug the drive in.
 *
 * Sequence:
 *   1. Work out which protection mode this drive uses (manifest.json).
 *   2. Deal with a work/ directory left behind by a session that crashed.
 *   3. Ask for the passphrase and unlock.
 *   4. Stitch the conversation history onto this host's directory name.
 *   5. Run Claudbot under the bundled Node, with CLAUDE_CONFIG_DIR on the drive.
 *   6. Re-lock and shred on the way out — including on Ctrl-C and on crash.
 *
 * Step 6 is the one that matters most and the easiest to get wrong, so the
 * cleanup is installed before anything is decrypted and is idempotent.
 */

import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import path from "node:path";
import { askHidden, askYesNo, feedPassphraseChar } from "./prompt.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DRIVE_ROOT, workDir, appDir, storeFile, containerFile, manifestFile,
  claudeHome, vaultPath, bundledNode,
} from "./paths.mjs";
import { lock, unlock, shred, staleUnlock } from "./store.mjs";
import * as vc from "./veracrypt.mjs";
import { reconcileTranscripts } from "./reconcile.mjs";

// Reaching this file at all means we are running from the drive, so assert
// portable mode for THIS process before any path is resolved. Setting it only
// on the child's env (further down) left appDir() here returning the drive root
// instead of <drive>/app — which made the spawn below point at a claudbot.mjs
// that does not exist, and filed transcripts under the wrong directory name.
process.env.CLAUDBOT_PORTABLE = "1";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

const say  = (s) => console.log(s);
const warn = (s) => console.log(`${C.yellow}${s}${C.reset}`);
const die  = (s) => { console.error(`${C.red}${s}${C.reset}`); process.exit(1); };

export { feedPassphraseChar };

// ─── manifest ────────────────────────────────────────────────────────────────

function readManifest() {
  try { return JSON.parse(readFileSync(manifestFile(), "utf8")); }
  catch { return { mode: "store" }; }
}
function writeManifest(data) {
  mkdirSync(path.dirname(manifestFile()), { recursive: true });
  writeFileSync(manifestFile(), JSON.stringify(data, null, 2));
}

// ─── unlock / relock, one interface over both modes ──────────────────────────

/**
 * Both modes end with plaintext readable at workDir(). In store mode we decrypt
 * into it; in VeraCrypt mode we mount the container and use it directly, so
 * CLAUDBOT_WORK is pointed at the mount instead.
 */
async function unlockDrive(manifest, passphrase) {
  if (manifest.mode === "veracrypt") {
    const status = vc.probe();
    if (!status.usable) {
      die(
        `\nThis drive is in VeraCrypt mode, but it can't be opened here.\n` +
        `  ${status.reason}\n\n` +
        `VeraCrypt containers can only be converted on a machine that can mount them.\n` +
        `Plug into a machine with VeraCrypt and admin rights and run:\n` +
        `  ${C.cyan}node portable/boot.mjs --convert store${C.reset}\n` +
        `after which this drive will open anywhere, no admin needed.\n`,
      );
    }
    const at = vc.mount(containerFile(), passphrase);
    say(`${C.green}✓${C.reset} container mounted at ${at}`);
    return { work: at, relock: () => vc.dismount(at) };
  }

  if (!existsSync(storeFile())) {
    die(`No store found at ${storeFile()}. Was this drive provisioned with make-portable?`);
  }
  const n = unlock(storeFile(), workDir(), passphrase);
  say(`${C.green}✓${C.reset} unlocked ${n} file(s)`);
  return {
    work: workDir(),
    relock: () => {
      lock(workDir(), storeFile(), passphrase);
      shred(workDir());
    },
  };
}

// ─── stale plaintext from a previous crash ───────────────────────────────────

async function handleStale(manifest) {
  if (manifest.mode === "veracrypt") return;      // the driver cleans up on reboot
  const stale = staleUnlock(workDir());
  if (!stale) return;

  warn(
    `\n⚠  The last session didn't shut down cleanly.\n` +
    `   Decrypted data is still sitting at ${workDir()}` +
    (stale.at ? `\n   (unlocked ${stale.at}${stale.host ? ` on ${stale.host}` : ""})` : ""),
  );
  say(
    `\n   To keep any work from that session, re-lock it into the store.\n` +
    `   Discarding it loses anything changed after the last clean exit.\n`,
  );
  const keep = await askYesNo("   Re-lock and keep that data?");
  if (!keep) {
    shred(workDir());
    say(`${C.green}✓${C.reset} stale data shredded`);
    return;
  }
  try {
    const pass = await askHidden("   Passphrase to re-lock it: ");
    lock(workDir(), storeFile(), pass);
    shred(workDir());
    say(`${C.green}✓${C.reset} recovered and re-locked`);
  } catch (err) {
    die(`   Could not re-lock: ${err.message}\n   Leaving the data in place — nothing was destroyed.`);
  }
}

// ─── mode conversion ─────────────────────────────────────────────────────────

async function convert(target) {
  const manifest = readManifest();
  if (manifest.mode === target) { say(`Already in ${target} mode.`); return; }

  const passphrase = await askHidden("Current passphrase: ");
  const opened = await unlockDrive(manifest, passphrase);

  if (target === "store") {
    // Copy the mounted plaintext into work/, then encrypt it.
    if (opened.work !== workDir()) {
      const { cpSync } = await import("node:fs");
      rmSync(workDir(), { recursive: true, force: true });
      cpSync(opened.work, workDir(), { recursive: true });
    }
    lock(workDir(), storeFile(), passphrase);
    shred(workDir());
    opened.relock();
    writeManifest({ ...manifest, mode: "store" });
    say(`${C.green}✓${C.reset} converted to store mode — this drive now opens without admin rights.`);
    say(`${C.dim}  You can delete ${containerFile()} once you've confirmed it works.${C.reset}`);
    return;
  }

  die(
    `Converting to VeraCrypt mode isn't automated: creating a container needs\n` +
    `VeraCrypt's own volume creation wizard, which can't be driven safely from\n` +
    `a script. Create the container yourself, copy the contents of\n` +
    `  ${workDir()}\n` +
    `into it, then set "mode": "veracrypt" in ${manifestFile()}.`,
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "--convert") {
    const target = argv[1];
    if (target !== "store" && target !== "veracrypt") {
      die("Usage: boot.mjs --convert <store|veracrypt>");
    }
    await convert(target);
    return;
  }

  const manifest = readManifest();
  say(`\n${C.bold}Claudbot portable${C.reset} ${C.dim}· ${DRIVE_ROOT} · ${manifest.mode} mode${C.reset}\n`);

  await handleStale(manifest);

  let passphrase;
  try { passphrase = await askHidden(); }
  catch { say("\nCancelled."); process.exit(0); }

  let opened;
  try { opened = await unlockDrive(manifest, passphrase); }
  catch (err) { die(`\n${err.message}`); }

  // Cleanup must be installed before we go any further, and must run exactly
  // once no matter which way we leave (normal exit, Ctrl-C, uncaught throw).
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      opened.relock();
      say(`\n${C.green}✓${C.reset} drive re-locked`);
    } catch (err) {
      warn(`\n⚠  Re-lock failed: ${err.message}`);
      warn(`   Decrypted data is still at ${opened.work} — re-run to recover it.`);
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("uncaughtException", (err) => {
    console.error(err);
    cleanup();
    process.exit(1);
  });

  // Point everything at the drive, then stitch history onto this host's name.
  const env = {
    ...process.env,
    CLAUDBOT_PORTABLE: "1",
    CLAUDBOT_WORK: opened.work,
    CLAUDBOT_VAULT: path.join(opened.work, "vault"),
    CLAUDE_CONFIG_DIR: path.join(opened.work, "claude-home"),
  };

  const appCwd = path.join(appDir(), ".claudbot");
  const encoded = path.resolve(appCwd).replace(/[^a-zA-Z0-9]/g, "-");
  const result = reconcileTranscripts({
    projectsDir: path.join(env.CLAUDE_CONFIG_DIR, "projects"),
    currentName: encoded,
    manifestFile: manifestFile(),
  });
  if (result.action === "renamed") {
    say(`${C.green}✓${C.reset} history carried over from ${C.dim}${result.from}${C.reset}`);
  } else if (result.action === "merged") {
    say(`${C.green}✓${C.reset} history merged (${result.moved} transcript(s) from ${C.dim}${result.from}${C.reset})`);
  }

  const node = bundledNode() ?? process.execPath;
  say(`${C.dim}Starting Claudbot…${C.reset}\n`);

  const child = spawn(node, [path.join(appDir(), "claudbot.mjs"), ...argv], {
    cwd: appDir(),
    stdio: "inherit",
    env,
  });
  child.on("exit", (code) => { cleanup(); process.exit(code ?? 0); });
}

// Only run when executed directly — importing this module (e.g. from the
// portable checks) must not launch anything.
const isEntry = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntry) main().catch((err) => die(err.stack ?? err.message));
