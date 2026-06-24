#!/usr/bin/env node
/**
 * Claudbot launcher
 *
 * Runs Claude Code interactively (full TTY, no auth issues).
 * When Claude exits due to a rate limit, falls back to a NIM REPL.
 * Sub-agents are handled by the claudbot-exec MCP server loaded by Claude.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── paths ───────────────────────────────────────────────────────────────────

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");
const RESTRICT_FILE = path.join(CLAUDBOT_ROOT, "restrictions.yaml");

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

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Wire up the claudbot-exec MCP server so Claude Code always loads it.
 *
 * Claude Code's settings.json has NO `mcpServers` field — that config is
 * silently ignored. Project-scoped MCP servers must live in a `.mcp.json`
 * at the working directory, and must be pre-approved (trusted) or Claude
 * prompts before loading them. We do both here, using an absolute path so
 * it works no matter where the repo is cloned.
 */
function patchSettings() {
  const execPath = path.join(ROOT, "mcp-servers", "claudbot-exec", "index.mjs");

  // 1. Declare the server in .mcp.json at the cwd Claude runs in.
  const mcpJsonPath = path.join(CLAUDBOT_ROOT, ".mcp.json");
  let mcpJson = {};
  try { mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8")); } catch { /* first run */ }
  mcpJson.mcpServers = mcpJson.mcpServers ?? {};
  mcpJson.mcpServers["claudbot-exec"] = {
    command: "node",
    args: [execPath],
    env: {},
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));

  // 2. Pre-approve it in settings.json so it loads with no trust prompt.
  const settingsPath = path.join(CLAUDBOT_ROOT, ".claude", "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* first run */ }

  // Drop the old (ignored) mcpServers block if a previous build wrote one.
  delete settings.mcpServers;

  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  enabled.add("claudbot-exec");
  settings.enabledMcpjsonServers = [...enabled];

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// Load .env into process.env so Claude Code and its MCP servers inherit API keys
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

function parseArgs() {
  const argv = process.argv.slice(2);
  const modeIdx = argv.indexOf("--mode");
  const mode = modeIdx !== -1 ? argv[modeIdx + 1] : (process.env.CLAUDBOT_DEFAULT_MODE ?? "full");
  if (!MODE_FLAGS[mode]) {
    console.error(`[claudbot] Unknown mode "${mode}". Valid: ${Object.keys(MODE_FLAGS).join(", ")}`);
    process.exit(1);
  }
  return mode;
}

function loadDisallowedTools() {
  if (!existsSync(RESTRICT_FILE)) return [];
  try {
    const data = yamlParse(readFileSync(RESTRICT_FILE, "utf8"));
    return (data?.deny ?? []).flatMap((r) => ["--disallowed-tools", String(r)]);
  } catch {
    return [];
  }
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

// ─── NIM fallback REPL ───────────────────────────────────────────────────────

async function nimRepl() {
  const { NimProvider } = await import("./providers/nim.mjs");
  const nim = new NimProvider();

  console.log("\n[claudbot] NIM fallback active. Claude Code hit its rate limit.");
  console.log("           Type prompts below, or Ctrl+C to exit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("SIGINT", () => {
    console.log("\n[claudbot] Bye.");
    process.exit(0);
  });

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
      } catch (err) {
        console.error(`\n[nim] Error: ${err.message}`);
      }
      process.stdout.write("\n");
      prompt();
    });
  };

  prompt();
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(path.join(CLAUDBOT_ROOT, "CLAUDE.md"))) {
    console.error(
      `[claudbot] .claudbot/CLAUDE.md not found.\n` +
      `  Run from the Claudbot repo root, or run: npm run onboard`
    );
    process.exit(1);
  }

  loadDotEnv();
  const mode = parseArgs();
  patchSettings();
  printBanner(mode);

  const args = [
    ...MODE_FLAGS[mode],
    ...loadDisallowedTools(),
  ];

  // Spawn Claude Code with the real terminal — stdio: inherit gives it a proper
  // TTY so auth reads from ~/.claude/credentials with no subprocess weirdness.
  const claude = spawn("claude", args, {
    cwd: CLAUDBOT_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  claude.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("\n[claudbot] `claude` not found. Install it:");
      console.error("  npm install -g @anthropic-ai/claude-code");
    } else {
      console.error(`\n[claudbot] Failed to start Claude Code: ${err.message}`);
    }
    process.exit(1);
  });

  claude.on("exit", async (code, signal) => {
    // Clean exit (user typed /exit or Ctrl+C)
    if (signal === "SIGINT" || code === 0) {
      process.exit(0);
    }

    // Non-zero exit usually means rate limit or auth error — offer NIM
    console.log(`\n[claudbot] Claude Code exited (code ${code}).`);
    await nimRepl();
  });
}

main().catch((err) => {
  console.error("[claudbot] Fatal:", err);
  process.exit(1);
});
