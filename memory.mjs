#!/usr/bin/env node
/**
 * Claudbot conversation memory
 *
 * Lets you reference past Claudbot sessions after the machine is rebooted —
 * "where did we leave off?", search old chats, resume context.
 *
 * It reuses the JSONL transcripts that Claude Code already writes for every
 * session (under ~/.claude/projects/<encoded-cwd>/), so there is zero extra
 * capture overhead — we just parse, index, and summarize what's already on disk.
 *
 * Exports are consumed by claudbot.mjs (the `recall` command + the
 * "where we left off" banner shown at startup).
 */

import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");
const INDEX_FILE    = path.join(CLAUDBOT_ROOT, "conversation-index.json");

// ─── transcript location ─────────────────────────────────────────────────────

// Claude Code stores each project's transcripts in a directory whose name is the
// absolute cwd with every non-alphanumeric char replaced by a dash. Claudbot
// launches Claude with cwd = .claudbot, so that's the cwd we encode.
export function projectDir(cwd = CLAUDBOT_ROOT) {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

// ─── transcript parsing ──────────────────────────────────────────────────────

// Pull plain text out of a transcript entry's message, whether content is a
// bare string or an array of content blocks (text / tool_use / tool_result).
function entryText(entry) {
  const c = entry?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b?.text === "string") return b.text;
        if (b?.type === "tool_use") return `[tool:${b.name}]`;
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

// A "real" user turn = something the person actually typed, not a tool result,
// slash-command stdout, system reminder, or harness meta entry.
function isRealUserTurn(entry) {
  if (entry?.type !== "user") return false;
  if (entry?.isMeta) return false;
  if (Array.isArray(entry?.message?.content)) return false; // tool_result payloads
  const t = entryText(entry).trim();
  if (!t) return false;
  if (t.startsWith("<")) return false;                       // system-reminder / wrapped tags
  if (/<command-name>|<local-command|<command-message>/.test(t)) return false;
  return true;
}

function isAssistantText(entry) {
  if (entry?.type !== "assistant") return false;
  const t = entryText(entry).trim();
  return Boolean(t) && !t.startsWith("[tool:");
}

function firstLine(text, max = 100) {
  const line = (text || "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// Parse one transcript file into a structured session summary (no LLM).
function parseSession(file) {
  let lines;
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }

  const id = path.basename(file, ".jsonl");
  let start = null;
  let end = null;
  let firstUser = "";
  let lastUser = "";
  let lastAssistant = "";
  let userTurns = 0;

  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) {
      if (!start) start = e.timestamp;
      end = e.timestamp;
    }
    if (isRealUserTurn(e)) {
      const t = entryText(e).trim();
      if (!firstUser) firstUser = t;
      lastUser = t;
      userTurns++;
    } else if (isAssistantText(e)) {
      lastAssistant = entryText(e).trim();
    }
  }

  if (userTurns === 0) return null; // ignore empty / system-only transcripts

  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }

  // Legacy dream/background runs were headless `claude -p` calls whose "user"
  // turn is one of the dream system prompts. They're not real conversations, so
  // flag them and keep them out of recall by default.
  const background = /^You are Claudbot's\b/i.test(firstUser.trim());

  return {
    id,
    file,
    start: start ?? new Date(mtimeMs).toISOString(),
    end: end ?? new Date(mtimeMs).toISOString(),
    mtimeMs,
    userTurns,
    background,
    topic: firstLine(firstUser),
    firstUser,
    lastUser,
    lastAssistant,
  };
}

/**
 * All past sessions for this project, newest first. `excludeId` drops the
 * currently-running session so "last session" means the previous one.
 */
export function listSessions({ limit = 0, excludeId = null, includeBackground = false } = {}) {
  const dir = projectDir();
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  const sessions = files
    .map(parseSession)
    .filter(Boolean)
    .filter((s) => s.id !== excludeId)
    .filter((s) => includeBackground || !s.background)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit > 0 ? sessions.slice(0, limit) : sessions;
}

// ─── full-text search ────────────────────────────────────────────────────────

/** Search every transcript for `query`; return sessions with a matching snippet. */
export function searchSessions(query, { limit = 8 } = {}) {
  const q = query.toLowerCase();
  const dir = projectDir();
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }

  const hits = [];
  for (const file of files) {
    const session = parseSession(file);
    if (!session || session.background) continue;
    let lines = [];
    try { lines = readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { continue; }

    let snippet = null;
    let count = 0;
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "user" && e.type !== "assistant") continue;
      const t = entryText(e);
      const idx = t.toLowerCase().indexOf(q);
      if (idx !== -1) {
        count++;
        if (!snippet) {
          const from = Math.max(0, idx - 40);
          snippet = (from > 0 ? "…" : "") + firstLine(t.slice(from, idx + q.length + 80), 140);
        }
      }
    }
    if (count > 0) hits.push({ ...session, matches: count, snippet });
  }
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// ─── summary index (cached LLM summaries) ────────────────────────────────────

function loadIndex() {
  try { return JSON.parse(readFileSync(INDEX_FILE, "utf8")); } catch { return {}; }
}

function saveIndex(index) {
  try { writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2)); } catch { /* non-fatal */ }
}

/**
 * A richer "where we left off" summary for a session. Uses a cached LLM summary
 * when available/fresh; otherwise asks the given agent to write one and caches
 * it keyed by session id + mtime. Falls back to a heuristic if no agent/key.
 */
export async function summarizeSession(session, { runAgent, agentName } = {}) {
  const index = loadIndex();
  const cached = index[session.id];
  if (cached && cached.mtimeMs === session.mtimeMs && cached.summary) {
    return cached.summary;
  }

  if (runAgent && agentName) {
    try {
      const transcript =
        `Topic (first message): ${firstLine(session.firstUser, 400)}\n\n` +
        `Most recent user request:\n${firstLine(session.lastUser, 600)}\n\n` +
        `Most recent assistant reply:\n${firstLine(session.lastAssistant, 800)}`;
      const summary = await runAgent(
        agentName,
        "Summarize this past coding-assistant session in 2-4 short bullet points so the user can " +
        "remember what happened and resume. Cover: what was worked on, key decisions/outcomes, and " +
        "the obvious next step. Be concrete and terse. No preamble.\n\n" + transcript,
      );
      const clean = summary.trim();
      index[session.id] = { mtimeMs: session.mtimeMs, summary: clean, topic: session.topic };
      saveIndex(index);
      return clean;
    } catch {
      /* fall through to heuristic */
    }
  }

  // Heuristic fallback — instant, no network.
  return (
    `• Topic: ${session.topic}\n` +
    `• Last request: ${firstLine(session.lastUser, 120)}\n` +
    `• Last reply: ${firstLine(session.lastAssistant, 120)}`
  );
}

// ─── formatting helpers ──────────────────────────────────────────────────────

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!then) return "unknown";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function shortId(id) {
  return id.slice(0, 8);
}

// ─── auto-indexing ───────────────────────────────────────────────────────────
//
// Keeps conversation-index.json continuously up to date so `recall last` and
// the startup banner always have a fresh LLM summary instead of computing one
// on demand. Run automatically by claudbot.mjs (detached) on start and exit,
// or manually: node memory.mjs index [--limit N] [--force] [--grace MS]

/**
 * Summarize any sessions whose cached summary is missing or stale.
 * `graceMs` skips sessions modified more recently than that (the live,
 * still-being-written session) — pass 0 when the session is known finished.
 */
export async function indexSessions({
  runAgent, agentName, limit = 15, force = false, graceMs = 120_000, log = () => {},
} = {}) {
  const sessions = listSessions({ limit });
  const index = loadIndex();
  let pruned = 0;

  // Prune entries for deleted transcripts
  const allIds = new Set(listSessions({ includeBackground: true }).map((s) => s.id));
  for (const id of Object.keys(index)) {
    if (!allIds.has(id)) { delete index[id]; pruned++; }
  }
  if (pruned > 0) saveIndex(index);

  const now = Date.now();
  let indexed = 0;
  for (const session of sessions) {
    if (session.mtimeMs > now - graceMs) continue; // probably still live
    const entry = index[session.id];
    if (!force && entry && entry.mtimeMs === session.mtimeMs) continue;
    try {
      await summarizeSession(session, { runAgent, agentName }); // caches itself
      log(`indexed ${shortId(session.id)} — ${session.topic}`);
      indexed++;
    } catch { /* per-session failures never stop the sweep */ }
  }

  return { indexed, pruned, total: sessions.length };
}

/** Cached summary entry {summary, topic, mtimeMs} for a session, or null. */
export function cachedSummary(sessionId) {
  const entry = loadIndex()[sessionId];
  if (!entry?.summary) return null;
  return { summary: entry.summary, topic: entry.topic, mtimeMs: entry.mtimeMs };
}

// ─── CLI entry (node memory.mjs index) ───────────────────────────────────────

let runDirect = false;
try {
  const { realpathSync } = await import("node:fs");
  runDirect =
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* not run directly */ }

if (runDirect && process.argv[2] === "index") {
  // .env loader (never overrides real env)
  const envPath = path.join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  }

  if (!process.env.NIM_API_KEY) {
    console.log("NIM_API_KEY not set — nothing to index (summaries need an agent).");
    process.exit(0);
  }

  let limit = 15, force = false, graceMs = 120_000;
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--limit" && process.argv[i + 1]) limit = parseInt(process.argv[++i], 10) || 15;
    if (process.argv[i] === "--grace" && process.argv[i + 1]) graceMs = parseInt(process.argv[++i], 10) || 0;
    if (process.argv[i] === "--force") force = true;
  }

  try {
    const agents = await import("./providers/agents.mjs");
    const agentName = process.env.CLAUDBOT_SUMMARY_AGENT || "fast";
    const { indexed, pruned, total } = await indexSessions({
      runAgent: agents.runAgent, agentName, limit, force, graceMs, log: console.log,
    });
    console.log(`done: indexed ${indexed}, pruned ${pruned} of ${total} sessions`);
    process.exit(0);
  } catch (e) {
    console.error("index failed:", e.message);
    process.exit(1);
  }
}
