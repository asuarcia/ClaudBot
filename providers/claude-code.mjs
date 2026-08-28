/**
 * Claude Code as a callable tool — the middle tier of the orchestration stack.
 *
 * Claudbot used to BE Claude Code: the TUI was the top-level agent and the NIM
 * roster hung off it through the claudbot-exec MCP. That put every casual "what
 * time is my meeting" turn on the Claude plan, and it meant the assistant's
 * identity was welded to one vendor.
 *
 * The stack is now three deep:
 *
 *     you → orchestrator (any model, via the gateway) → claude_code → NIM roster
 *
 * This module is the middle arrow. It runs `claude -p` headless and hands the
 * result back as a string, so a cheap model out front can decide when the
 * expensive, tool-wielding one is actually needed — file edits, git, builds,
 * anything touching the disk. Chat stays cheap; real work still gets the good
 * agent.
 *
 * Session continuity is the whole point of the class. A naive implementation
 * would spawn a fresh `claude -p` per call, and the sub-orchestrator would
 * forget the repo it just explored between one tool call and the next. Instead
 * one session id is minted per conversation: the first call passes
 * --session-id, every later call passes --resume, so Claude Code accumulates
 * context across the orchestrator's turns exactly like a real sub-agent would.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { claudeBin, isPortable, portableEnv } from "../portable/paths.mjs";
import { ProviderError } from "./base.mjs";

/**
 * Permission modes, named the way `claudbot start` already names them so the
 * two entry points can't drift. `full` is the default because the orchestrator
 * runs headless — there is no TUI to answer a permission prompt, so anything
 * that would ask instead hangs until the timeout kills it.
 */
export const CLAUDE_MODES = {
  full:     ["--dangerously-skip-permissions"],
  auto:     ["--permission-mode", "auto"],
  safe:     ["--permission-mode", "acceptEdits"],
  readonly: ["--permission-mode", "plan"],
};

const DEFAULT_TIMEOUT_MS = 900_000; // 15 min: real work (installs, test suites) is slow

function timeoutMs() {
  const n = Number(process.env.CLAUDBOT_CLAUDE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export class ClaudeCodeProvider {
  name = "Claude Code";

  #cwd;
  #mode;
  #model;
  #sessionId = null;   // minted on first run, reused via --resume after that
  #started = false;    // whether #sessionId has actually been created yet

  /** Running total for the conversation, surfaced in the orchestrator's status line. */
  calls = 0;
  costUsd = 0;

  constructor({ cwd = process.cwd(), mode = "full", model = null } = {}) {
    this.#cwd = cwd;
    this.#mode = CLAUDE_MODES[mode] ? mode : "full";
    this.#model = model ?? process.env.CLAUDBOT_CLAUDE_MODEL ?? null;
  }

  get sessionId() { return this.#sessionId; }
  get mode() { return this.#mode; }

  /**
   * Forget the sub-orchestrator's context. Used by the orchestrator's /reset so
   * a new topic doesn't inherit the last one's half-finished repo exploration.
   */
  reset() {
    this.#sessionId = null;
    this.#started = false;
  }

  /**
   * Ask Claude Code to do something. Returns the final assistant text.
   *
   * `onEvent` is called with short status strings ("spawning", "resuming …") so
   * the caller can render a live spinner without this module importing any UI.
   */
  async run(task, { onEvent = () => {} } = {}) {
    if (typeof task !== "string" || !task.trim()) {
      throw new ProviderError("claude_code called with an empty task.", { code: "EMPTY_TASK" });
    }

    // Mint the id up front rather than reading it back off the first result:
    // --session-id makes the id ours, which means a crashed first call can
    // still be resumed instead of orphaning its context.
    if (!this.#sessionId) this.#sessionId = randomUUID();

    const args = ["-p", task, "--output-format", "json", ...CLAUDE_MODES[this.#mode]];
    if (this.#model) args.push("--model", this.#model);
    args.push(...(this.#started ? ["--resume", this.#sessionId] : ["--session-id", this.#sessionId]));

    onEvent(this.#started ? "resuming session" : "starting session");

    const { stdout, stderr, code } = await this.#spawn(args);

    if (code !== 0 && !stdout.trim()) {
      throw new ProviderError(
        `Claude Code exited ${code}: ${stderr.trim().slice(0, 500) || "(no output)"}`,
        { code, stderr },
      );
    }

    // --output-format json prints one JSON object. Anything on stdout that
    // isn't that object (a warning line, an update notice) would break a naive
    // JSON.parse of the whole buffer, so take the last line that parses.
    const result = parseResult(stdout);
    if (!result) {
      throw new ProviderError(
        `Claude Code returned unparseable output: ${stdout.trim().slice(0, 500) || "(empty)"}`,
        { code: "BAD_OUTPUT", stderr },
      );
    }

    // Only mark the session live once a call has actually produced a session —
    // otherwise a failed first attempt would send --resume for an id that
    // Claude Code never created, and every later call would fail too.
    this.#started = true;
    this.calls += 1;
    this.costUsd += Number(result.total_cost_usd) || 0;

    if (result.is_error) {
      throw new ProviderError(
        `Claude Code reported an error: ${String(result.result ?? result.subtype ?? "unknown").slice(0, 500)}`,
        { code: result.subtype ?? "ERROR" },
      );
    }

    return {
      text: String(result.result ?? "").trim(),
      sessionId: result.session_id ?? this.#sessionId,
      costUsd: Number(result.total_cost_usd) || 0,
      durationMs: Number(result.duration_ms) || 0,
      turns: Number(result.num_turns) || 0,
    };
  }

  #spawn(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(claudeBin(), args, {
        cwd: this.#cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Same redirect the interactive path uses: CLAUDE_CONFIG_DIR keeps auth
        // and transcripts on the portable drive rather than the host's home.
        env: { ...process.env, ...portableEnv() },
        shell: isPortable() && process.platform === "win32", // claude.cmd needs a shell
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        reject(new ProviderError(
          `Claude Code timed out after ${Math.round(timeoutMs() / 1000)}s.`,
          { code: "TIMEOUT" },
        ));
      }, timeoutMs());

      child.on("error", (err) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(new ProviderError(
            "`claude` not found. Install it: npm install -g @anthropic-ai/claude-code",
            { code: "ENOENT" },
          ));
          return;
        }
        reject(new ProviderError(`Failed to start Claude Code: ${err.message}`, { code: err.code }));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }
}

/** Last JSON-parseable line of stdout, or null. Tolerates leading noise. */
function parseResult(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object") return obj;
    } catch { /* not this line */ }
  }
  return null;
}

/** Whether the CLI is present at all — lets the orchestrator hide the tool cleanly. */
export function claudeCodeAvailable() {
  const bin = claudeBin();
  if (bin !== "claude") return true; // resolved to a real bundled path
  // On PATH resolution we can't know without spawning; assume present and let
  // the ENOENT path report it with an actionable message instead of guessing.
  return true;
}
