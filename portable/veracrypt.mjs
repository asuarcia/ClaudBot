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
 * Reject passphrases that VeraCrypt's own argument parser or our stdin framing
 * would mishandle. This is not shell escaping — nothing here runs through a
 * shell — it is about the child's own parsing.
 *
 *   - A newline would terminate the value early on the `--stdin` path.
 *   - On Windows, options are `/`-prefixed, so a passphrase or path beginning
 *     with `/` can be swallowed as a flag rather than a value.
 */
function assertSafeForArgv(passphrase, container) {
  if (/[\r\n\0]/.test(passphrase)) {
    throw new Error("VeraCrypt mode can't take a passphrase containing newlines or null bytes.");
  }
  if (process.platform === "win32" && passphrase.startsWith("/")) {
    throw new Error(
      "VeraCrypt on Windows takes the passphrase as a command-line option, so one " +
      "starting with '/' would be parsed as a flag. Use a passphrase that doesn't " +
      "start with '/', or switch this drive to store mode.",
    );
  }
  if (container.startsWith("-") || (process.platform === "win32" && container.startsWith("/"))) {
    throw new Error(`refusing to pass an option-like container path: ${container}`);
  }
}

/**
 * Mount `container`. Returns the path the plaintext is reachable at.
 *
 * Passphrase handling differs by platform, and the difference is a real
 * security property rather than an implementation detail:
 *
 *   Unix  — piped through stdin via `--stdin`, so it never appears in argv and
 *           never shows up in the host's process list.
 *   Win32 — VeraCrypt.exe has no stdin path; `/password` on the command line is
 *           the only non-interactive option, so the passphrase IS briefly
 *           visible to anything enumerating processes on that machine. The
 *           `/keyfile` alternative is worse: it would mean writing the
 *           passphrase to the stick in plaintext.
 *
 * The Node-native store has no such exposure on any platform, which is one of
 * the reasons it is the default mode.
 */
export function mount(container, passphrase, { mountPoint } = {}) {
  // Validate inputs before anything else. Bad input is bad input whether or not
  // VeraCrypt happens to be installed, and failing fast here keeps the guard
  // reachable (and testable) on machines that can't mount at all.
  assertSafeForArgv(passphrase, container);

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
  // `--stdin` keeps the passphrase out of argv. `--` ends option parsing so a
  // container or mount path can never be read as a flag.
  const args = [
    "--text", "--non-interactive", "--stdin",
    "--pim=0", "--keyfiles=", "--protect-hidden=no",
    "--", container, target,
  ];
  const opts = { encoding: "utf8", input: `${passphrase}\n` };
  const useSudo = typeof process.getuid === "function" && process.getuid() !== 0;
  const r = useSudo
    ? spawnSync("sudo", ["-n", binary, ...args], opts)
    : spawnSync(binary, args, opts);
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
    const args = ["--text", "--non-interactive", "--dismount", "--", mountedAt];
    const r = useSudo
      ? spawnSync("sudo", ["-n", binary, ...args], { encoding: "utf8" })
      : spawnSync(binary, args, { encoding: "utf8" });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || "").trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
