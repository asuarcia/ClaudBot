#!/usr/bin/env node
/**
 * Claudbot CLI
 *
 * Usage:
 *   claudbot                   interactive menu (default in a terminal)
 *   claudbot start             launch the agent directly (skips the menu)
 *   claudbot start --mode auto with a specific permission mode
 *   claudbot channels          start WhatsApp/Telegram channel server
 *   claudbot dream             run background dream tasks once
 *   claudbot dream --watch     run dream tasks on a schedule
 *   claudbot onboard           run the setup wizard
 *   claudbot update            pull latest code + reinstall deps
 *   claudbot doctor            health check
 *   claudbot help              show this list
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
  readdirSync, statSync, openSync, readSync, closeSync,
} from "node:fs";
import { parse as yamlParse } from "yaml";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ─── paths ───────────────────────────────────────────────────────────────────

const ROOT           = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT  = path.join(ROOT, ".claudbot");
const RESTRICT_FILE  = path.join(CLAUDBOT_ROOT, "restrictions.yaml");
const PID_FILE       = path.join(CLAUDBOT_ROOT, ".pid");       // claude child PID
const RESTART_FLAG   = path.join(CLAUDBOT_ROOT, ".restart");   // restart requested

// ─── mode flags ──────────────────────────────────────────────────────────────

const MODE_FLAGS = {
  full:     ["--dangerously-skip-permissions"],
  auto:     ["--permission-mode", "auto"],
  safe:     ["--permission-mode", "acceptEdits"],
  readonly: ["--permission-mode", "plan"],
};

const MODE_LABELS = {
  full:     "full (no prompts)",
  auto:     "auto (asks for risky ops)",
  safe:     "safe (asks before bash)",
  readonly: "read-only",
};

// ─── shared helpers ──────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}

function loadDisallowedTools() {
  if (!existsSync(RESTRICT_FILE)) return [];
  try {
    const data = yamlParse(readFileSync(RESTRICT_FILE, "utf8"));
    return (data?.deny ?? []).flatMap((r) => ["--disallowed-tools", String(r)]);
  } catch { return []; }
}

// MCP servers Claudbot owns and keeps registered on every launch. Claude Code
// ignores settings.json.mcpServers entirely — servers must be in .mcp.json AND
// listed in enabledMcpjsonServers, or they load with a trust prompt (or not at all).
const OWNED_MCP_SERVERS = ["claudbot-exec", "device-control"];

function patchSettings() {
  const mcpJsonPath = path.join(CLAUDBOT_ROOT, ".mcp.json");
  let mcpJson = {};
  try { mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8")); } catch { /* first run */ }
  mcpJson.mcpServers = mcpJson.mcpServers ?? {};
  for (const name of OWNED_MCP_SERVERS) {
    mcpJson.mcpServers[name] = {
      command: "node",
      args: [path.join(ROOT, "mcp-servers", name, "index.mjs")],
      env: {},
    };
  }
  writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));

  const settingsPath = path.join(CLAUDBOT_ROOT, ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* first run */ }
  delete settings.mcpServers;
  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  for (const name of OWNED_MCP_SERVERS) enabled.add(name);
  settings.enabledMcpjsonServers = [...enabled];
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// Run another script in this repo, inheriting stdio
function runScript(scriptFile, extraArgs = []) {
  const result = spawnSync("node", [path.join(ROOT, scriptFile), ...extraArgs], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

// Open a URL in the default browser (best-effort, cross-platform).
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch { /* the URL is printed by the server anyway */ }
}

// Serve the organizer and pop it open once it's listening. Runs the server
// async (not spawnSync) so the readiness poll can fire while it's up.
function cmdOrganizer(rest = []) {
  const portIdx = rest.indexOf("--port");
  const port = portIdx !== -1 ? rest[portIdx + 1] : (process.env.ORGANIZER_PORT ?? "4700");
  const url = `http://localhost:${port}`;
  const child = spawn("node", [path.join(ROOT, "organizer.mjs"), ...rest], { stdio: "inherit", env: process.env });
  (async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try { if ((await fetch(`${url}/health`)).ok) return openBrowser(url); } catch { /* not up yet */ }
    }
  })();
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ─── banner ──────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  yellow: "\x1b[33m",
  green:  "\x1b[32m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  white:  "\x1b[97m",
  bgCyan: "\x1b[46m",
  bgYellow:"\x1b[43m",
};

function printBanner(mode) {
  const cc = `${C.cyan}${C.bold}`;
  console.log(`${cc}
  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ██████╗  ██████╗ ████████╗
 ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝
 ██║     ██║     ███████║██║   ██║██║  ██║██████╔╝██║   ██║   ██║
 ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══██╗██║   ██║   ██║
 ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝██████╔╝╚██████╔╝   ██║
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝   ╚═╝${C.reset}
`);

  const modeColor = mode === "full" ? C.yellow : mode === "readonly" ? C.dim : C.green;
  console.log(
    `  ${C.bold}${C.white}●${C.reset} ${C.bold}${C.cyan}CLAUDE CODE${C.reset}  ${C.dim}│${C.reset}  ` +
    `mode ${modeColor}${C.bold}${mode}${C.reset}  ${C.dim}│${C.reset}  ` +
    `fallback ${C.dim}NIM${C.reset}  ${C.dim}│${C.reset}  ` +
    `agents ${C.dim}claudbot-exec${C.reset}`
  );
  printScreenIndicator();
  console.log(`  ${C.dim}${"─".repeat(60)}${C.reset}\n`);
}

// Screen capture must never be invisible. If the watcher is live, say so on
// every launch — not just in `screen status`.
function printScreenIndicator() {
  try {
    const state = JSON.parse(
      readFileSync(path.join(CLAUDBOT_ROOT, "screen", "state.json"), "utf8"),
    );
    if (!state.enabled) return;
    console.log(
      `  ${C.bold}\x1b[31m●${C.reset} ${C.bold}SCREEN AWARENESS IS ON${C.reset}  ` +
      `${C.dim}│${C.reset}  your screen is being captured  ${C.dim}│${C.reset}  ` +
      `${C.dim}claudbot screen off${C.reset}`,
    );
  } catch { /* off, or never used */ }
}

// ─── commands ────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
  claudbot <command> [options]

  Commands:
    menu               Interactive Claudbot menu  (default in a terminal)
    start              Launch the agent directly, skipping the menu
      --mode <mode>    Permission mode: full | auto | safe | readonly
    restart            Restart the running agent without closing the terminal
    recall             List past sessions (where you left off)
    recall last        Summarize the previous session
    recall <text>      Search past sessions for <text>
    channels           Start WhatsApp / Telegram webhook server
    dream              Run background tasks once
    dream --watch      Run background tasks on a schedule
    briefing           Build the morning news-to-learn digest once
    briefing --watch   Rebuild the digest on a schedule
    dashboard          Serve the morning command center (http://localhost:4500)
    organizer          Open your assistant home — tasks, calendar & news (http://localhost:4700)
    voice              Talk to Claudbot — wake word, English + Spanish
    voice setup        Install the voice subsystem (venv + dependencies)
    voice devices      List microphones and speakers
    voice train        Train the bilingual "Hey Aitor" wake word
    screen on|off      Let Claude see your screen (off by default)
    screen now         Capture and describe the screen right now
    project            Pick a project chat (remembers that repo)
    project <path>     Open a project-scoped chat for that repo
    project list       List every project chat
    night              Run all idle processes together (dream + briefing + dashboard)
    onboard            Run the interactive setup wizard
    update             Pull latest code from GitHub + reinstall deps
    doctor             Check that everything is configured correctly
    help               Show this message

  Examples:
    claudbot
    claudbot start --mode auto
    claudbot restart
    claudbot channels
    claudbot dream --watch
    claudbot update
`);
}

async function cmdDoctor() {
  const ok  = (msg) => console.log(`  ✓  ${msg}`);
  const warn = (msg) => console.log(`  ⚠  ${msg}`);
  const fail = (msg) => console.log(`  ✗  ${msg}`);

  console.log("\n[claudbot doctor]\n");

  // Claude Code
  const claudeStatus = spawnSync("claude", ["auth", "status", "--text"], { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  const claudeOut = (claudeStatus.stdout ?? "") + (claudeStatus.stderr ?? "");
  if (claudeStatus.status === 0 && !claudeOut.includes("not logged")) {
    ok("Claude Code authenticated");
  } else {
    fail("Claude Code not authenticated — run: claude auth login");
  }

  // NIM key
  const nimKey = process.env.NIM_API_KEY;
  if (nimKey) {
    ok(`NIM_API_KEY set (${nimKey.slice(0, 8)}…)`);
    // Quick connectivity check
    try {
      const nimBase = (process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
      const res = await fetch(`${nimBase}/models`, { headers: { Authorization: `Bearer ${nimKey}` } });
      if (res.ok) ok("NIM endpoint reachable");
      else        warn(`NIM endpoint returned ${res.status}`);
    } catch {
      warn("NIM endpoint unreachable — check your connection");
    }
  } else {
    fail("NIM_API_KEY not set — fallback provider and channels will not work");
  }

  // Config files
  const checks = [
    [path.join(CLAUDBOT_ROOT, "CLAUDE.md"),           "CLAUDE.md persona"],
    [path.join(CLAUDBOT_ROOT, "restrictions.yaml"),   "restrictions.yaml"],
    [path.join(CLAUDBOT_ROOT, "agents.yaml"),         "agents.yaml"],
    [path.join(CLAUDBOT_ROOT, ".claude", "settings.json"), "settings.json"],
  ];
  for (const [filePath, label] of checks) {
    if (existsSync(filePath)) ok(label);
    else warn(`${label} missing — run: claudbot onboard`);
  }

  // MCP server
  const mcpIndex = path.join(ROOT, "mcp-servers", "claudbot-exec", "index.mjs");
  if (existsSync(mcpIndex)) ok("claudbot-exec MCP server present");
  else fail("claudbot-exec MCP server missing — run: npm run setup");

  // Agents
  const agentsPath = path.join(CLAUDBOT_ROOT, "agents.yaml");
  if (existsSync(agentsPath)) {
    try {
      const data = yamlParse(readFileSync(agentsPath, "utf8"));
      const count = (data?.agents ?? []).length;
      count > 0 ? ok(`${count} sub-agent(s) registered`) : warn("No sub-agents registered — add some via: claudbot onboard");
    } catch { warn("agents.yaml is malformed"); }
  }

  // Channels
  const hasTwilio   = Boolean(process.env.TWILIO_ACCOUNT_SID);
  const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  if (hasTwilio)   ok("Twilio/WhatsApp credentials set");
  else             warn("Twilio credentials not set — WhatsApp channels inactive");
  if (hasTelegram) ok("Telegram bot token set");
  else             warn("TELEGRAM_BOT_TOKEN not set — Telegram channel inactive");

  console.log();
}

async function cmdUpdate() {
  console.log("\n[claudbot update]\n");

  // Check git is available
  const gitCheck = spawnSync("git", ["--version"], { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  if (gitCheck.status !== 0) {
    console.error("  ✗  git not found");
    process.exit(1);
  }

  // Show current commit before pull
  const before = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: ROOT, stdio: ["pipe","pipe","pipe"] });
  console.log(`  Current: ${before.stdout.trim()}`);

  // Pull
  console.log("  Pulling from GitHub…");
  const pull = spawnSync("git", ["pull"], { cwd: ROOT, stdio: "inherit" });
  if (pull.status !== 0) {
    console.error("\n  ✗  git pull failed. Check for local changes: git status");
    process.exit(1);
  }

  // Show new commit
  const after = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: ROOT, stdio: ["pipe","pipe","pipe"] });
  if (before.stdout.trim() === after.stdout.trim()) {
    console.log("\n  Already up to date.");
  } else {
    console.log(`\n  Updated to: ${after.stdout.trim()}`);

    // Show what changed
    const log = spawnSync("git", ["log", "--oneline", `${before.stdout.trim()}..HEAD`], {
      encoding: "utf8", cwd: ROOT, stdio: ["pipe","pipe","pipe"],
    });
    if (log.stdout.trim()) {
      console.log("\n  Changes:");
      for (const line of log.stdout.trim().split("\n")) {
        console.log(`    ${line}`);
      }
    }
  }

  // Reinstall deps
  console.log("\n  Installing dependencies…");
  const install = spawnSync("npm", ["run", "setup"], { cwd: ROOT, stdio: "inherit", shell: true });
  if (install.status !== 0) {
    console.error("\n  ✗  npm install failed");
    process.exit(1);
  }

  console.log("\n  ✓  Claudbot is up to date.\n");
}

// ─── recall command (conversation memory) ────────────────────────────────────
//
// Browse / search past Claudbot sessions so you can pick up where you left off
// after a reboot. Backed by memory.mjs, which parses Claude Code's own JSONL
// transcripts (no extra capture needed).

async function cmdRecall(argv) {
  const mem = await import("./memory.mjs");
  const agents = await import("./providers/agents.mjs");
  const sub = (argv.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  const query = argv.filter((a) => !a.startsWith("-")).join(" ").trim();

  // `recall last` / `recall resume` — a richer LLM summary of the previous session.
  if (sub === "last" || sub === "resume") {
    const [last] = mem.listSessions({ limit: 1 });
    if (!last) { console.log("\n  No past sessions found yet.\n"); return; }
    console.log(`\n  ${C.cyan}${C.bold}Where we left off${C.reset}  ${C.dim}· ${mem.relativeTime(last.end)} · ${mem.shortId(last.id)}${C.reset}\n`);
    const haveKey = Boolean(process.env.NIM_API_KEY);
    const sumAgent = process.env.CLAUDBOT_SUMMARY_AGENT || "fast";
    if (haveKey) process.stdout.write(`  ${C.dim}(summarizing via ${sumAgent}…)${C.reset}\r`);
    const summary = await mem.summarizeSession(last, {
      runAgent: haveKey ? agents.runAgent : null,
      agentName: sumAgent,
    });
    process.stdout.write("\x1b[K");
    console.log(summary.split("\n").map((l) => "  " + l).join("\n"));
    console.log();
    return;
  }

  // `recall <query>` — full-text search across all past sessions.
  if (query && sub !== "list") {
    const hits = mem.searchSessions(query);
    if (hits.length === 0) { console.log(`\n  No sessions mention "${query}".\n`); return; }
    console.log(`\n  ${C.bold}${hits.length} session(s) mention "${query}"${C.reset}\n`);
    for (const h of hits) {
      console.log(`  ${C.green}${mem.shortId(h.id)}${C.reset}  ${C.dim}${mem.relativeTime(h.end)} · ${h.matches} match(es)${C.reset}`);
      console.log(`    ${C.white}${h.topic}${C.reset}`);
      if (h.snippet) console.log(`    ${C.dim}${h.snippet}${C.reset}`);
      console.log();
    }
    return;
  }

  // `recall` / `recall list` — list recent sessions.
  const sessions = mem.listSessions({ limit: 12 });
  if (sessions.length === 0) { console.log("\n  No past sessions found yet.\n"); return; }
  console.log(`\n  ${C.bold}Recent Claudbot sessions${C.reset}  ${C.dim}(newest first)${C.reset}\n`);
  for (const s of sessions) {
    console.log(`  ${C.green}${mem.shortId(s.id)}${C.reset}  ${C.dim}${mem.relativeTime(s.end).padEnd(8)} · ${s.userTurns} turn(s)${C.reset}`);
    console.log(`    ${C.white}${s.topic}${C.reset}`);
  }
  console.log(`\n  ${C.dim}→ ${C.reset}${C.cyan}claudbot recall last${C.reset}${C.dim} for a summary of where you left off, or ${C.reset}${C.cyan}claudbot recall <text>${C.reset}${C.dim} to search.${C.reset}\n`);
}

// Compact "where we left off" banner shown at the top of `claudbot start`.
// Prefers the cached LLM summary that the background indexer maintains
// (instant — no network at startup); falls back to the raw heuristic.
async function printLastSessionBanner() {
  try {
    const mem = await import("./memory.mjs");
    const [last] = mem.listSessions({ limit: 1 });
    if (!last) return;

    const W = 62; // inner width between the box borders
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const fit = (s) => (s.length > W ? s.slice(0, W - 1) + "…" : s).padEnd(W);

    const rel = mem.relativeTime(last.end);
    const head = `Last session · ${rel} `;
    const topic = clean(last.topic);

    console.log(`  ${C.dim}┌─ ${C.bold}${head}${C.reset}${C.dim}${"─".repeat(Math.max(0, W - head.length))}─┐${C.reset}`);
    console.log(`  ${C.dim}│${C.reset} ${C.white}${fit(topic)}${C.reset} ${C.dim}│${C.reset}`);

    const cached = mem.cachedSummary(last.id);
    if (cached && cached.mtimeMs === last.mtimeMs && cached.summary) {
      // Fresh auto-indexed summary — show up to 3 lines of it.
      for (const l of cached.summary.split("\n").filter(Boolean).slice(0, 3)) {
        console.log(`  ${C.dim}│ ${fit(clean(l))} │${C.reset}`);
      }
    } else {
      // Heuristic fallback until the background indexer catches up.
      const next = clean(last.lastUser);
      if (next && next !== topic) {
        console.log(`  ${C.dim}│${C.reset} ${C.dim}${fit("last: " + next)}${C.reset} ${C.dim}│${C.reset}`);
      }
    }
    console.log(`  ${C.dim}└${"─".repeat(W + 2)}┘${C.reset}`);
    console.log(`  ${C.cyan}claudbot recall last${C.reset}${C.dim} to resume where you left off.${C.reset}\n`);
  } catch { /* memory is best-effort — never block startup */ }
}

// Fire-and-forget background pass that keeps conversation-index.json fresh.
// Detached so it survives claudbot exiting; graceMs=0 right after a session
// ends (the transcript is final), default grace while one may still be live.
function spawnMemoryIndexer({ graceMs } = {}) {
  try {
    const args = [path.join(ROOT, "memory.mjs"), "index"];
    if (graceMs !== undefined) args.push("--grace", String(graceMs));
    spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env }).unref();
  } catch { /* indexing is best-effort */ }
}

// Fire-and-forget pull of the night VM's dream log into the local one
// (no-op unless CLAUDBOT_NIGHT_URL is set — see night-sync.mjs).
function spawnNightSync() {
  try {
    spawn(process.execPath, [path.join(ROOT, "night-sync.mjs")], {
      detached: true, stdio: "ignore", env: process.env,
    }).unref();
  } catch { /* sync is best-effort */ }
}

// ─── rate-limit watchdog (interactive agent) ─────────────────────────────────
//
// The interactive agent runs Claude Code as a full TUI with stdio:"inherit", so
// the parent can't read its output to detect a usage limit the way the headless
// dream path does. Instead we tail Claude's own session transcript (a JSONL file
// under ~/.claude/projects/<encoded-cwd>/) out-of-band. When Claude hits the
// subscription limit it writes an `isApiErrorMessage` entry like:
//   "You've hit your session limit · resets 2:10am"
// We watch for that and hand off to the NIM fallback — without touching the TUI.

const LIMIT_PATTERNS = [
  /hit your (session|weekly|daily|usage|5-?hour) limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /reached your .*limit/i,
];

function looksLikeUsageLimit(text) {
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

// Claude Code stores each project's transcripts in a directory whose name is the
// absolute cwd with every non-alphanumeric char replaced by a dash.
function projectDirForCwd(cwd) {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

// True if a transcript line is an API error message reporting a usage limit
// (and not, say, a 401 auth failure — those aren't transient and shouldn't
// silently swap providers).
function transcriptLineIsLimit(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return false; }
  if (entry?.isApiErrorMessage !== true) return false;
  let content = entry?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join(" ");
  }
  return typeof content === "string" && looksLikeUsageLimit(content);
}

// Poll the project's transcript dir for new lines written after `sinceMs` and
// fire `onDetected()` once a usage-limit entry appears. Returns a stop fn.
function watchForRateLimit(cwd, sinceMs, onDetected) {
  const dir = projectDirForCwd(cwd);
  const offsets = new Map(); // file -> byte offset already scanned
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return; }

    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      // Ignore transcripts from earlier sessions (a 2s slop covers clock skew).
      if (st.mtimeMs < sinceMs - 2000) continue;

      const start = offsets.get(full) ?? 0;
      if (st.size <= start) continue;

      let text;
      try {
        const fd = openSync(full, "r");
        const buf = Buffer.alloc(st.size - start);
        readSync(fd, buf, 0, buf.length, start);
        closeSync(fd);
        text = buf.toString("utf8");
      } catch { continue; }

      // Only consume up to the last complete line; leave any partial tail.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) continue;
      offsets.set(full, start + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"));

      for (const line of text.slice(0, lastNl).split("\n")) {
        if (line.trim() && transcriptLineIsLimit(line)) {
          stopped = true;
          clearInterval(timer);
          onDetected();
          return;
        }
      }
    }
  };

  const timer = setInterval(poll, 1500);
  return () => { stopped = true; clearInterval(timer); };
}

// After hard-killing the TUI, put the terminal back into a sane state (leave the
// alternate screen, restore the cursor, drop raw mode) before the NIM REPL.
function resetTerminal() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
  process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m\n");
}

// ─── NIM fallback REPL ───────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const THINKING_LABELS = [
  "thinking", "reasoning", "processing", "analyzing",
  "computing", "considering", "working on it", "generating",
];

function nimBanner() {
  console.log(`
  ${C.yellow}${C.bold}⚡ NIM FALLBACK${C.reset}  ${C.dim}│${C.reset}  ${C.dim}Claude Code rate limit hit — switched to NIM${C.reset}
  ${C.dim}${"─".repeat(60)}${C.reset}
`);
}

function startSpinner(model) {
  let frame = 0;
  let label = 0;
  const timer = setInterval(() => {
    const spin  = `${C.yellow}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${C.reset}`;
    const words = `${C.dim}${THINKING_LABELS[label % THINKING_LABELS.length]}…${C.reset}`;
    const tag   = `${C.dim}[${model}]${C.reset}`;
    process.stdout.write(`\r  ${spin}  ${words}  ${tag}   `);
    frame++;
    if (frame % SPINNER_FRAMES.length === 0) label++;
  }, 100);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K"); // clear spinner line
  };
}

// Build the system message from the Claudbot persona, if present
function loadPersona() {
  const personaPath = path.join(CLAUDBOT_ROOT, "CLAUDE.md");
  if (!existsSync(personaPath)) return null;
  try { return readFileSync(personaPath, "utf8"); } catch { return null; }
}

// Tools the fallback exposes to the NIM model so it can delegate to sub-agents,
// just like Claude Code does via the claudbot-exec MCP.
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List the registered sub-agents you can delegate to, with their specialties.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_agent",
      description:
        "Delegate a self-contained task to a named sub-agent and get its response. " +
        "The sub-agent has no prior context — put everything it needs in `prompt`.",
      parameters: {
        type: "object",
        properties: {
          name:   { type: "string", description: "Agent name from the registry (e.g. 'researcher', 'nemotron')." },
          prompt: { type: "string", description: "The full task or question for the agent." },
        },
        required: ["name", "prompt"],
      },
    },
  },
];

async function nimRepl() {
  const { NimProvider } = await import("./providers/nim.mjs");
  const agents = await import("./providers/agents.mjs");

  // The fallback REPL runs on a dedicated agent (default: `agent` = Kimi K2.6),
  // chosen separately from the dream agent so a rate-limit event and a dream
  // cycle never contend for the same model. Resolved from the registry by name
  // via CLAUDBOT_FALLBACK_AGENT; falls back to NIM_MODEL if unregistered.
  const fbAgent = agents.resolveAgent("CLAUDBOT_FALLBACK_AGENT", "agent");
  const model   = fbAgent?.model ?? process.env.NIM_MODEL ?? "nim";
  const nim = new NimProvider({
    model:   fbAgent?.model,
    baseUrl: fbAgent?.endpoint,
    apiKey:  agents.agentApiKey(fbAgent) ?? process.env.NIM_API_KEY,
  });

  if (!nim.isConfigured) {
    console.error(
      `\n  ${C.yellow}⚠${C.reset}  NIM fallback is not configured (NIM_API_KEY missing).\n` +
      `      Run ${C.cyan}claudbot onboard${C.reset} to set it up, then restart.\n`
    );
    process.exit(1);
  }

  nimBanner();

  // Tell the fallback which sub-agents it can delegate to (parity with Claude Code).
  const roster = agents.describeAgents();
  const haveAgents = roster.length > 0;
  if (haveAgents) {
    console.log(`  ${C.dim}Sub-agents available — delegate with the run_agent tool or ${C.reset}${C.cyan}/agent <name> <task>${C.reset}${C.dim}:${C.reset}`);
    console.log(`${roster.split("\n").map((l) => "  " + C.dim + l + C.reset).join("\n")}\n`);
  }

  // Conversation history so the fallback feels continuous, not amnesiac.
  const persona = loadPersona();
  const sys =
    (persona ?? "") +
    (haveAgents
      ? `\n\n## Sub-agents (delegate when useful)\nYou can delegate work to these agents with the run_agent tool. Prefer delegating research/summarization and heavy reasoning rather than doing everything yourself:\n${roster}`
      : "");
  const history = sys.trim() ? [{ role: "system", content: sys }] : [];

  async function executeToolCall(tc) {
    const fn = tc.function?.name;
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* bad args */ }
    if (fn === "list_agents") return roster || "(no agents registered)";
    if (fn === "run_agent") {
      console.log(`  ${C.magenta}↪ delegating to ${args.name}…${C.reset}`);
      return await agents.runAgent(args.name, args.prompt);
    }
    return `Unknown tool: ${fn}`;
  }

  let toolsSupported = haveAgents; // disabled if the model rejects the tools param

  // One user turn: let the model call sub-agents in a loop, then return its text.
  async function runTurn(userText) {
    const messages = [...history, { role: "user", content: userText }];
    let text = "";
    for (let i = 0; i < 6; i++) {
      const stop = startSpinner(model);
      let msg;
      try {
        msg = await nim.chat(messages, { tools: toolsSupported ? AGENT_TOOLS : undefined });
      } catch (err) {
        stop();
        if (toolsSupported && err.code === 400) { // model can't do tools — retry plain
          toolsSupported = false;
          messages.length = 0;
          messages.push(...history, { role: "user", content: userText });
          continue;
        }
        throw err;
      }
      stop();

      if (msg.tool_calls?.length) {
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          let result;
          try { result = await executeToolCall(tc); }
          catch (e) { result = `Error: ${e.message}`; }
          messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 8000) });
        }
        continue; // feed results back to the model
      }
      text = msg.content ?? "";
      break;
    }
    return text;
  }

  const printReply = (text) => {
    process.stdout.write(`  ${C.dim}${"─".repeat(58)}${C.reset}\n  `);
    process.stdout.write((text || "(no response)").replace(/\n/g, "\n  "));
    process.stdout.write(`\n  ${C.dim}${"─".repeat(58)}${C.reset}\n`);
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("SIGINT", () => {
    console.log(`\n\n  ${C.dim}Bye.${C.reset}\n`);
    process.exit(0);
  });

  const prompt = () => {
    rl.question(`  ${C.yellow}${C.bold}⚡ claudbot${C.reset} ${C.dim}(nim)${C.reset} ${C.bold}›${C.reset} `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }
      if (["/exit", "/quit", "exit", "quit"].includes(trimmed.toLowerCase())) {
        console.log(`\n  ${C.dim}Bye.${C.reset}\n`);
        process.exit(0);
      }

      // Manual delegation commands — a guaranteed path even if the model won't tool-call.
      if (trimmed === "/agents") {
        console.log(`\n${roster ? roster.split("\n").map((l) => "  " + l).join("\n") : "  (no agents registered)"}\n`);
        prompt();
        return;
      }
      const m = trimmed.match(/^\/agent\s+(\S+)\s+([\s\S]+)$/);
      if (m) {
        const [, name, task] = m;
        console.log();
        const stop = startSpinner(name);
        try {
          const out = await agents.runAgent(name, task);
          stop();
          printReply(`[${name}]\n\n${out}`);
        } catch (err) {
          stop();
          console.error(`\n  ${C.yellow}⚠${C.reset}  ${err.message}`);
        }
        console.log();
        prompt();
        return;
      }

      console.log();
      try {
        const reply = await runTurn(trimmed);
        printReply(reply);
        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: reply });
        while (history.length > 21) history.splice(history[0]?.role === "system" ? 1 : 0, 2);
      } catch (err) {
        console.error(`\n  ${C.yellow}⚠${C.reset}  ${err.message}`);
      }

      console.log();
      prompt();
    });
  };

  prompt();
}

// ─── restart command ─────────────────────────────────────────────────────────

function cmdRestart() {
  if (!existsSync(PID_FILE)) {
    console.error("[claudbot] No running instance found. Start one with: claudbot");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  if (!pid || isNaN(pid)) {
    console.error("[claudbot] PID file is invalid. Start a fresh instance: claudbot");
    process.exit(1);
  }

  // Drop the restart flag so the running instance knows to restart instead of exit
  writeFileSync(RESTART_FLAG, "");

  try {
    process.kill(pid, "SIGTERM");
    console.log(`[claudbot] Restart signal sent (PID ${pid}). Watch the other terminal.`);
  } catch (err) {
    rmSync(RESTART_FLAG, { force: true });
    if (err.code === "ESRCH") {
      console.error("[claudbot] Process not found — it may have already exited. Run: claudbot");
    } else {
      console.error(`[claudbot] Could not signal process: ${err.message}`);
    }
    process.exit(1);
  }
}

// ─── start command ───────────────────────────────────────────────────────────

async function cmdStart(argv, { project = null } = {}) {
  if (!existsSync(path.join(CLAUDBOT_ROOT, "CLAUDE.md"))) {
    console.error("[claudbot] Not set up yet. Run: claudbot onboard");
    process.exit(1);
  }

  const modeIdx = argv.indexOf("--mode");
  const modeArg = modeIdx !== -1 ? argv[modeIdx + 1] : (process.env.CLAUDBOT_DEFAULT_MODE ?? "full");
  if (!MODE_FLAGS[modeArg]) {
    console.error(`[claudbot] Unknown mode "${modeArg}". Valid: ${Object.keys(MODE_FLAGS).join(", ")}`);
    process.exit(1);
  }

  patchSettings();
  if (!argv.includes("--no-banner")) {
    printBanner(modeArg);
    // The main chat is deliberately a clean slate — no project context, no past
    // transcripts. `claudbot project <repo>` is where memory lives, and the
    // banner is opt-in via the menu's "Resume last session".
    if (argv.includes("--with-last-session")) await printLastSessionBanner();
  }
  spawnMemoryIndexer(); // keep summaries fresh on disk (not loaded into this chat)
  spawnNightSync();     // pull overnight dreams from the NUC, if configured

  if (!project && !argv.includes("--no-scratchpad-note")) {
    console.log(
      `  ${C.dim}Main chat — clean slate, no memory. ` +
      `${C.reset}${C.cyan}claudbot project <repo>${C.reset}${C.dim} for a chat that remembers.${C.reset}\n`,
    );
  }

  const claudeArgs = [...MODE_FLAGS[modeArg], ...loadDisallowedTools()];
  // A project chat runs IN the repo (so Claude sees its files and its own
  // CLAUDE.md) and carries that project's rolling memory in the system prompt.
  const cwd = project ? project.dir : CLAUDBOT_ROOT;
  if (project) claudeArgs.push("--append-system-prompt", project.context);

  // Whether a NIM fallback is even possible — without a key, killing a working
  // Claude session to drop into a dead REPL would be worse than the limit itself.
  const nimAvailable = Boolean(process.env.NIM_API_KEY);

  // Spawn Claude and keep restarting whenever the restart flag is set
  const startClaude = async () => {
    const claude = spawn("claude", claudeArgs, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    // Write PID so `claudbot restart` can signal this process
    try { writeFileSync(PID_FILE, String(claude.pid)); } catch { /* non-fatal */ }

    // Watch Claude's transcript for a usage-limit message and pre-empt it by
    // killing the TUI so the exit handler routes us into the NIM fallback. Only
    // armed when NIM is actually configured.
    let rateLimited = false;
    const stopWatch = nimAvailable
      ? watchForRateLimit(cwd, Date.now(), () => {
          if (rateLimited) return;
          rateLimited = true;
          console.log(`\n[claudbot] Claude Code usage limit reached — switching to NIM fallback…`);
          try { claude.kill("SIGTERM"); } catch { /* already gone */ }
        })
      : () => {};

    claude.on("error", (err) => {
      stopWatch();
      rmSync(PID_FILE, { force: true });
      if (err.code === "ENOENT") {
        console.error("\n[claudbot] `claude` not found. Install: npm install -g @anthropic-ai/claude-code");
      } else {
        console.error(`\n[claudbot] Failed to start: ${err.message}`);
      }
      process.exit(1);
    });

    claude.on("exit", async (code, signal) => {
      stopWatch();
      rmSync(PID_FILE, { force: true });

      // Restart requested from another terminal
      if (existsSync(RESTART_FLAG)) {
        rmSync(RESTART_FLAG, { force: true });
        console.log("\n[claudbot] Restarting…\n");
        return startClaude();
      }

      // Usage limit detected mid-session — fall back regardless of exit code/signal
      if (rateLimited) {
        resetTerminal();
        return nimRepl();
      }

      // Session over — summarize it now so recall/banner are instantly fresh
      spawnMemoryIndexer({ graceMs: 0 });

      // Clean exit — user typed /exit or Ctrl+C
      if (signal === "SIGINT" || code === 0) process.exit(0);

      // Unexpected exit — rate limit or error, fall back to NIM
      console.log(`\n[claudbot] Claude Code exited (code ${code}). Switching to NIM fallback…`);
      await nimRepl();
    });
  };

  // Clean up stale files from a previous run
  rmSync(RESTART_FLAG, { force: true });

  await startClaude();
}

// ─── project chats ───────────────────────────────────────────────────────────
//
// `claudbot` bare is one main chat with no memory — a clean scratchpad.
// `claudbot project <repo>` opens a chat scoped to that repo which remembers
// every past session there. The memory is a small rolling file, refreshed
// incrementally by the `fast` NIM agent; past transcripts are never re-read.

async function pickProject(pm) {
  const known = pm.listProjects();
  if (known.length === 0) {
    console.log(
      `\n  No project chats yet.\n\n` +
      `  ${C.cyan}claudbot project <path-to-repo>${C.reset}${C.dim} to start one.${C.reset}\n`,
    );
    return null;
  }

  console.log(`\n  ${C.bold}Project chats${C.reset} ${C.dim}(most recent first)${C.reset}\n`);
  known.forEach((p, i) => {
    const when = p.lastOpened ? new Date(p.lastOpened).toISOString().slice(0, 10) : "never";
    console.log(`  ${C.green}${i + 1}${C.reset}  ${C.white}${p.name}${C.reset}  ${C.dim}${when} · ${p.dir}${C.reset}`);
  });

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = (await rl.question(`\n  Which one? ${C.dim}(number, name, or path)${C.reset} `)).trim();
  } finally {
    rl.close();
  }
  if (!answer) return null;

  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= known.length) {
    const chosen = known[index - 1];
    return { dir: chosen.dir, name: chosen.name, slug: chosen.slug };
  }
  return pm.resolveProject(answer);
}

async function cmdProject(rest = []) {
  const pm = await import("./project-memory.mjs");
  const requested = rest.filter((a) => !a.startsWith("-")).join(" ").trim();

  if (requested === "list") {
    const known = pm.listProjects();
    if (known.length === 0) { console.log("\n  No project chats yet.\n"); return; }
    console.log(`\n  ${C.bold}Project chats${C.reset}\n`);
    for (const p of known) console.log(`  ${C.white}${p.name.padEnd(20)}${C.reset}${C.dim}${p.dir}${C.reset}`);
    console.log();
    return;
  }

  const project = requested ? pm.resolveProject(requested) : await pickProject(pm);
  if (!project) {
    if (requested) {
      console.error(
        `\n  ${C.red}Could not find a project called "${requested}".${C.reset}\n` +
        `  ${C.dim}Give a path: ${C.reset}${C.cyan}claudbot project C:\\Repo\\MyThing${C.reset}\n`,
      );
      process.exit(1);
    }
    return;
  }

  printBanner(process.env.CLAUDBOT_DEFAULT_MODE ?? "full");
  console.log(
    `  ${C.bold}${C.cyan}${project.name}${C.reset}  ${C.dim}${project.dir}${C.reset}\n` +
    `  ${C.dim}Project chat — remembers every past session here.${C.reset}`,
  );

  // Fold in anything that happened since the last time this project was opened.
  // Only new sessions are summarized, so this stays fast however long the
  // history gets.
  process.stdout.write(`  ${C.dim}refreshing memory…${C.reset}\r`);
  const result = await pm.refreshMemory(project);
  process.stdout.write("\x1b[K");
  if (result.merged > 0) {
    console.log(
      `  ${C.dim}memory updated from ${result.merged} new session(s)` +
      `${result.skipped ? `, ${result.skipped} older one(s) left out` : ""}.${C.reset}`,
    );
  } else if (result.reason && result.reason !== "nothing new") {
    console.log(`  ${C.yellow}memory not refreshed: ${result.reason}${C.reset}`);
  }

  const memory = pm.readMemory(project.slug).trim();
  if (memory) {
    console.log();
    for (const line of memory.split("\n").slice(0, 12)) {
      console.log(`  ${C.dim}${line}${C.reset}`);
    }
  }
  console.log();

  pm.markOpened(project);
  return cmdStart(["--no-banner"], {
    project: { ...project, context: pm.contextBlock(project) },
  });
}

// ─── menu (default entry point) ──────────────────────────────────────────────
//
// Bare `claudbot` in a TTY shows the Claudbot menu instead of jumping straight
// into Claude Code. `claudbot start` (or any explicit command, or a non-TTY)
// bypasses it, so scripts and systemd are unaffected.

async function cmdMenu() {
  spawnMemoryIndexer(); // keep summaries fresh while the user reads the menu
  spawnNightSync();     // pull overnight dreams from the NUC, if configured

  const { showMenu, isInteractive } = await import("./menu.mjs");
  if (!isInteractive()) return cmdStart([]);

  // Last-session card for the top of the menu (cached summary if fresh)
  let lastSession = null;
  try {
    const mem = await import("./memory.mjs");
    const [last] = mem.listSessions({ limit: 1 });
    if (last) {
      const cached = mem.cachedSummary(last.id);
      lastSession = {
        topic: last.topic,
        rel: mem.relativeTime(last.end),
        summary: cached && cached.mtimeMs === last.mtimeMs ? cached.summary : "",
      };
    }
  } catch { /* menu works without memory */ }

  const mode = process.env.CLAUDBOT_DEFAULT_MODE ?? "full";
  printBanner(mode);

  for (;;) {
    const action = await showMenu({ lastSession });
    switch (action) {
      case "start":     return cmdStart(["--no-banner"]);
      case "project":   return cmdProject([]);
      case "voice":     return runScript("voice.mjs");
      case "resume":
        await cmdRecall(["last"]);
        return cmdStart(["--no-banner", "--no-scratchpad-note"]);
      case "organizer": return cmdOrganizer();
      case "dashboard": return runScript("dashboard.mjs");
      case "briefing":  return runScript("briefing.mjs");
      case "dream":     return runScript("dream.mjs");
      case "night":     return runScript("night.mjs");
      case "update":    return cmdUpdate();
      case "exit":
        console.log(`  ${C.dim}Bye.${C.reset}\n`);
        return;
      // These return to the menu when done:
      case "recall":    await cmdRecall([]); break;
      case "doctor":    await cmdDoctor();   break;
      default:          return;
    }
  }
}

// ─── router ──────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const explicit = argv.find((a) => !a.startsWith("-"));
  const cmd  = explicit ?? (process.stdin.isTTY && process.stdout.isTTY ? "menu" : "start");
  const rest  = argv.filter((a) => a !== cmd);

  switch (cmd) {
    case "menu":     return cmdMenu();
    case "start":    return cmdStart(rest);
    case "restart":  return cmdRestart();
    case "recall":   return cmdRecall(rest);
    case "channels": return runScript("channel-server.mjs", rest);
    case "dream":    return runScript("dream.mjs", rest);
    case "briefing": return runScript("briefing.mjs", rest);
    case "dashboard":return runScript("dashboard.mjs", rest);
    case "organizer":return cmdOrganizer(rest);
    case "voice":    return runScript("voice.mjs", rest);
    case "screen":   return runScript("screen.mjs", rest);
    case "project":  return cmdProject(rest);
    case "night":    return runScript("night.mjs", rest);
    case "onboard":  return runScript("scripts/onboard.mjs", rest);
    case "update":   return cmdUpdate();
    case "doctor":   return cmdDoctor();
    case "help":
    case "--help":
    case "-h":       return cmdHelp();
    default:
      console.error(`[claudbot] Unknown command "${cmd}". Run: claudbot help`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[claudbot] Fatal:", err);
  process.exit(1);
});
