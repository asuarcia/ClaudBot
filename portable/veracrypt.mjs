/**
 * portable/veracrypt.mjs — the second protection mode.
 *
 * VeraCrypt is stronger and far more battle-tested than our own store, but it
 * mounts through a kernel driver and therefore needs administrator rights on
 * every host. That is exactly what you won't have on a work laptop or someone
 * else's machine, which is why the Node-native store in store.mjs exists as the
 * fallback and is the default.
 *
 * This module never decides policy. It reports honestly what this host can do
 * (`probe()`), and the boot sequence decides what to do about it.
 *
 * One mode is active at a time, recorded in manifest.json. There is deliberately
 * no "keep both in sync" path: two copies of your vault and transcripts that
 * drift apart is a worse outcome than either mode alone.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Candidate binary locations, most-specific first. */
function candidates() {
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\VeraCrypt\\VeraCrypt.exe",
      "C:\\Program Files (x86)\\VeraCrypt\\VeraCrypt.exe",
      "VeraCrypt.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/VeraCrypt.app/Contents/MacOS/VeraCrypt",
      "/usr/local/bin/veracrypt",
      "veracrypt",
    ];
  }
  return ["/usr/bin/veracrypt", "/usr/local/bin/veracrypt", "veracrypt"];
}

/** Absolute path to the VeraCrypt binary, or null. */
export function findBinary() {
  for (const c of candidates()) {
    if (c.includes(path.sep) || c.includes("/")) {
      if (existsSync(c)) return c;
    } else {
      // Bare name: ask the OS whether it resolves on PATH.
      const which = process.platform === "win32" ? "where" : "which";
      const r = spawnSync(which, [c], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return null;
}

/**
 * Are we elevated enough to load VeraCrypt's driver?
 * Windows: `net session` only succeeds elevated.
 * Unix: root, or a usable passwordless sudo.
 */
export function hasAdmin() {
  if (process.platform === "win32") {
    const r = spawnSync("net", ["session"], { stdio: "ignore" });
    return r.status === 0;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  const r = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * What can this host actually do?
 * @returns {{usable: boolean, binary: string|null, admin: boolean, reason: string}}
 */
export function probe() {
  const binary = findBinary();
  if (!binary) {
    return {
      usable: false, binary: null, admin: false,
      reason: "VeraCrypt is not installed on this machine.",
    };
  }
  const admin = hasAdmin();
  if (!admin) {
    return {
      usable: false, binary, admin: false,
      reason: "VeraCrypt is installed but mounting needs administrator rights, which this session doesn't have.",
    };
  }
  return { usable: true, binary, admin: true, reason: "ready" };
}

/** A free drive letter on Windows, scanning backwards from Z:. */
function freeDriveLetter() {
  for (const l of "ZYXWVUTSRQPONMLKJIH") {
    if (!existsSync(`${l}:\\`)) return l;
  }
  return null;
}

/**
 * Mount `container`. Returns the path the plaintext is reachable at.
 *
 * Security note worth being explicit about: the passphrase is passed as a
 * command-line argument, which is briefly visible in the host's process list.
 * VeraCrypt's CLI offers no portable stdin path across all three platforms, so
 * this is inherent to driving it programmatically. The Node-native store has no
 * such exposure — another reason it is the default.
 */
export function mount(container, passphrase, { mountPoint } = {}) {
  const { usable, binary, reason } = probe();
  if (!usable) throw new Error(reason);
  if (!existsSync(container)) throw new Error(`container not found: ${container}`);

  if (process.platform === "win32") {
    const letter = mountPoint ?? freeDriveLetter();
    if (!letter) throw new Error("no free drive letter to mount the container on");
    const r = spawnSync(binary, [
      "/volume", container,
      "/letter", letter,
      "/password", passphrase,
      "/quit", "/silent",
      "/explore-off",
    ], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`VeraCrypt mount failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
    }
    return `${letter}:\\`;
  }

  const target = mountPoint ?? path.join(os.tmpdir(), `claudbot-vc-${process.pid}`);
  const args = [
    "--text", "--non-interactive",
    "--pim=0", "--keyfiles=", "--protect-hidden=no",
    `--password=${passphrase}`,
    container, target,
  ];
  const useSudo = typeof process.getuid === "function" && process.getuid() !== 0;
  const r = useSudo
    ? spawnSync("sudo", ["-n", binary, ...args], { encoding: "utf8" })
    : spawnSync(binary, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`VeraCrypt mount failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
  return target;
}

/** Unmount. Best-effort: a failure here is reported, never thrown. */
export function dismount(mountedAt) {
  const binary = findBinary();
  if (!binary) return { ok: false, error: "VeraCrypt binary vanished" };
  try {
    if (process.platform === "win32") {
      const letter = mountedAt.replace(/[:\\/]/g, "").slice(0, 1);
      const r = spawnSync(binary, ["/dismount", letter, "/quit", "/silent"], { encoding: "utf8" });
      return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || "").trim() };
    }
    const useSudo = typeof process.getuid === "function" && process.getuid() !== 0;
    const args = ["--text", "--non-interactive", "--dismount", mountedAt];
    const r = useSudo
      ? spawnSync("sudo", ["-n", binary, ...args], { encoding: "utf8" })
      : spawnSync(binary, args, { encoding: "utf8" });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || "").trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
