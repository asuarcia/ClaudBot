#!/usr/bin/env node
/**
 * scripts/check-portable.mjs — verifies the portable-drive machinery.
 *
 * Two things must hold before a USB build can be trusted:
 *   1. Conversation history survives the drive letter changing between hosts.
 *   2. The encrypted store round-trips exactly, and fails loudly on a wrong
 *      passphrase or tampering rather than returning garbage.
 *
 * Run with: npm run check:portable
 */

import { reconcileTranscripts } from "../portable/reconcile.mjs";
import {
  encryptBuffer, decryptBuffer, packDir, unpackTo,
  lock, unlock, shred, staleUnlock,
} from "../portable/store.mjs";
import { feedPassphraseChar } from "../portable/prompt.mjs";
import { runtimeKey } from "../portable/paths.mjs";
import {
  scanFiles, planSync, applySync, conflictName,
} from "../portable/sync.mjs";
import { probe as vcProbe, mount as vcMount } from "../portable/veracrypt.mjs";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, rmSync, statSync, utimesSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const TMP = path.join(os.tmpdir(), `claudbot-portable-check-${process.pid}`);
let pass = 0, fail = 0;

const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label} \x1b[2m${detail}\x1b[0m`); }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function fresh(name) {
  const dir = path.join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
function seed(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof size === "number" ? "x".repeat(size) : size);
  }
}

// ─── transcripts across drive letters ────────────────────────────────────────

section("Transcript continuity across hosts");
{
  const root = fresh("recon1");
  const projects = path.join(root, "projects");
  const manifest = path.join(root, "manifest.json");
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "E--app--claudbot", manifestFile: manifest });
  ok("blank drive creates the directory", r.action === "created", JSON.stringify(r));
  ok("manifest records the name", JSON.parse(readFileSync(manifest, "utf8")).lastProjectDir === "E--app--claudbot");
}
{
  const root = fresh("recon2");
  const projects = path.join(root, "projects");
  const manifest = path.join(root, "manifest.json");
  seed(path.join(projects, "E--app--claudbot"), { "a.jsonl": 100, "b.jsonl": 200 });
  writeFileSync(manifest, JSON.stringify({ lastProjectDir: "E--app--claudbot" }));
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "F--app--claudbot", manifestFile: manifest });
  ok("E: -> F: carries history over", r.action === "renamed" && r.from === "E--app--claudbot", JSON.stringify(r));
  ok("every transcript followed", readdirSync(path.join(projects, "F--app--claudbot")).length === 2);
  ok("the old directory is gone", !existsSync(path.join(projects, "E--app--claudbot")));
}
{
  const root = fresh("recon3");
  const projects = path.join(root, "projects");
  const manifest = path.join(root, "manifest.json");
  seed(path.join(projects, "E--app--claudbot"), { "a.jsonl": 100 });
  writeFileSync(manifest, JSON.stringify({ lastProjectDir: "E--app--claudbot" }));
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "E--app--claudbot", manifestFile: manifest });
  ok("same host twice is a no-op", r.action === "unchanged", JSON.stringify(r));
}
{
  const root = fresh("recon4");
  const projects = path.join(root, "projects");
  const manifest = path.join(root, "manifest.json");
  seed(path.join(projects, "F--app--claudbot"), { "new.jsonl": 100, "shared.jsonl": 500 });
  seed(path.join(projects, "E--app--claudbot"), { "old.jsonl": 100, "shared.jsonl": 200 });
  writeFileSync(manifest, JSON.stringify({ lastProjectDir: "F--app--claudbot" }));
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "E--app--claudbot", manifestFile: manifest });
  ok("returning to a known host merges", r.action === "merged", JSON.stringify(r));
  const files = readdirSync(path.join(projects, "E--app--claudbot")).sort().join(",");
  ok("merge is the union, nothing lost", files === "new.jsonl,old.jsonl,shared.jsonl", files);
  ok("name collision keeps the longer transcript",
     readFileSync(path.join(projects, "E--app--claudbot", "shared.jsonl"), "utf8").length === 500);
}
{
  const root = fresh("recon5");
  const projects = path.join(root, "projects");
  seed(path.join(projects, "E--app--claudbot"), { "a.jsonl": 100 });
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "G--app--claudbot", manifestFile: path.join(root, "m.json") });
  ok("lost manifest still finds history", r.action === "renamed" && r.from === "E--app--claudbot", JSON.stringify(r));
}
{
  const root = fresh("recon6");
  const projects = path.join(root, "projects");
  mkdirSync(path.join(projects, "Z--empty"), { recursive: true });
  const r = reconcileTranscripts({ projectsDir: projects, currentName: "E--app--claudbot", manifestFile: path.join(root, "m.json") });
  ok("an empty directory is not mistaken for history", r.action === "created", JSON.stringify(r));
}

// ─── archive ─────────────────────────────────────────────────────────────────

section("Archive round-trip");
{
  const src = fresh("arc-src");
  const dst = path.join(TMP, "arc-dst");
  seed(src, {
    ".env": "NIM_API_KEY=secret\n",
    "vault/Projects/claudbot.md": "# note\n",
    "vault/Areas/coding-standards.md": "x".repeat(5000),
    "claude-home/projects/E--app/session.jsonl": "y".repeat(20000),
  });
  const packed = packDir(src);
  const n = unpackTo(packed, dst);
  ok("every file restored", n === 4, `got ${n}`);
  ok("nested paths preserved", existsSync(path.join(dst, "vault", "Projects", "claudbot.md")));
  ok("contents identical",
     readFileSync(path.join(dst, ".env"), "utf8") === "NIM_API_KEY=secret\n");
  ok("large file intact",
     readFileSync(path.join(dst, "claude-home", "projects", "E--app", "session.jsonl"), "utf8").length === 20000);
}
{
  // A hostile or corrupted store must not be able to write outside work/.
  const dst = path.join(TMP, "arc-escape");
  // Hand-built entry in the wire format: len | path | isDir | mode | size | data
  const evil = (() => {
    const p = Buffer.from("../../escaped.txt", "utf8");
    const len = Buffer.alloc(2); len.writeUInt16BE(p.length, 0);
    const meta = Buffer.alloc(9);
    meta.writeUInt8(0, 0); meta.writeUInt32BE(0o644, 1); meta.writeUInt32BE(3, 5);
    return Buffer.concat([len, p, meta, Buffer.from("bad"), Buffer.alloc(2)]);
  })();
  let threw = false;
  try { unpackTo(evil, dst); } catch (e) { threw = /escapes target/.test(e.message); }
  ok("path traversal is rejected", threw);
}

// ─── crypto ──────────────────────────────────────────────────────────────────

section("Encryption");
{
  const plain = Buffer.from("the quick brown fox".repeat(1000));
  const blob = encryptBuffer(plain, "correct horse battery staple");
  ok("ciphertext differs from plaintext", !blob.includes(Buffer.from("quick brown")));
  ok("round-trips exactly",
     decryptBuffer(blob, "correct horse battery staple").equals(plain));

  let threw = false;
  try { decryptBuffer(blob, "wrong passphrase"); } catch { threw = true; }
  ok("wrong passphrase is rejected", threw);

  const tampered = Buffer.from(blob);
  tampered[tampered.length - 5] ^= 0xff;
  threw = false;
  try { decryptBuffer(tampered, "correct horse battery staple"); } catch { threw = true; }
  ok("tampering is detected (GCM tag)", threw);

  threw = false;
  try { decryptBuffer(Buffer.from("not a store at all, really"), "x"); } catch { threw = true; }
  ok("a non-store file is rejected", threw);

  const a = encryptBuffer(plain, "same passphrase");
  const b = encryptBuffer(plain, "same passphrase");
  ok("same input encrypts differently each time (fresh salt+iv)", !a.equals(b));
}

// ─── lock / unlock / shred ───────────────────────────────────────────────────

section("Lock, unlock, shred");
{
  const work = fresh("lu-work");
  const store = path.join(TMP, "store.enc");
  seed(work, {
    ".env": "NIM_API_KEY=nvapi-secret\n",
    "vault/note.md": "personal\n",
    "claude-home/projects/E--app/s.jsonl": "z".repeat(10000),
  });

  const bytes = lock(work, store, "hunter2");
  ok("lock produces a store file", existsSync(store) && bytes > 0, `${bytes} bytes`);
  ok("store does not leak plaintext",
     !readFileSync(store).includes(Buffer.from("nvapi-secret")));

  const wiped = shred(work);
  ok("shred removes the work directory", !existsSync(work), `wiped ${wiped}`);

  const files = unlock(store, work, "hunter2");
  ok("unlock restores every file", files === 3, `got ${files}`);
  ok("secret is back verbatim",
     readFileSync(path.join(work, ".env"), "utf8") === "NIM_API_KEY=nvapi-secret\n");
  ok("transcript is back verbatim",
     readFileSync(path.join(work, "claude-home", "projects", "E--app", "s.jsonl"), "utf8").length === 10000);

  ok("unlocked marker is present", staleUnlock(work) !== null);

  let threw = false;
  try { unlock(store, work, "wrong"); } catch { threw = true; }
  ok("unlock with wrong passphrase fails", threw);

  // Round two: modify, re-lock, confirm the change persisted.
  writeFileSync(path.join(work, "vault", "note.md"), "edited on another machine\n");
  lock(work, store, "hunter2");
  shred(work);
  unlock(store, work, "hunter2");
  ok("edits survive a lock/unlock cycle",
     readFileSync(path.join(work, "vault", "note.md"), "utf8") === "edited on another machine\n");

  ok("marker is never archived", !existsSync(path.join(work, "vault", ".claudbot-unlocked")));
}
{
  const work = fresh("stale-work");
  ok("a clean directory reports no stale unlock", staleUnlock(work) === null);
}

// ─── passphrase entry ────────────────────────────────────────────────────────

section("Passphrase entry");
{
  // Drive the reducer the same way the raw-mode listener does.
  const type = (keys) => {
    let buf = "";
    for (const c of keys) {
      const step = feedPassphraseChar(buf, c);
      if (step.done) return { buf: step.buf, done: step.done };
      buf = step.buf;
    }
    return { buf, done: null };
  };

  const CTRL_C = "\u0003";
  const DEL    = "\u007f";

  ok("plain typing accumulates", type("hunter2").buf === "hunter2");
  ok("Enter submits", type("hunter2\r").done === "submit");
  ok("submitted value is correct", type("hunter2\r").buf === "hunter2");
  ok("Ctrl-C cancels", type("hun" + CTRL_C).done === "cancel");
  ok("backspace deletes (DEL)", type("hunterX" + DEL + "2").buf === "hunter2");
  ok("backspace deletes (BS)", type("hunterX\b2").buf === "hunter2");
  ok("backspace on empty is safe", type(DEL + DEL + "ab").buf === "ab");
  ok("stray control keys ignored", type("hunter\u0001\u001b2").buf === "hunter2");
  ok("unicode passphrases survive", type("café☕").buf === "café☕");
  ok("long passphrase intact", type("x".repeat(200)).buf.length === 200);
}

// ─── runtime naming ──────────────────────────────────────────────────────────

section("Bundled runtime naming");
{
  // Node's release names differ from process.platform: "win", not "win32".
  // A mismatch here makes bundledNode() silently return null and the drive
  // falls back to the host's Node without saying why.
  ok("win32 maps to win-x64", runtimeKey("win32", "x64") === "win-x64");
  ok("darwin arm64 maps through", runtimeKey("darwin", "arm64") === "darwin-arm64");
  ok("darwin x64 maps through", runtimeKey("darwin", "x64") === "darwin-x64");
  ok("linux x64 maps through", runtimeKey("linux", "x64") === "linux-x64");
  ok("unknown platform yields null", runtimeKey("sunos", "x64") === null);
}

// ─── veracrypt argument safety ───────────────────────────────────────────────

section("VeraCrypt argument handling");
{
  // probe() must degrade honestly rather than throwing, so the boot path can
  // explain why a drive won't open here.
  const p = vcProbe();
  ok("probe reports a usable flag", typeof p.usable === "boolean");
  ok("probe explains itself when unusable", p.usable || (typeof p.reason === "string" && p.reason.length > 0), p.reason);

  // mount() must reject inputs the child's own parser would mishandle. These
  // fire before any binary lookup, so they're testable without VeraCrypt.
  const rejects = (pass, why) => {
    let msg = null;
    try { vcMount("Z:\\nope.hc", pass); } catch (e) { msg = e.message; }
    // Either the guard fired, or we got the "not installed" message — which
    // would mean the guard was skipped. Only the former is a pass.
    return { ok: msg !== null && !/not installed/i.test(msg), msg, why };
  };
  const nl = rejects("has\nnewline");
  ok("passphrase with a newline is rejected", nl.ok, nl.msg ?? "no error");
  const nul = rejects("has" + String.fromCharCode(0) + "null");
  ok("passphrase with a null byte is rejected", nul.ok, nul.msg ?? "no error");
  if (process.platform === "win32") {
    const slash = rejects("/quit");
    ok("option-like passphrase rejected on Windows", slash.ok, slash.msg ?? "no error");
  }
}

// ─── sync ────────────────────────────────────────────────────────────────────

section("Drive sync");
{
  // Build a local/drive pair, run a real plan+apply, and assert nothing is lost.
  const mk = (name) => {
    const root = fresh(name);
    return root;
  };
  const put = (root, rel, body, mtime) => {
    const full = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
    if (mtime) utimesSync(full, mtime / 1000, mtime / 1000);
  };
  const read = (root, rel) => readFileSync(path.join(root, ...rel.split("/")), "utf8");
  const has  = (root, rel) => existsSync(path.join(root, ...rel.split("/")));

  // 1. First sync, no baseline: both sides' files end up on both sides.
  {
    const L = mk("sync1-local"), D = mk("sync1-drive");
    put(L, "Areas/standards.md", "local only\n");
    put(D, "Projects/new.md", "drive only\n");
    const plan = planSync(scanFiles(L), scanFiles(D), {}, "t");
    ok("new local file goes to drive", plan.toDrive.some((f) => f.rel === "Areas/standards.md"));
    ok("new drive file comes local", plan.toLocal.some((f) => f.rel === "Projects/new.md"));
    ok("no false conflicts on first sync", plan.conflicts.length === 0);
    const res = applySync(plan, L, D);
    ok("both sides now have both files",
       has(D, "Areas/standards.md") && has(L, "Projects/new.md"),
       `toDrive=${res.copiedToDrive} toLocal=${res.copiedToLocal}`);
  }

  // 2. Edited on one side only — must propagate, not conflict.
  {
    const L = mk("sync2-local"), D = mk("sync2-drive");
    put(L, "note.md", "v1\n"); put(D, "note.md", "v1\n");
    const base = applySync(planSync(scanFiles(L), scanFiles(D), {}, "t"), L, D).baseline;
    put(L, "note.md", "v2 edited at the desk\n");
    const plan = planSync(scanFiles(L), scanFiles(D), base, "t");
    ok("one-sided local edit propagates", plan.toDrive.some((f) => f.rel === "note.md"));
    ok("one-sided edit is not a conflict", plan.conflicts.length === 0);
    applySync(plan, L, D);
    ok("drive received the edit", read(D, "note.md") === "v2 edited at the desk\n");
  }
  {
    const L = mk("sync3-local"), D = mk("sync3-drive");
    put(L, "note.md", "v1\n"); put(D, "note.md", "v1\n");
    const base = applySync(planSync(scanFiles(L), scanFiles(D), {}, "t"), L, D).baseline;
    put(D, "note.md", "v2 edited on the road\n");
    const plan = planSync(scanFiles(L), scanFiles(D), base, "t");
    ok("one-sided drive edit propagates", plan.toLocal.some((f) => f.rel === "note.md"));
    applySync(plan, L, D);
    ok("desktop received the edit", read(L, "note.md") === "v2 edited on the road\n");
  }

  // 3. Both sides edited differently — the data-loss case. Nothing may vanish.
  {
    const L = mk("sync4-local"), D = mk("sync4-drive");
    put(L, "Areas/standards.md", "v1\n"); put(D, "Areas/standards.md", "v1\n");
    const base = applySync(planSync(scanFiles(L), scanFiles(D), {}, "t"), L, D).baseline;
    put(L, "Areas/standards.md", "desk version\n", Date.now());
    put(D, "Areas/standards.md", "road version\n", Date.now() - 60_000);
    const plan = planSync(scanFiles(L), scanFiles(D), base, "tag");
    ok("divergent edits are a conflict", plan.conflicts.length === 1, JSON.stringify(plan.conflicts));
    ok("newer side wins", plan.conflicts[0].winner === "local");
    applySync(plan, L, D);
    ok("winner is in place on both sides",
       read(L, "Areas/standards.md") === "desk version\n" &&
       read(D, "Areas/standards.md") === "desk version\n");
    const side = "Areas/standards.conflict-tag.md";
    ok("loser preserved as a sidecar", has(L, side) && has(D, side));
    ok("sidecar holds the losing text", read(L, side) === "road version\n");
  }

  // 4. Both edited to the SAME content — no conflict, no work.
  {
    const L = mk("sync5-local"), D = mk("sync5-drive");
    put(L, "n.md", "v1\n"); put(D, "n.md", "v1\n");
    const base = applySync(planSync(scanFiles(L), scanFiles(D), {}, "t"), L, D).baseline;
    put(L, "n.md", "same\n"); put(D, "n.md", "same\n");
    const plan = planSync(scanFiles(L), scanFiles(D), base, "t");
    ok("identical edits are not a conflict",
       plan.conflicts.length === 0 && plan.toDrive.length === 0 && plan.toLocal.length === 0);
  }

  // 5. Transcripts are append-only: take the longer, never conflict.
  {
    const L = mk("sync6-local"), D = mk("sync6-drive");
    put(L, "E--app/s.jsonl", "line1\nline2\nline3\n");
    put(D, "E--app/s.jsonl", "line1\n");
    const plan = planSync(scanFiles(L), scanFiles(D), {}, "t");
    ok("longer transcript wins without conflict",
       plan.conflicts.length === 0 && plan.toDrive.some((f) => f.rel === "E--app/s.jsonl"));
    applySync(plan, L, D);
    ok("drive got the fuller transcript", read(D, "E--app/s.jsonl").split("\n").length === 4);
  }

  // 6. Sync never deletes: a file removed on one side comes back, not away.
  {
    const L = mk("sync7-local"), D = mk("sync7-drive");
    put(L, "keep.md", "important\n"); put(D, "keep.md", "important\n");
    const base = applySync(planSync(scanFiles(L), scanFiles(D), {}, "t"), L, D).baseline;
    rmSync(path.join(D, "keep.md"));
    const plan = planSync(scanFiles(L), scanFiles(D), base, "t");
    ok("a deletion is never propagated", plan.toLocal.length === 0);
    ok("the surviving copy is restored", plan.toDrive.some((f) => f.rel === "keep.md"));
    applySync(plan, L, D);
    ok("file still exists on both sides", has(L, "keep.md") && has(D, "keep.md"));
  }

  // 7. Conflict naming must not mangle paths or extensions.
  {
    ok("conflict name keeps extension", conflictName("a/b/note.md", "t") === "a/b/note.conflict-t.md");
    ok("conflict name handles no extension", conflictName("LICENSE", "t") === "LICENSE.conflict-t");
    ok("conflict name handles dotfiles", conflictName(".env", "t") === ".env.conflict-t");
  }

  // 8. .git and .obsidian are skipped — syncing them would be huge and wrong.
  {
    const L = mk("sync8-local");
    put(L, ".git/config", "x\n");
    put(L, ".obsidian/workspace.json", "y\n");
    put(L, "real.md", "z\n");
    const scanned = [...scanFiles(L).keys()];
    ok("VCS and editor state excluded", scanned.length === 1 && scanned[0] === "real.md", scanned.join(","));
  }
}

// ─── done ────────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });
console.log(
  fail === 0
    ? `\n\x1b[32m\x1b[1mAll ${pass} portable checks passed.\x1b[0m\n`
    : `\n\x1b[31m\x1b[1m${fail} failed\x1b[0m, ${pass} passed.\n`,
);
process.exit(fail ? 1 : 0);
