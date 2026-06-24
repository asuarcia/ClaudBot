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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import readline from "node:readline";
import path from "node:path";
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

function printBanner(mode) {
  console.log(`
  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ██████╗  ██████╗ ████████╗
 ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝
 ██║     ██║     ███████║██║   ██║██║  ██║██████╔╝██║   ██║   ██║
 ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══██╗██║   ██║   ██║
 ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝██████╔╝╚██████╔╝   ██║
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝   ╚═╝
`);
  console.log(`  Mode: ${MODE_LABELS[mode]}  |  Backend: Claude Code  |  Fallback: NIM`);
  console.log(`  Sub-agents: claudbot-exec MCP  |  Memory: Obsidian\n`);
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

// ─── NIM fallback REPL ───────────────────────────────────────────────────────

async function nimRepl() {
  const { NimProvider } = await import("./providers/nim.mjs");
  const nim = new NimProvider();

  console.log("\n[claudbot] NIM fallback active. Claude Code hit its rate limit.");
  console.log("           Type prompts below, or Ctrl+C to exit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("SIGINT", () => { console.log("\n[claudbot] Bye."); process.exit(0); });

  const prompt = () => {
    rl.question(" claudbot (nim)> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }
      process.stdout.write("\n");
      try {
        for await (const event of nim.query(trimmed)) {
          if (event.type === "assistant_text") process.stdout.write(event.text);
          if (event.type === "text")           process.stdout.write(event.text);
        }
      } catch (err) { console.error(`\n[nim] Error: ${err.message}`); }
      process.stdout.write("\n");
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

  // Spawn Claude and keep restarting whenever the restart flag is set
  const startClaude = async () => {
    const claude = spawn("claude", claudeArgs, {
      cwd: CLAUDBOT_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    // Write PID so `claudbot restart` can signal this process
    try { writeFileSync(PID_FILE, String(claude.pid)); } catch { /* non-fatal */ }

    claude.on("error", (err) => {
      rmSync(PID_FILE, { force: true });
      if (err.code === "ENOENT") {
        console.error("\n[claudbot] `claude` not found. Install: npm install -g @anthropic-ai/claude-code");
      } else {
        console.error(`\n[claudbot] Failed to start: ${err.message}`);
      }
      process.exit(1);
    });

    claude.on("exit", async (code, signal) => {
      rmSync(PID_FILE, { force: true });

      // Restart requested from another terminal
      if (existsSync(RESTART_FLAG)) {
        rmSync(RESTART_FLAG, { force: true });
        console.log("\n[claudbot] Restarting…\n");
        return startClaude();
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
