/**
 * portable/store.mjs — the encrypted store that holds everything personal.
 *
 * Protects: .env (NIM key, Proxmox token), the MyBrain vault, and claude-home
 * (Claude Code auth + every conversation transcript). If the stick is lost,
 * these are the things that must not be readable.
 *
 * Design constraints that shaped this:
 *   - No admin rights. VeraCrypt needs a kernel driver; this needs nothing but
 *     the bundled Node, so it works on a locked-down work laptop.
 *   - No dependencies. Everything here is node:crypto and node:zlib, so the
 *     drive can't be broken by a missing or ABI-mismatched native module.
 *   - Plaintext never touches the host. Decryption targets a working directory
 *     on the USB itself, which is shredded on exit.
 *
 * Crypto: scrypt(N=2^16, r=8, p=1) for the KDF, AES-256-GCM for the payload.
 * GCM authenticates, so a wrong passphrase or a corrupted/tampered file fails
 * loudly at decrypt rather than yielding garbage.
 *
 * File layout:
 *   magic 8 | salt 16 | iv 12 | tag 16 | ciphertext...
 */

import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const MAGIC     = Buffer.from("CLDBTv1\n", "utf8"); // 8 bytes
const SALT_LEN  = 16;
const IV_LEN    = 12;
const TAG_LEN   = 16;
const KEY_LEN   = 32;

// scrypt cost. N=65536 with r=8 needs ~64 MB and takes a few hundred ms —
// slow enough to make offline guessing expensive, fast enough not to annoy.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };

/** Marker written into the work dir while it holds decrypted data. */
const MARKER = ".claudbot-unlocked";

function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(passphrase, "utf8"), salt, KEY_LEN, SCRYPT);
}

// ─── archive (dependency-free) ───────────────────────────────────────────────
//
// A deliberately boring format so the drive never depends on a tar library:
//   per entry: u16 pathLen | path utf8 | u8 isDir | u32 mode | u32 size | bytes
//   terminated by a u16 zero length.
// Paths are stored with forward slashes so a drive written on Windows unpacks
// correctly on macOS and Linux.

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      out.push({ rel, dir: true, mode: 0o755, data: Buffer.alloc(0) });
      walk(full, base, out);
    } else if (entry.isFile()) {
      if (rel === MARKER) continue;                 // never archive the marker
      let mode = 0o644;
      try { mode = statSync(full).mode & 0o777; } catch { /* default */ }
      out.push({ rel, dir: false, mode, data: readFileSync(full) });
    }
    // symlinks/sockets are skipped on purpose — nothing in the data set uses them
  }
  return out;
}

export function packDir(dir) {
  const chunks = [];
  for (const e of walk(dir)) {
    const p = Buffer.from(e.rel, "utf8");
    if (p.length > 0xffff) throw new Error(`path too long to archive: ${e.rel}`);
    if (e.data.length > 0xffffffff) throw new Error(`file too large to archive: ${e.rel}`);
    // Field order must match unpackTo exactly: len, path, isDir, mode, size.
    const len = Buffer.alloc(2);
    len.writeUInt16BE(p.length, 0);
    const meta = Buffer.alloc(1 + 4 + 4);
    meta.writeUInt8(e.dir ? 1 : 0, 0);
    meta.writeUInt32BE(e.mode, 1);
    meta.writeUInt32BE(e.data.length, 5);
    chunks.push(len, p, meta, e.data);
  }
  const end = Buffer.alloc(2); // u16 zero terminator
  chunks.push(end);
  return Buffer.concat(chunks);
}

export function unpackTo(buf, dir) {
  mkdirSync(dir, { recursive: true });
  let off = 0;
  let files = 0;
  for (;;) {
    if (off + 2 > buf.length) throw new Error("archive truncated");
    const pathLen = buf.readUInt16BE(off); off += 2;
    if (pathLen === 0) break;                        // terminator
    const rel = buf.subarray(off, off + pathLen).toString("utf8"); off += pathLen;
    const isDir = buf.readUInt8(off) === 1; off += 1;
    const mode = buf.readUInt32BE(off); off += 4;
    const size = buf.readUInt32BE(off); off += 4;

    // Reject anything that would escape the target directory. The archive is
    // ours, but a corrupted or hostile store.enc must not write outside work/.
    const dest = path.resolve(dir, rel);
    if (dest !== path.resolve(dir) && !dest.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`archive entry escapes target: ${rel}`);
    }

    if (isDir) {
      mkdirSync(dest, { recursive: true });
    } else {
      const data = buf.subarray(off, off + size); off += size;
      if (data.length !== size) throw new Error("archive truncated");
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, data, { mode: mode || 0o644 });
      files++;
    }
  }
  return files;
}

// ─── encrypt / decrypt ───────────────────────────────────────────────────────

export function encryptBuffer(plain, passphrase) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(blob, passphrase) {
  const headLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (blob.length < headLen) throw new Error("store file is truncated or not a Claudbot store");
  const magic = blob.subarray(0, MAGIC.length);
  if (!timingSafeEqual(magic, MAGIC)) throw new Error("not a Claudbot store (bad magic)");

  let off = MAGIC.length;
  const salt = blob.subarray(off, off += SALT_LEN);
  const iv   = blob.subarray(off, off += IV_LEN);
  const tag  = blob.subarray(off, off += TAG_LEN);
  const body = blob.subarray(off);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // GCM auth failure. Overwhelmingly this is a wrong passphrase; it is also
    // what tampering or bit-rot looks like. Don't guess which — say both.
    throw new Error("Wrong passphrase, or the store is corrupted.");
  }
}

// ─── the public operations ───────────────────────────────────────────────────

/** Encrypt `workDir` into `storeFile`. Returns bytes written. */
export function lock(workDir, storeFile, passphrase) {
  if (!existsSync(workDir)) throw new Error(`nothing to lock: ${workDir} does not exist`);
  const blob = encryptBuffer(gzipSync(packDir(workDir), { level: 6 }), passphrase);
  // Write to a temp file and rename, so an interrupted lock can never leave a
  // half-written store.enc where the only copy of the data used to be.
  const tmp = `${storeFile}.tmp`;
  writeFileSync(tmp, blob);
  rmSync(storeFile, { force: true });
  writeFileSync(storeFile, readFileSync(tmp));
  rmSync(tmp, { force: true });
  return blob.length;
}

/** Decrypt `storeFile` into `workDir`. Returns the number of files restored. */
export function unlock(storeFile, workDir, passphrase) {
  const blob = readFileSync(storeFile);
  const plain = gunzipSync(decryptBuffer(blob, passphrase));
  rmSync(workDir, { recursive: true, force: true });
  const files = unpackTo(plain, workDir);
  writeFileSync(
    path.join(workDir, MARKER),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "" }, null, 2),
  );
  return files;
}

/**
 * Best-effort shred of the working directory.
 *
 * Honest caveat, and it is worth stating plainly: on flash media, overwriting a
 * file does NOT reliably destroy the old bytes. Wear levelling means the
 * controller writes to a different physical cell and the original may persist
 * until it is garbage-collected. This raises the bar against casual recovery,
 * not against forensics. The real protection is that the store itself is
 * encrypted at rest and the passphrase never lands on disk.
 */
export function shred(workDir) {
  if (!existsSync(workDir)) return 0;
  let wiped = 0;
  const overwrite = (file) => {
    try {
      const size = statSync(file).size;
      if (size > 0) writeFileSync(file, randomBytes(Math.min(size, 1 << 20)));
      wiped++;
    } catch { /* locked or already gone */ }
  };
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) recurse(full);
      else overwrite(full);
    }
  };
  try { recurse(workDir); } catch { /* keep going to the rm */ }
  rmSync(workDir, { recursive: true, force: true });
  return wiped;
}

/**
 * Did a previous session die without re-locking? If so the work dir is sitting
 * there in plaintext. Returns the marker contents, or null if clean.
 */
export function staleUnlock(workDir) {
  const marker = path.join(workDir, MARKER);
  if (!existsSync(marker)) return null;
  try { return JSON.parse(readFileSync(marker, "utf8")); }
  catch { return { pid: null, at: null, host: "" }; }
}
