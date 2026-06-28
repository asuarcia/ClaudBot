#!/usr/bin/env node
/**
 * Claudbot CLI
 *
 * Usage:
 *   claudbot                   start the agent (default)
 *   claudbot start             same as above
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

function patchSettings() {
  const execPath    = path.join(ROOT, "mcp-servers", "claudbot-exec", "index.mjs");
  const mcpJsonPath = path.join(CLAUDBOT_ROOT, ".mcp.json");
  let mcpJson = {};
  try { mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8")); } catch { /* first run */ }
  mcpJson.mcpServers = mcpJson.mcpServers ?? {};
  mcpJson.mcpServers["claudbot-exec"] = { command: "node", args: [execPath], env: {} };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));

  const settingsPath = path.join(CLAUDBOT_ROOT, ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* first run */ }
  delete settings.mcpServers;
  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  enabled.add("claudbot-exec");
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
  console.log(`  ${C.dim}${"─".repeat(60)}${C.reset}\n`);
}

// ─── commands ────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
  claudbot <command> [options]

  Commands:
    start              Launch the agent  (default when no command given)
      --mode <mode>    Permission mode: full | auto | safe | readonly
    restart            Restart the running agent without closing the terminal
    channels           Start WhatsApp / Telegram webhook server
    dream              Run background tasks once
    dream --watch      Run background tasks on a schedule
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

async function nimRepl() {
  const { NimProvider } = await import("./providers/nim.mjs");
  const nim = new NimProvider();
  const model = process.env.NIM_MODEL ?? "nim";

  if (!nim.isConfigured) {
    console.error(
      `\n  ${C.yellow}⚠${C.reset}  NIM fallback is not configured (NIM_API_KEY missing).\n` +
      `      Run ${C.cyan}claudbot onboard${C.reset} to set it up, then restart.\n`
    );
    process.exit(1);
  }

  nimBanner();

  // Conversation history so the fallback feels continuous, not amnesiac
  const persona = loadPersona();
  const history = persona ? [{ role: "system", content: persona }] : [];

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

      console.log();
      const stopSpinner = startSpinner(model);
      let firstChunk = true;
      let reply = "";

      try {
        for await (const event of nim.query(trimmed, { history })) {
          const text = event.type === "assistant_text" || event.type === "text" ? event.text : null;
          if (!text) continue;
          if (firstChunk) {
            stopSpinner();
            process.stdout.write(`  ${C.dim}${"─".repeat(58)}${C.reset}\n  `);
            firstChunk = false;
          }
          reply += text;
          process.stdout.write(text.replace(/\n/g, "\n  ")); // indent wrapped lines
        }
        if (!firstChunk) {
          process.stdout.write(`\n  ${C.dim}${"─".repeat(58)}${C.reset}\n`);
          // Keep the exchange in history (trim to avoid unbounded growth)
          history.push({ role: "user", content: trimmed });
          history.push({ role: "assistant", content: reply });
          while (history.length > 21) history.splice(persona ? 1 : 0, 2);
        }
      } catch (err) {
        stopSpinner();
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

async function cmdStart(argv) {
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
  printBanner(modeArg);

  const claudeArgs = [...MODE_FLAGS[modeArg], ...loadDisallowedTools()];

  // Whether a NIM fallback is even possible — without a key, killing a working
  // Claude session to drop into a dead REPL would be worse than the limit itself.
  const nimAvailable = Boolean(process.env.NIM_API_KEY);

  // Spawn Claude and keep restarting whenever the restart flag is set
  const startClaude = async () => {
    const claude = spawn("claude", claudeArgs, {
      cwd: CLAUDBOT_ROOT,
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
      ? watchForRateLimit(CLAUDBOT_ROOT, Date.now(), () => {
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

// ─── router ──────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const cmd  = argv.find((a) => !a.startsWith("-")) ?? "start";
  const rest  = argv.filter((a) => a !== cmd);

  switch (cmd) {
    case "start":    return cmdStart(rest);
    case "restart":  return cmdRestart();
    case "channels": return runScript("channel-server.mjs", rest);
    case "dream":    return runScript("dream.mjs", rest);
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
