import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseProvider, RateLimitError, ProviderError } from "./base.mjs";

const CLAUDBOT_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claudbot"
);

// Phrases that indicate the subscription rate limit was hit
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /overloaded/i,
  /usage.?limit/i,
  /exceeded.*limit/i,
];

function looksLikeRateLimit(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

// Maps mode names to the claude CLI flag(s) they require
const MODE_FLAGS = {
  full:     ["--dangerously-skip-permissions"],
  auto:     ["--permission-mode", "auto"],
  safe:     ["--permission-mode", "acceptEdits"],
  readonly: ["--permission-mode", "plan"],
};

export class ClaudeProvider extends BaseProvider {
  name = "Claude Code";
  #modeFlags;

  constructor({ mode = "full" } = {}) {
    super();
    this.#modeFlags = MODE_FLAGS[mode] ?? MODE_FLAGS.full;
  }

  async *query(prompt, { sessionId, cwd } = {}) {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      ...this.#modeFlags,
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    const child = spawn("claude", args, {
      cwd: cwd ?? CLAUDBOT_ROOT,
      env: process.env,
      // stdout/stderr piped; stdin closed
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrChunks = [];
    child.stderr.on("data", (d) => stderrChunks.push(d));

    let newSessionId = null;
    let rateLimitHit = false;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON output (startup messages, etc.) — pass through as text
        yield { type: "text", text: line };
        continue;
      }

      // Capture session ID from the init event
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        newSessionId = event.session_id;
      }

      // Detect rate limit in error/result events
      if (event.type === "system" && event.subtype === "error") {
        const msg = event.error?.message ?? JSON.stringify(event.error ?? event);
        if (looksLikeRateLimit(msg)) rateLimitHit = true;
      }
      if (event.type === "result" && event.is_error) {
        const status = event.api_error_status;
        const msg = String(event.result ?? "");
        if (status === 429 || looksLikeRateLimit(msg)) rateLimitHit = true;
      }

      yield event;
    }

    // Wait for process to exit
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    const stderr = Buffer.concat(stderrChunks).toString();

    if (rateLimitHit || (exitCode !== 0 && looksLikeRateLimit(stderr))) {
      throw new RateLimitError(`Claude Code rate limit hit (exit ${exitCode})`);
    }

    if (exitCode !== 0) {
      throw new ProviderError(`Claude Code exited with code ${exitCode}`, {
        code: exitCode,
        stderr,
      });
    }

    // Yield the resolved session ID so the caller can persist it
    if (newSessionId) {
      yield { type: "_meta", sessionId: newSessionId };
    }
  }
}
