/**
 * portable/paths.mjs — every location Claudbot needs, resolved without ever
 * hardcoding a drive letter or a home directory.
 *
 * A USB stick mounts as E:\ on one machine, F:\ on the next, and
 * /Volumes/CLAUDBOT or /media/you/CLAUDBOT elsewhere. Nothing on the drive may
 * assume where it landed. Everything here derives from this file's own location
 * (import.meta.url), which is always correct wherever the drive is plugged in.
 *
 * Layout when portable:
 *
 *   <drive>/
 *     portable/   this file, boot.mjs, store.mjs, veracrypt.mjs
 *     runtime/    bundled Node, one dir per platform
 *     app/        the Claudbot repo (code only, no secrets)
 *     work/       decrypted personal data, only while unlocked
 *       .env
 *       vault/         the MyBrain Obsidian vault
 *       claude-home/   CLAUDE_CONFIG_DIR: auth, projects/, sessions/
 *
 * When NOT portable (a normal desktop install) every accessor falls back to the
 * classic locations, so importing this module never changes desktop behaviour.
 */

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The drive root — the parent of portable/. */
export const DRIVE_ROOT = path.resolve(HERE, "..");

/**
 * Portable mode is asserted by the launcher, not guessed. Guessing from
 * directory shape would make a normal desktop checkout that happens to contain
 * a portable/ dir start relocating the user's real vault.
 */
export function isPortable() {
  return process.env.CLAUDBOT_PORTABLE === "1";
}

/** Decrypted personal data. Only exists while the store is unlocked. */
export function workDir() {
  return process.env.CLAUDBOT_WORK ?? path.join(DRIVE_ROOT, "work");
}

/** The Claudbot repo itself. */
export function appDir() {
  if (!isPortable()) return path.resolve(HERE, "..");
  return path.join(DRIVE_ROOT, "app");
}

/**
 * The Obsidian vault. Explicit env always wins so a portable session can be
 * pointed at a local vault, and vice versa.
 */
export function vaultPath() {
  if (process.env.CLAUDBOT_VAULT) return process.env.CLAUDBOT_VAULT;
  if (isPortable()) return path.join(workDir(), "vault");
  return process.platform === "win32"
    ? "C:\\Repo\\MyBrain"
    : path.join(os.homedir(), "MyBrain");
}

/**
 * CLAUDE_CONFIG_DIR. This is the single most important redirect: it moves
 * Claude Code's auth, projects/ transcripts and sessions/ onto the drive, so
 * history travels with you AND nothing is left behind on a borrowed machine.
 * Verified empirically — setting it makes Claude Code create .claude.json,
 * projects/ and sessions/ in the target and read auth from there.
 */
export function claudeHome() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  if (isPortable()) return path.join(workDir(), "claude-home");
  return path.join(os.homedir(), ".claude");
}

/** Where the .env with API keys lives. */
export function envFile() {
  if (isPortable()) return path.join(workDir(), ".env");
  return path.join(appDir(), ".env");
}

/** The encrypted blob (Node-native mode) and the VeraCrypt container. */
export function storeFile()     { return path.join(DRIVE_ROOT, "store.enc"); }
export function containerFile() { return path.join(DRIVE_ROOT, "vault.hc"); }
export function manifestFile()  { return path.join(DRIVE_ROOT, "portable", "manifest.json"); }

/**
 * Runtime directory name for this host.
 *
 * These follow Node's own release naming, which is NOT the same as
 * process.platform: Node ships "win-x64" where process.platform says "win32".
 * Getting this wrong makes bundledNode() silently return null.
 */
export function runtimeKey(platform = process.platform, arch = process.arch) {
  const os = { win32: "win", darwin: "darwin", linux: "linux" }[platform];
  return os ? `${os}-${arch}` : null;
}

/** The bundled Node for this host, or null if this platform wasn't bundled. */
export function bundledNode() {
  const key = runtimeKey();
  if (!key) return null;
  const dir = path.join(DRIVE_ROOT, "runtime", key);
  const exe = process.platform === "win32"
    ? path.join(dir, "node.exe")
    : path.join(dir, "bin", "node");
  return existsSync(exe) ? exe : null;
}

/**
 * The Claude Code CLI to run. Prefers the copy bundled on the drive so the
 * host needs nothing installed; falls back to whatever is on PATH.
 */
export function claudeBin() {
  const local = path.join(
    DRIVE_ROOT, "runtime", "claude-code", "node_modules", ".bin",
    process.platform === "win32" ? "claude.cmd" : "claude",
  );
  return existsSync(local) ? local : "claude";
}

/**
 * Env additions every Claudbot process needs in portable mode. Returned as a
 * plain object so callers can spread it over process.env.
 */
export function portableEnv() {
  if (!isPortable()) return {};
  return {
    CLAUDBOT_PORTABLE: "1",
    CLAUDBOT_WORK: workDir(),
    CLAUDBOT_VAULT: vaultPath(),
    CLAUDE_CONFIG_DIR: claudeHome(),
  };
}
