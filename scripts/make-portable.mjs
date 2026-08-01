#!/usr/bin/env node
/**
 * scripts/make-portable.mjs — build the USB drive from this install.
 *
 *   npm run make-portable -- --target E:\            build a drive
 *   npm run make-portable -- --target E:\ --refresh  update code only, keep data
 *   npm run make-portable -- --target E:\ --skip-runtimes
 *
 * What lands on the drive:
 *   Claudbot.cmd / claudbot.sh / claudbot.command   launchers (plaintext)
 *   README-FIRST.txt                                what to do if you find this
 *   runtime/<platform>/                             bundled Node per platform
 *   runtime/claude-code/                            the Claude Code CLI
 *   app/                                            Claudbot source
 *   portable/                                       boot, store, veracrypt, paths
 *   store.enc                                       everything personal, encrypted
 *
 * What is deliberately NOT copied: voice/.venv and voice/models (762 MB of
 * shelved subsystem), .git, and the host's node_modules build artefacts.
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { lock, shred } from "../portable/store.mjs";
import { askNewPassphrase } from "../portable/prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const step = (s) => console.log(`\n${C.bold}${s}${C.reset}`);
const info = (s) => console.log(`  ${C.dim}${s}${C.reset}`);
const good = (s) => console.log(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => console.log(`  ${C.yellow}⚠${C.reset}  ${s}`);
const die  = (s) => { console.error(`\n${C.red}${s}${C.reset}\n`); process.exit(1); };

const NODE_VERSION = "v22.23.2";        // current v22 LTS
const PLATFORMS = [
  { key: "win-x64",      archive: `node-${NODE_VERSION}-win-x64.zip`,        strip: `node-${NODE_VERSION}-win-x64` },
  { key: "darwin-arm64", archive: `node-${NODE_VERSION}-darwin-arm64.tar.xz`, strip: `node-${NODE_VERSION}-darwin-arm64` },
  { key: "darwin-x64",   archive: `node-${NODE_VERSION}-darwin-x64.tar.xz`,   strip: `node-${NODE_VERSION}-darwin-x64` },
  { key: "linux-x64",    archive: `node-${NODE_VERSION}-linux-x64.tar.xz`,    strip: `node-${NODE_VERSION}-linux-x64` },
];

// Source files that must never reach the drive.
const EXCLUDE = new Set([
  ".git", "node_modules", ".env", "work", "store.enc", "vault.hc",
  "portable", "scripts",
]);
// Inside voice/, these are the shelved 762 MB.
const VOICE_EXCLUDE = new Set([".venv", "models", "__pycache__"]);

// ─── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { target: null, mode: "store", skipRuntimes: false, refresh: false, includeVoice: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--skip-runtimes") out.skipRuntimes = true;
    else if (a === "--refresh") out.refresh = true;
    else if (a === "--include-voice") out.includeVoice = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else die(`Unknown option: ${a}`);
  }
  return out;
}

function usage() {
  console.log(`
  ${C.bold}make-portable${C.reset} — build a Claudbot USB drive

    --target <path>      where to build (e.g. E:\\ or /Volumes/CLAUDBOT)   ${C.dim}required${C.reset}
    --mode <m>           store (default, no admin needed) | veracrypt
    --refresh            update code and runtimes, leave store.enc alone
    --skip-runtimes      don't download Node (drive will need host Node)
    --include-voice      include the shelved voice venv + models (+762 MB)
    -h, --help           this message
`);
}

// ─── passphrase ─────────────────────────────────────────────────────────────

async function newPassphrase() {
  // Escape hatch for scripted rebuilds and for the portable checks. Passing a
  // passphrase through the environment means it can appear in shell history and
  // in the process environment, so it is not the path a human should use — the
  // interactive prompt never puts it anywhere but memory.
  if (process.env.CLAUDBOT_PASSPHRASE) {
    warn("using CLAUDBOT_PASSPHRASE from the environment (less private than typing it)");
    return process.env.CLAUDBOT_PASSPHRASE;
  }
  return askNewPassphrase({ warn });
}

// ─── copy the app ────────────────────────────────────────────────────────────

function copyApp(target, includeVoice) {
  const appDir = path.join(target, "app");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  let files = 0;
  const copy = (srcDir, dstDir, depth = 0) => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const name = entry.name;
      if (depth === 0 && EXCLUDE.has(name)) continue;
      const src = path.join(srcDir, name);
      const dst = path.join(dstDir, name);

      // Trim the shelved voice payload but keep the code, so `claudbot voice`
      // still exists on the drive — it just needs `voice setup` to run again.
      if (!includeVoice && path.basename(srcDir) === "voice" && VOICE_EXCLUDE.has(name)) continue;
      if (name === "node_modules" && depth > 0) {
        // MCP servers ship their own deps and they're tiny — keep those.
        cpSync(src, dst, { recursive: true });
        continue;
      }
      if (entry.isDirectory()) {
        mkdirSync(dst, { recursive: true });
        copy(src, dst, depth + 1);
      } else if (entry.isFile()) {
        cpSync(src, dst);
        files++;
      }
    }
  };
  copy(ROOT, appDir);

  // node_modules is excluded at depth 0 above but the app genuinely needs it,
  // and it has no native modules (verified), so a straight copy is portable.
  cpSync(path.join(ROOT, "node_modules"), path.join(appDir, "node_modules"), { recursive: true });

  // claudbot.mjs and friends import "./portable/paths.mjs" relative to
  // themselves, but portable/ is excluded above because the real machinery
  // belongs at the drive root — and it must stay the only copy: paths.mjs
  // derives DRIVE_ROOT from its own location, so a second copy under app/
  // would resolve DRIVE_ROOT to <drive>/app and send claudeBin(), workDir()
  // and storeFile() to directories that do not exist. Without any copy the
  // drive died at startup with ERR_MODULE_NOT_FOUND, so ship a re-export
  // shim: the import resolves, and there is still exactly one paths.mjs.
  const shim = path.join(appDir, "portable");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "paths.mjs"),
    "// Generated by scripts/make-portable.mjs — do not edit.\n" +
    "// The real module is at <drive>/portable/paths.mjs; it must load from\n" +
    "// there so DRIVE_ROOT resolves to the drive root and not to app/.\n" +
    "export * from \"../../portable/paths.mjs\";\n");

  return files;
}

// ─── runtimes ────────────────────────────────────────────────────────────────

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

/**
 * Pick a tar that can cope with Windows paths.
 *
 * GNU tar — which is what Git for Windows puts on PATH — parses `C:\dir` as the
 * rsh-style remote spec `host:path` and fails with "Cannot connect to C".
 * Windows 10+ ships bsdtar at System32\tar.exe, which handles drive letters and
 * reads both .zip and .tar.xz (libarchive links liblzma). Prefer it; otherwise
 * fall back to GNU tar with --force-local, which disables the remote parsing.
 */
function tarCommand() {
  if (process.platform !== "win32") return { cmd: "tar", extra: [] };
  const bsd = "C:\\Windows\\System32\\tar.exe";
  if (existsSync(bsd)) return { cmd: bsd, extra: [] };
  return { cmd: "tar", extra: ["--force-local"] };
}

/**
 * Extract `archive` into `into`, optionally only a single member.
 *
 * Deliberately does NOT treat a non-zero exit as failure. The Linux and macOS
 * tarballs contain symlinks (bin/npm, bin/npx, bin/corepack) which Windows
 * cannot create without Developer Mode or admin, so tar reports "Error exit
 * delayed from previous errors" even though every real file landed. The caller
 * decides success by checking for the binary it actually needs.
 */
function extract(archive, into, { member } = {}) {
  mkdirSync(into, { recursive: true });
  const { cmd, extra } = tarCommand();
  const args = [...extra, "-xf", archive, "-C", into];
  if (member) args.push(member);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stderr || r.stdout || "").trim();
}

async function fetchRuntimes(target) {
  const runtimeDir = path.join(target, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `claudbot-node-${process.pid}`);
  mkdirSync(tmp, { recursive: true });

  const failed = [];
  for (const p of PLATFORMS) {
    const outDir = path.join(runtimeDir, p.key);
    if (existsSync(outDir)) { info(`${p.key} already present, skipping`); continue; }
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${p.archive}`;
    const archivePath = path.join(tmp, p.archive);
    try {
      process.stdout.write(`  ${C.dim}downloading ${p.key}…${C.reset}`);
      const bytes = await download(url, archivePath);

      // For Unix platforms pull out only bin/node. npm, npx, corepack, the
      // headers and lib/node_modules are all dead weight here — we only ever
      // run JS files with this binary — and skipping them avoids the symlinks
      // Windows can't create while saving ~75 MB per platform.
      const member = p.key === "win-x64" ? null : `${p.strip}/bin/node`;
      const tarSays = extract(archivePath, tmp, { member });

      const staged = path.join(tmp, p.strip);
      const binary = p.key === "win-x64"
        ? path.join(staged, "node.exe")
        : path.join(staged, "bin", "node");
      if (!existsSync(binary)) {
        throw new Error(tarSays || `no node binary in ${p.archive}`);
      }

      // Copy rather than rename: the staging dir lives in the OS temp dir (on
      // the system drive) and the target is the USB stick, so renameSync always
      // fails with EXDEV. That silently cost every drive its bundled runtimes.
      cpSync(staged, outDir, { recursive: true });
      rmSync(staged, { recursive: true, force: true });
      if (p.key !== "win-x64") {
        try { chmodSync(path.join(outDir, "bin", "node"), 0o755); } catch { /* FAT32 has no exec bit */ }
      }
      const onDisk = dirSize(outDir);
      process.stdout.write(
        `\r  ${C.green}✓${C.reset} ${p.key} ${C.dim}(${(bytes / 1e6).toFixed(0)} MB down, ${(onDisk / 1e6).toFixed(0)} MB on drive)${C.reset}      \n`,
      );
    } catch (err) {
      process.stdout.write("\r");
      warn(`${p.key} failed: ${err.message}`);
      failed.push(p.key);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return failed;
}

/** Install the Claude Code CLI onto the drive so the host needs nothing. */
function fetchClaudeCode(target) {
  const dir = path.join(target, "runtime", "claude-code");
  if (existsSync(path.join(dir, "node_modules", "@anthropic-ai"))) {
    info("claude-code already present, skipping");
    return true;
  }
  // Install into the system temp dir, never straight onto the drive. Portable
  // drives are formatted exFAT (the only filesystem Windows, macOS and Linux
  // all write), and exFAT has no hardlinks — but the claude-code postinstall
  // places its binary with link(), which then dies with EISDIR/EPERM and
  // leaves an empty runtime/claude-code behind. Staging on the system drive
  // lets the postinstall link freely; the finished tree copies over fine,
  // because copying turns those links into ordinary files.
  const stage = path.join(os.tmpdir(), `claudbot-claude-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "package.json"), JSON.stringify({
    name: "claudbot-portable-claude", private: true, version: "1.0.0",
  }, null, 2));
  // Invoke npm's JS entry point with this same Node binary rather than the npm
  // launcher. On Windows the launcher is npm.cmd, and Node >=22 refuses to
  // spawnSync a .cmd without shell:true (CVE-2024-27980) — which is why the
  // previous "npm.cmd, no shell" approach failed with EINVAL. Running
  // npm-cli.js directly needs no shell (so no quoting hazard) and is portable.
  const npmCli = path.join(path.dirname(process.execPath),
    "node_modules", "npm", "bin", "npm-cli.js");
  const useCli = existsSync(npmCli);
  const cmd = useCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = (useCli ? [npmCli] : []).concat(
    ["install", "@anthropic-ai/claude-code", "--no-audit", "--no-fund"]);
  const r = spawnSync(cmd, args, {
    cwd: stage, encoding: "utf8", stdio: "pipe",
    shell: !useCli && process.platform === "win32",
  });
  if (r.status !== 0) {
    // r.error is set when the process could not be spawned at all (npm not on
    // PATH, for instance). Without it the warning prints an empty reason and
    // the real failure is invisible.
    const why = r.error
      ? `${r.error.code ?? ""} ${r.error.message}`.trim()
      : (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")
        || `npm exited ${r.status}`;
    warn(`could not install Claude Code: ${why}`);
    rmSync(stage, { recursive: true, force: true });
    return false;
  }
  // npm can exit 0 with the postinstall having only warned, so confirm the
  // package really landed before declaring the drive self-sufficient.
  if (!existsSync(path.join(stage, "node_modules", "@anthropic-ai"))) {
    warn("npm reported success but @anthropic-ai is missing from the install");
    rmSync(stage, { recursive: true, force: true });
    return false;
  }
  mkdirSync(dir, { recursive: true });
  cpSync(stage, dir, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  return true;
}

// ─── assemble the personal data ──────────────────────────────────────────────

function assembleWork(target) {
  const work = path.join(target, ".staging");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const report = [];

  // .env — API keys
  const envSrc = path.join(ROOT, ".env");
  if (existsSync(envSrc)) { cpSync(envSrc, path.join(work, ".env")); report.push(".env"); }
  else warn("no .env found — the drive will have no API keys");

  // The Obsidian vault
  const vaultSrc = process.env.CLAUDBOT_VAULT
    ?? (process.platform === "win32" ? "C:\\Repo\\MyBrain" : path.join(os.homedir(), "MyBrain"));
  if (existsSync(vaultSrc)) {
    cpSync(vaultSrc, path.join(work, "vault"), { recursive: true });
    report.push(`vault (${vaultSrc})`);
  } else warn(`vault not found at ${vaultSrc}`);

  // Claude Code state: auth + every transcript.
  const claudeSrc = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const claudeDst = path.join(work, "claude-home");
  if (existsSync(claudeSrc)) {
    mkdirSync(claudeDst, { recursive: true });
    // Only what's needed: credentials, settings, and this project's transcripts.
    for (const name of [".credentials.json", "settings.json", "CLAUDE.md"]) {
      const f = path.join(claudeSrc, name);
      if (existsSync(f)) cpSync(f, path.join(claudeDst, name));
    }
    const projSrc = path.join(claudeSrc, "projects");
    if (existsSync(projSrc)) {
      const projDst = path.join(claudeDst, "projects");
      mkdirSync(projDst, { recursive: true });
      let moved = 0;
      for (const d of readdirSync(projSrc, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (!/claudbot/i.test(d.name)) continue;      // only Claudbot's own history
        cpSync(path.join(projSrc, d.name), path.join(projDst, d.name), { recursive: true });
        moved++;
      }
      if (moved) report.push(`${moved} transcript director${moved === 1 ? "y" : "ies"}`);
    }
    const rootConfig = path.join(path.dirname(claudeSrc), ".claude.json");
    if (existsSync(rootConfig)) cpSync(rootConfig, path.join(claudeDst, ".claude.json"));
  } else warn(`Claude config not found at ${claudeSrc}`);

  return { work, report };
}

// ─── static files ────────────────────────────────────────────────────────────

/**
 * Copy a single file onto the drive, replacing whatever is there.
 *
 * cpSync over an existing file on exFAT does not throw — it aborts the whole
 * process with exit 127 and no error at all, so a --refresh died silently at
 * the launcher step and left the manifest, README and launchers stale. Only
 * the destination existing triggers it; unlinking first is enough.
 */
function copyOnto(src, dst) {
  rmSync(dst, { force: true });
  cpSync(src, dst);
}

function writeLaunchers(target) {
  const src = path.join(ROOT, "portable", "launchers");
  copyOnto(path.join(src, "Claudbot.cmd"), path.join(target, "Claudbot.cmd"));
  const sh = readFileSync(path.join(src, "claudbot.sh"), "utf8");
  for (const name of ["claudbot.sh", "claudbot.command"]) {
    const dst = path.join(target, name);
    writeFileSync(dst, sh);
    try { chmodSync(dst, 0o755); } catch { /* FAT32 has no exec bit */ }
  }
}

function writeReadme(target, mode) {
  writeFileSync(path.join(target, "README-FIRST.txt"), `CLAUDBOT — PORTABLE DRIVE
=========================

This drive carries a personal AI assistant along with its owner's private
notes, conversation history and credentials. All of that is ENCRYPTED and
useless without the passphrase.

If you found this drive and it isn't yours, there is nothing usable here.
Please return it to its owner.

-- HOW TO START ------------------------------------------------------------

  Windows        double-click  Claudbot.cmd
  macOS          double-click  claudbot.command
                 (or in Terminal:  ./claudbot.sh)
  Linux          ./claudbot.sh

You'll be asked for the passphrase. Nothing is written to the host computer:
the assistant's config, auth and history all live on this drive.

-- IMPORTANT ---------------------------------------------------------------

  * ALWAYS exit Claudbot normally (the Exit menu item, or Ctrl-C) before
    unplugging. That re-encrypts your data. Yanking the drive mid-session
    leaves it decrypted on the stick until the next launch cleans it up.

  * Keep a backup. This is a USB stick; they fail and they get lost. The
    passphrase cannot be recovered — if you forget it, the data is gone.

-- PROTECTION MODE ---------------------------------------------------------

  This drive is in "${mode}" mode.

  store      AES-256-GCM, unlocked by the bundled Node. Needs no admin
             rights and no installed software, so it works anywhere.

  veracrypt  A VeraCrypt container. Stronger, but mounting needs VeraCrypt
             installed AND administrator rights on every machine you use.

  To switch:  node portable/boot.mjs --convert store

-- WHAT'S ON HERE ----------------------------------------------------------

  Claudbot.cmd, claudbot.sh, claudbot.command   launchers
  runtime/                                      Node + Claude Code CLI
  app/                                          Claudbot source code
  portable/                                     boot + encryption machinery
  ${mode === "veracrypt" ? "vault.hc" : "store.enc"}${" ".repeat(Math.max(1, 46 - (mode === "veracrypt" ? 8 : 9)))}your encrypted data

Generated ${new Date().toISOString().slice(0, 10)} by scripts/make-portable.mjs
`);
}

function copyPortableMachinery(target) {
  const dst = path.join(target, "portable");
  mkdirSync(dst, { recursive: true });
  // Copy every module rather than a hand-maintained list. A list silently
  // drifts as imports are added: omitting prompt.mjs shipped drives whose
  // boot.mjs threw ERR_MODULE_NOT_FOUND before printing anything.
  for (const e of readdirSync(path.join(ROOT, "portable"), { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
    copyOnto(path.join(ROOT, "portable", e.name), path.join(dst, e.name));
  }
}

/**
 * Assert the assembled drive can actually start: every relative import reachable
 * from boot.mjs must exist on the drive. check:portable exercises these modules
 * in the repo, where they always resolve, so only a check against the built
 * artifact catches a missing file.
 */
/**
 * Assert the app's own imports resolve on the drive. verifyPortableMachinery
 * only walks boot.mjs, so it never noticed that app/ imports paths.mjs too —
 * and portable/ is excluded from the app copy, which shipped a drive that
 * unlocked, started Node and then died with ERR_MODULE_NOT_FOUND. Check what
 * the drive actually contains, not what the repo does.
 */
function verifyAppImports(target) {
  const appRoot = path.join(target, "app");
  const missing = [];
  let checked = 0;
  for (const e of readdirSync(appRoot, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
    const src = readFileSync(path.join(appRoot, e.name), "utf8");
    for (const m of src.matchAll(/from\s+["'](\.\/portable\/[^"']+)["']/g)) {
      checked++;
      if (!existsSync(path.join(appRoot, m[1]))) missing.push(`${e.name} -> ${m[1]}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `the drive's app cannot resolve its own imports: ${missing.join(", ")}.\n` +
      `  The drive would unlock and then die at startup.`,
    );
  }
  return checked;
}

function verifyPortableMachinery(target) {
  const dir = path.join(target, "portable");
  const seen = new Set();
  const missing = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = readFileSync(path.join(dir, file), "utf8"); }
    catch { missing.push(file); return; }
    for (const m of src.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+["'](\.\/[^"']+)["']/gm)) {
      walk(m[1].slice(2));
    }
  };
  walk("boot.mjs");
  if (missing.length) {
    throw new Error(
      `the drive is missing module(s) boot.mjs needs: ${missing.join(", ")}.\n` +
      `  Without them the drive cannot start on any machine.`,
    );
  }
  return seen.size;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += statSync(f).size; } catch { /* skip */ } }
    }
  };
  try { walk(dir); } catch { /* partial */ }
  return total;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) { usage(); process.exit(args.help ? 0 : 1); }
  if (args.mode !== "store" && args.mode !== "veracrypt") die(`--mode must be store or veracrypt`);

  const target = path.resolve(args.target);
  if (!existsSync(target)) die(`Target does not exist: ${target}\nPlug the drive in, or create the directory first.`);
  if (!statSync(target).isDirectory()) die(`Target is not a directory: ${target}`);

  console.log(`\n${C.bold}Building Claudbot portable drive${C.reset}`);
  console.log(`${C.dim}  source: ${ROOT}`);
  console.log(`  target: ${target}`);
  console.log(`  mode:   ${args.mode}${C.reset}`);

  // Existing data must never be destroyed silently.
  const storePath = path.join(target, "store.enc");
  if (existsSync(storePath) && !args.refresh) {
    die(`There is already a store.enc on ${target}.\n` +
        `Use --refresh to update the code and runtimes while keeping that data,\n` +
        `or delete it yourself if you really want to start over.`);
  }

  step("1/6  Copying Claudbot");
  const files = copyApp(target, args.includeVoice);
  good(`${files} source file(s)`);
  if (!args.includeVoice) info("voice/.venv and voice/models excluded (762 MB, shelved)");
  copyPortableMachinery(target);
  good(`portable machinery (${verifyPortableMachinery(target)} modules, imports resolve)`);
  good(`app imports resolve on the drive (${verifyAppImports(target)} checked)`);

  step("2/6  Runtimes");
  if (args.skipRuntimes) {
    warn("skipped — the drive will need Node installed on each host");
  } else {
    const failed = await fetchRuntimes(target);
    // Every platform failing means the drive cannot run anywhere the host has
    // no Node — the whole point of bundling. That is a build failure, not a
    // warning to scroll past, so say so instead of reporting success.
    if (failed.length === PLATFORMS.length) {
      throw new Error(
        `no Node runtime could be bundled (all ${PLATFORMS.length} platforms failed: ${failed.join(", ")}).\n` +
        `  The drive would only run on hosts that already have Node installed.\n` +
        `  Re-run with --skip-runtimes if that is genuinely what you want.`,
      );
    }
    if (failed.length) warn(`missing runtimes: ${failed.join(", ")} — those platforms will need host Node`);
    if (fetchClaudeCode(target)) good("Claude Code CLI bundled");
    else warn("Claude Code CLI NOT bundled — the drive will need it installed on each host");
  }

  step("3/6  Launchers and README");
  writeLaunchers(target);
  writeReadme(target, args.mode);
  good("Claudbot.cmd, claudbot.sh, claudbot.command, README-FIRST.txt");

  if (args.refresh) {
    step("4/6  Personal data");
    info("--refresh: leaving the existing encrypted store untouched");
    step("5/6  Manifest");
    good("unchanged");
  } else {
    step("4/6  Gathering personal data");
    const { work, report } = assembleWork(target);
    for (const r of report) good(r);
    const staged = dirSize(work);
    info(`${(staged / 1e6).toFixed(1)} MB staged`);

    step("5/6  Encrypting");
    console.log(`  ${C.dim}This passphrase is the only thing protecting your keys, notes and`);
    console.log(`  conversation history. It cannot be recovered if you forget it.${C.reset}\n`);
    let passphrase;
    try { passphrase = await newPassphrase(); }
    catch { rmSync(work, { recursive: true, force: true }); die("Cancelled — nothing was written."); }

    if (args.mode === "veracrypt") {
      warn("VeraCrypt containers must be created with VeraCrypt's own wizard.");
      warn(`Staged data is at ${work} — copy it into your container, then delete it.`);
      warn(`Set "mode": "veracrypt" in portable/manifest.json once done.`);
    } else {
      const bytes = lock(work, storePath, passphrase);
      good(`store.enc written (${(bytes / 1e6).toFixed(1)} MB)`);
      shred(work);
      good("staging area shredded");
    }
  }

  step("6/6  Manifest");
  writeFileSync(path.join(target, "portable", "manifest.json"), JSON.stringify({
    mode: args.mode,
    builtAt: new Date().toISOString(),
    builtFrom: os.hostname(),
    nodeVersion: NODE_VERSION,
  }, null, 2));
  good("manifest.json");

  const total = dirSize(target);
  console.log(`\n${C.green}${C.bold}Drive ready.${C.reset} ${C.dim}${(total / 1e6).toFixed(0)} MB total${C.reset}`);
  console.log(`\n  Eject safely, then on any machine:`);
  console.log(`    Windows  ${C.cyan}Claudbot.cmd${C.reset}`);
  console.log(`    macOS    ${C.cyan}claudbot.command${C.reset}`);
  console.log(`    Linux    ${C.cyan}./claudbot.sh${C.reset}\n`);
}

main().catch((err) => die(err.stack ?? err.message));
