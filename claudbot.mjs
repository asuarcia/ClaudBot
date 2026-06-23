#!/usr/bin/env node
/**
 * Claudbot — autonomous agent program
 *
 * Architecture:
 *   Primary:   Claude Code (claude -p, subscription-based, no per-token cost)
 *   Fallback 1: OpenAI Codex CLI (subscription-based)
 *   Fallback 2: NVIDIA NIM endpoint (OpenAI-compatible HTTP)
 *
 * Provider switching is automatic on rate limit / quota errors.
 * Session continuity is maintained via Claude Code's --resume flag.
 *
 * Usage:
 *   node claudbot.mjs           # interactive REPL
 *   npm install -g . && claudbot
 */

import readline from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeProvider } from "./providers/claude.mjs";
import { CodexProvider } from "./providers/codex.mjs";
import { NimProvider } from "./providers/nim.mjs";
import { RateLimitError } from "./providers/base.mjs";

// ─── paths ───────────────────────────────────────────────────────────────────

const CLAUDBOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(CLAUDBOT_DIR, ".claudbot");

// ─── sanity check ────────────────────────────────────────────────────────────

if (!existsSync(path.join(CLAUDBOT_ROOT, "CLAUDE.md"))) {
  console.error(
    `[claudbot] ERROR: .claudbot/CLAUDE.md not found.\n` +
    `  Expected: ${path.join(CLAUDBOT_ROOT, "CLAUDE.md")}\n` +
    `  Run this from the Claudbot repo root.`
  );
  process.exit(1);
}

// ─── provider chain ──────────────────────────────────────────────────────────

const providers = [
  new ClaudeProvider(),
  new CodexProvider(),
  new NimProvider(),
];

let providerIdx = 0;
let sessionId = null;  // Claude Code session ID for multi-turn continuity

// ─── rendering ───────────────────────────────────────────────────────────────

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

let spinnerTimer = null;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;

function startSpinner(label) {
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${SPINNER[spinnerIdx++ % SPINNER.length]} ${label}`);
  }, 80);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    clearLine();
  }
}

/**
 * Render a stream-json event from Claude Code.
 * Returns true if the event was meaningful (i.e., something was printed).
 */
function renderEvent(event) {
  switch (event.type) {
    case "assistant": {
      // Message from Claude: extract text content
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          stopSpinner();
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          stopSpinner();
          console.log(`\n  [tool: ${block.name}]`);
        }
      }
      return true;
    }

    case "result": {
      stopSpinner();
      if (event.is_error) {
        // Error result — show the message
        const msg = event.result ?? "Unknown error";
        console.error(`\n[claude] ${msg}`);
      } else {
        // Success — text already streamed; just ensure trailing newline
        process.stdout.write("\n");
      }
      return true;
    }

    case "system": {
      if (event.subtype === "init") {
        // Session started; spinner handles the "thinking" feedback
        return false;
      }
      if (event.subtype === "error") {
        stopSpinner();
        console.error(`\n[claudbot] Claude error: ${event.error?.message ?? JSON.stringify(event.error)}`);
        return true;
      }
      return false;
    }

    case "user": {
      // Tool results flowing back into the context — no display needed
      return false;
    }

    case "assistant_text": {
      // Codex / NIM plain-text events
      stopSpinner();
      process.stdout.write(event.text);
      return true;
    }

    case "text": {
      // Raw non-JSON output from claude CLI startup
      return false;
    }

    case "_meta": {
      // Internal event from our ClaudeProvider — session ID update
      return false;
    }

    default:
      return false;
  }
}

// ─── query with automatic provider fallback ──────────────────────────────────

async function query(input) {
  while (providerIdx < providers.length) {
    const provider = providers[providerIdx];
    const providerLabel = `${provider.name}`;

    startSpinner(`${providerLabel} is thinking…`);

    try {
      for await (const event of provider.query(input, {
        sessionId: providerIdx === 0 ? sessionId : undefined,
        cwd: CLAUDBOT_ROOT,
      })) {
        // Capture updated session ID from Claude provider
        if (event.type === "_meta" && event.sessionId) {
          sessionId = event.sessionId;
        }
        renderEvent(event);
      }
      stopSpinner();
      return; // success
    } catch (err) {
      stopSpinner();
      if (err instanceof RateLimitError && providerIdx < providers.length - 1) {
        providerIdx++;
        const next = providers[providerIdx];
        console.log(
          `\n[claudbot] ${provider.name} rate limit hit. Switching to ${next.name}…`
        );
        // Note: session continuity is lost when switching providers
        sessionId = null;
        continue;
      }
      // Non-recoverable error
      console.error(`\n[claudbot] ${provider.name} error: ${err.message}`);
      if (err.stderr) console.error(err.stderr);
      return;
    }
  }
  console.error("\n[claudbot] All providers exhausted.");
}

// ─── REPL ────────────────────────────────────────────────────────────────────

function currentProviderName() {
  return providers[providerIdx]?.name ?? "none";
}

function printBanner() {
  console.log(`
  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ██████╗  ██████╗ ████████╗
 ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝
 ██║     ██║     ███████║██║   ██║██║  ██║██████╔╝██║   ██║   ██║
 ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══██╗██║   ██║   ██║
 ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝██████╔╝╚██████╔╝   ██║
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝   ╚═╝
`);
  console.log(`  Autonomous agent  |  Primary: ${currentProviderName()}`);
  console.log(`  Type your prompt and press Enter. Ctrl+C to exit.\n`);
}

async function repl() {
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Forward SIGINT cleanly
  rl.on("SIGINT", () => {
    console.log("\n[claudbot] Bye.");
    process.exit(0);
  });

  const prompt = () => {
    const providerTag = `(${currentProviderName().toLowerCase().replace(/\s+/g, "-")})`;
    rl.question(`\n claudbot ${providerTag}> `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      await query(trimmed);
      prompt();
    });
  };

  prompt();
}

// ─── entry point ─────────────────────────────────────────────────────────────

repl().catch((err) => {
  console.error("[claudbot] Fatal:", err);
  process.exit(1);
});
