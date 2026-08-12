#!/usr/bin/env node
/**
 * widgets/bridge.mjs — the data pump behind the Rainmeter desktop widgets.
 *
 * Rainmeter skins are display-only config files. They can read a file and run a
 * command, but they can't hold a secret or speak an authenticated API without
 * putting the key in a plaintext .ini sitting in Documents\. So all the real
 * work happens here, and the skins only ever read flat text files this writes.
 *
 * Two modes:
 *
 *   node widgets/bridge.mjs --watch
 *       Poll loop. Writes status.txt / stocks.txt / todo.txt into
 *       .claudbot/widgets/ on a cadence. This is what `claudbot widgets` runs.
 *
 *   node widgets/bridge.mjs action <verb> [args…]
 *       One-shot, fired by a Rainmeter click. Mutates something, refreshes the
 *       affected file, exits.
 *
 * The files are FLAT TEXT, one value per line, in a fixed order — not JSON.
 * Rainmeter parses with a regular expression, not a JSON parser, so a
 * line-per-field format collapses to a single clean (?siU) capture per widget.
 * The equivalent JSON is written alongside purely for debugging.
 *
 * Every path resolves through portable/paths.mjs. Nothing here hardcodes a
 * drive letter or a home directory.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { appDir } from "../portable/paths.mjs";

const ROOT       = appDir();
const STATE_DIR  = path.join(ROOT, ".claudbot");
const OUT_DIR    = path.join(STATE_DIR, "widgets");
const ORGANIZER  = path.join(STATE_DIR, "organizer.json");
const USAGE      = path.join(STATE_DIR, "usage.json");
const WATCHLIST  = path.join(OUT_DIR, "watchlist.json");
const NEWS_VM    = path.join(STATE_DIR, "briefing.nuc.json");
const NEWS_LOCAL = path.join(ROOT, "briefing", "data", "latest.json");
const DREAM_LOG  = path.join(STATE_DIR, "dream-log.md");
const SCREEN     = path.join(STATE_DIR, "screen", "state.json");

// ─── env ─────────────────────────────────────────────────────────────────────

// Same hand-rolled parser every other Claudbot module uses. Deliberately not
// dotenv: the app has no runtime dependency on it and this is 6 lines.
function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

const ORGANIZER_URL = `http://localhost:${process.env.ORGANIZER_PORT ?? 4700}`;
const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
const NOTION_DB     = process.env.NOTION_TASKS_DB;

const TASK_ROWS  = 6; // rows the Todo skin renders
const STOCK_ROWS = 3; // symbols the Stocks skin renders

// ─── tiny io helpers ─────────────────────────────────────────────────────────

/**
 * Atomic write — tmp file then rename, the same guarantee organizer.mjs gives
 * its state file. Without it a widget polling every second will eventually
 * catch a half-written file and render garbage.
 */
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

/**
 * Write the flat file the skin reads, plus a .json twin for debugging.
 *
 * Fields are joined with \n and the file always ends in \n — the skins' regexes
 * are anchored per line and the last capture needs its terminator.
 */
function writeWidget(name, fields, debug) {
  writeAtomic(path.join(OUT_DIR, `${name}.txt`), fields.map(sanitize).join("\n") + "\n");
  if (debug) writeAtomic(path.join(OUT_DIR, `${name}.json`), JSON.stringify(debug, null, 2));
}

/**
 * A newline in a value would shift every field after it by one line and
 * silently corrupt the whole widget, so collapse all whitespace. Rainmeter also
 * treats a leading/trailing quote oddly in some contexts; trim keeps it simple.
 */
function sanitize(v) {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

async function getJSON(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function sendJSON(method, url, body, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: c.signal,
    });
    return res.ok ? await res.json().catch(() => ({})) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clock() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function compactNum(n) {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function truncate(s, max) {
  s = String(s ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ─── widget: status ──────────────────────────────────────────────────────────

/**
 * Line order — the Status skin's regex depends on this exactly:
 *   1 organizer state   2 organizer detail
 *   3 briefing state    4 briefing detail
 *   5 dream state       6 dream detail
 *   7 screen state      8 screen detail
 *   9 usage calls      10 usage tokens     11 usage cost
 *  12 usage detail     13 updated
 *
 * "state" fields are one of up|down|idle and drive the dot colour; "detail" is
 * the right-hand text.
 */
async function buildStatus() {
  const health = await getJSON(`${ORGANIZER_URL}/health`, 1200);
  const organizerUp = Boolean(health?.ok);

  // Whichever digest is newer wins, matching organizer.mjs's loadNews().
  let briefingState = "idle", briefingDetail = "never run";
  const newsFile = [NEWS_VM, NEWS_LOCAL]
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (newsFile) {
    const news = readJSON(newsFile, null);
    const n = news?.items?.length ?? 0;
    const age = Date.now() - statSync(newsFile).mtimeMs;
    briefingState  = age < 24 * 3600e3 ? "up" : "idle";
    briefingDetail = `${n} item${n === 1 ? "" : "s"} · ${ago(age)}`;
  }

  let dreamState = "idle", dreamDetail = "never run";
  if (existsSync(DREAM_LOG)) {
    const age = Date.now() - statSync(DREAM_LOG).mtimeMs;
    dreamState  = age < 12 * 3600e3 ? "up" : "idle";
    dreamDetail = ago(age);
  }

  const screenOn = readJSON(SCREEN, null)?.enabled === true;

  const usage = usageToday();

  return {
    fields: [
      organizerUp ? "up" : "down",
      organizerUp ? `:${process.env.ORGANIZER_PORT ?? 4700}` : "not running",
      briefingState, briefingDetail,
      dreamState, dreamDetail,
      screenOn ? "up" : "idle",
      screenOn ? "watching" : "off",
      compactNum(usage.calls),
      compactNum(usage.tokens),
      usage.cost,
      usage.detail,
      clock(),
    ],
    debug: { organizerUp, briefingDetail, dreamDetail, screenOn, usage },
  };
}

/**
 * Today's slice of .claudbot/usage.json, written by providers/agents.mjs.
 *
 * Cost is only shown when a rate is configured — the NIM endpoints these agents
 * run against are credit-based, so inventing a dollar figure would be a made-up
 * number on the user's desktop. Set CLAUDBOT_USAGE_RATE_PER_MTOK to opt in.
 */
function usageToday() {
  const all = readJSON(USAGE, null);
  const day = all?.days?.[today()];
  if (!day) return { calls: 0, tokens: 0, cost: "—", detail: "no calls today" };

  let calls = 0, tokens = 0;
  const perAgent = [];
  for (const [name, a] of Object.entries(day.agents ?? {})) {
    const t = (a.promptTokens ?? 0) + (a.completionTokens ?? 0);
    calls += a.calls ?? 0;
    tokens += t;
    perAgent.push({ name, calls: a.calls ?? 0, tokens: t });
  }
  perAgent.sort((a, b) => b.calls - a.calls);

  // A rate is opt-in: the NIM endpoints are credit-based, so a dollar figure
  // nobody asked for would be a made-up number sitting on the desktop all day.
  const rate = Number(process.env.CLAUDBOT_USAGE_RATE_PER_MTOK);
  let cost = "—";
  if (Number.isFinite(rate) && rate > 0) {
    const d = (tokens / 1_000_000) * rate;
    // $0.000 reads as "free" when it really means "less than a tenth of a cent".
    cost = d === 0 ? "$0" : d < 0.01 ? "<$0.01" : `$${d.toFixed(2)}`;
  }

  const detail = perAgent.length
    ? perAgent.slice(0, 3).map((a) => `${a.name} ${a.calls}`).join("  ")
    : "no calls today";

  return { calls, tokens, cost, detail };
}

// ─── widget: stocks ──────────────────────────────────────────────────────────

const DEFAULT_WATCHLIST = ["AAPL", "NVDA", "SPY"];

function loadWatchlist() {
  const w = readJSON(WATCHLIST, null)?.symbols;
  const list = Array.isArray(w) ? w.filter((s) => typeof s === "string") : [];
  // Always exactly STOCK_ROWS entries so the skin's line offsets never shift.
  return Array.from({ length: STOCK_ROWS }, (_, i) => (list[i] || DEFAULT_WATCHLIST[i]).toUpperCase());
}

function saveWatchlist(symbols) {
  writeAtomic(WATCHLIST, JSON.stringify({ symbols }, null, 2));
}

/**
 * US equity regular session: Mon–Fri 09:30–16:00 America/New_York.
 *
 * Deriving the ET wall clock via Intl rather than a UTC offset means this stays
 * correct across daylight saving without a timezone library. Holidays aren't
 * accounted for — on a market holiday it reads "live" but Finnhub simply
 * returns the previous close, so the numbers stay truthful.
 */
function marketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function finnhubQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(FINNHUB_KEY)}`;
  const q = await getJSON(url, 6000);
  // Finnhub answers 200 with all-zero fields for an unknown symbol rather than
  // erroring, so a zero current price means "no such ticker", not "worth $0".
  if (!q || typeof q.c !== "number" || q.c === 0) return null;
  return { price: q.c, change: q.d ?? 0, pct: q.dp ?? 0, prevClose: q.pc };
}

/**
 * Line order:
 *   1 market state (live|closed|nokey|error)
 *   2 market label
 *   then per symbol: symbol, price, change text, direction (up|down|flat)
 *   last: updated
 */
async function buildStocks() {
  const symbols = loadWatchlist();

  if (!FINNHUB_KEY) {
    return {
      fields: [
        "nokey", "no API key",
        ...symbols.flatMap((s) => [s, "—", "no key", "flat"]),
        clock(),
      ],
      debug: { error: "FINNHUB_API_KEY not set", symbols },
    };
  }

  const quotes = await Promise.all(symbols.map((s) => finnhubQuote(s).catch(() => null)));
  const open = marketOpen();
  const anyOk = quotes.some(Boolean);

  const rows = symbols.flatMap((sym, i) => {
    const q = quotes[i];
    if (!q) return [sym, "—", "unavailable", "flat"];
    const dir = q.change > 0 ? "up" : q.change < 0 ? "down" : "flat";
    const sign = q.change > 0 ? "+" : "";
    return [
      sym,
      q.price.toFixed(2),
      `${sign}${q.change.toFixed(2)}  ${sign}${q.pct.toFixed(2)}%`,
      dir,
    ];
  });

  return {
    fields: [
      !anyOk ? "error" : open ? "live" : "closed",
      !anyOk ? "no data" : open ? "open" : "closed",
      ...rows,
      clock(),
    ],
    debug: { symbols, quotes, open },
  };
}

// ─── widget: todo ────────────────────────────────────────────────────────────

/**
 * Tasks, preferring the live organizer so we see anything it has synced from
 * Notion this minute. If it isn't running we read its state file directly —
 * the widget stays useful whether or not you happen to have the organizer open.
 */
async function loadTasks() {
  const state = await getJSON(`${ORGANIZER_URL}/api/state`, 1500);
  if (state) return { tasks: state.tasks ?? [], notion: Boolean(state.notion?.connected), live: true };
  const file = readJSON(ORGANIZER, null);
  return { tasks: file?.tasks ?? [], notion: Boolean(process.env.NOTION_API_KEY && NOTION_DB), live: false };
}

/**
 * The ordering rule from organizer.mjs's renderSpine(), reproduced so the
 * widget and the organizer page agree on what "next" means: overdue first,
 * then due today, then everything undated.
 */
function rankTask(t, day) {
  if (!t.due) return 2;
  if (t.due < day) return 0;   // overdue
  if (t.due === day) return 1; // due today
  return 3;                    // future
}

/**
 * Line order:
 *   1 header  2 notion state (on|off)
 *   then per row: title, meta, urgency (overdue|today|normal|empty), id
 *   last: updated
 */
async function buildTodo() {
  const { tasks, notion, live } = await loadTasks();
  const day = today();

  const open = tasks
    .filter((t) => !t.done)
    .sort((a, b) => rankTask(a, day) - rankTask(b, day) || (a.due ?? "9999").localeCompare(b.due ?? "9999"));

  const rows = Array.from({ length: TASK_ROWS }, (_, i) => {
    const t = open[i];
    if (!t) return ["", "", "empty", ""];
    const rank = rankTask(t, day);
    const meta = !t.due ? (t.source === "notion" ? "notion" : "")
      : rank === 0 ? `overdue · ${t.due.slice(5)}`
      : rank === 1 ? "today"
      : t.due.slice(5);
    return [
      truncate(t.title, 34),
      meta,
      rank === 0 ? "overdue" : rank === 1 ? "today" : "normal",
      t.id ?? "",
    ];
  });

  const header = open.length
    ? `${open.length} open${live ? "" : " · offline"}`
    : live ? "all clear" : "all clear · offline";

  return {
    fields: [header, notion ? "on" : "off", ...rows.flat(), clock()],
    debug: { open: open.length, notion, live, tasks: open.slice(0, TASK_ROWS) },
  };
}

// ─── refresh ─────────────────────────────────────────────────────────────────

const DEBUG = process.argv.includes("--debug");

async function refresh(which) {
  const jobs = {
    status: buildStatus,
    stocks: buildStocks,
    todo:   buildTodo,
  };
  const names = which ? [which] : Object.keys(jobs);
  await Promise.all(names.map(async (name) => {
    try {
      const { fields, debug } = await jobs[name]();
      writeWidget(name, fields, DEBUG ? debug : null);
    } catch (err) {
      // A widget that throws must not take the loop down with it, and must not
      // clobber the last good file — a stale price beats a blank panel.
      console.error(`[widgets] ${name} failed: ${err.message}`);
    }
  }));
}

// ─── actions (fired by Rainmeter clicks) ─────────────────────────────────────

function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch { /* nothing sensible to do from a click handler */ }
}

/**
 * Mutate a task. Goes through the organizer's API when it's up so its Notion
 * sync and in-memory state stay coherent; falls back to editing the state file
 * only when the organizer is definitively unreachable, which rules out two
 * writers racing for the same file.
 */
async function mutateTask(fn, apiCall) {
  const health = await getJSON(`${ORGANIZER_URL}/health`, 1200);
  if (health?.ok) {
    await apiCall();
    // Push the change onward to Notion. Best-effort: a sync failure must not
    // make the click look like it did nothing locally.
    if (process.env.NOTION_API_KEY && NOTION_DB) {
      await sendJSON("POST", `${ORGANIZER_URL}/api/notion/sync`, {}, 20000);
    }
    return;
  }
  const state = readJSON(ORGANIZER, { tasks: [], events: [] });
  fn(state);
  writeAtomic(ORGANIZER, JSON.stringify(state, null, 2));
}

async function runAction(verb, args) {
  switch (verb) {
    case "task-done": {
      const id = args[0];
      if (!id) return;
      await mutateTask(
        (state) => {
          const t = state.tasks?.find((x) => x.id === id);
          if (t) t.done = true;
        },
        () => sendJSON("PATCH", `${ORGANIZER_URL}/api/tasks/${encodeURIComponent(id)}`, { done: true }),
      );
      return refresh("todo");
    }

    case "task-add": {
      const title = args.join(" ").trim();
      // Rainmeter fires the action even when the input box is cancelled, which
      // arrives as an empty string. Silently ignore rather than creating a
      // blank task every time the user hits Escape.
      if (!title) return;
      await mutateTask(
        (state) => {
          (state.tasks ??= []).push({
            id: crypto.randomUUID(),
            title, notes: "", done: false, due: "",
            createdAt: new Date().toISOString(), source: "you",
          });
        },
        () => sendJSON("POST", `${ORGANIZER_URL}/api/tasks`, { title }),
      );
      return refresh("todo");
    }

    case "notion-sync": {
      await sendJSON("POST", `${ORGANIZER_URL}/api/notion/sync`, {}, 30000);
      return refresh("todo");
    }

    case "open-notion": {
      // A bare database id works as a notion.so URL; if the workspace is known
      // Notion redirects to the pretty one.
      openBrowser(NOTION_DB ? `https://www.notion.so/${NOTION_DB.replace(/-/g, "")}` : "https://www.notion.so");
      return;
    }

    case "open-organizer": {
      openBrowser(ORGANIZER_URL);
      return;
    }

    case "watchlist-set": {
      const slot = Number(args[0]);
      const symbol = (args[1] ?? "").trim().toUpperCase();
      if (!Number.isInteger(slot) || slot < 1 || slot > STOCK_ROWS) return;
      if (!symbol || !/^[A-Z0-9.:^-]{1,12}$/.test(symbol)) return; // cancelled or junk
      const list = loadWatchlist();
      list[slot - 1] = symbol;
      saveWatchlist(list);
      return refresh("stocks");
    }

    case "refresh":
      return refresh(args[0]);

    default:
      console.error(`[widgets] Unknown action "${verb}"`);
      process.exitCode = 1;
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const INTERVALS = {
  status: num(process.env.CLAUDBOT_WIDGETS_STATUS_S, 30) * 1000,
  todo:   num(process.env.CLAUDBOT_WIDGETS_TODO_S, 30) * 1000,
  // Stocks are the only network cost. 60s while the market moves is ~5% of the
  // Finnhub free tier for three symbols; 15min otherwise, since a closed
  // market's numbers can't change.
  stocksOpen:   num(process.env.CLAUDBOT_WIDGETS_STOCKS_S, 60) * 1000,
  stocksClosed: num(process.env.CLAUDBOT_WIDGETS_STOCKS_CLOSED_S, 900) * 1000,
};

async function watch() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[widgets] writing to ${OUT_DIR}`);
  console.log(`[widgets] finnhub ${FINNHUB_KEY ? "configured" : "NOT configured (stocks will show 'no key')"}`);
  console.log(`[widgets] notion  ${process.env.NOTION_API_KEY && NOTION_DB ? "configured" : "NOT configured (todo is local-only)"}`);

  await refresh();

  setInterval(() => refresh("status"), INTERVALS.status);
  setInterval(() => refresh("todo"), INTERVALS.todo);

  // Re-armed each tick rather than a fixed setInterval so the cadence follows
  // the market opening and closing without a restart.
  const tickStocks = async () => {
    await refresh("stocks");
    setTimeout(tickStocks, marketOpen() ? INTERVALS.stocksOpen : INTERVALS.stocksClosed);
  };
  setTimeout(tickStocks, marketOpen() ? INTERVALS.stocksOpen : INTERVALS.stocksClosed);

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

const argv = process.argv.slice(2);

if (argv[0] === "action") {
  await runAction(argv[1], argv.slice(2));
} else if (argv.includes("--once")) {
  mkdirSync(OUT_DIR, { recursive: true });
  await refresh();
  console.log(`[widgets] wrote status.txt, stocks.txt, todo.txt to ${OUT_DIR}`);
} else {
  await watch();
}
