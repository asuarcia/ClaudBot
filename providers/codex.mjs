import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BaseProvider, RateLimitError, ProviderError } from "./base.mjs";

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /429/,
];

function looksLikeRateLimit(text) {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * OpenAI Codex CLI provider (Option A — full autonomous agent runtime).
 * Requires `codex` to be installed and authenticated on PATH.
 *
 * Codex CLI docs: https://github.com/openai/codex
 */
export class CodexProvider extends BaseProvider {
  name = "Codex CLI";

  async *query(prompt, { cwd } = {}) {
    // Codex runs in full-auto mode with no confirmation prompts
    const args = ["--approval-policy", "full-auto", "--quiet", prompt];

    const child = spawn("codex", args, {
      cwd: cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrChunks = [];
    child.stderr.on("data", (d) => stderrChunks.push(d));

    for await (const line of rl) {
      if (!line.trim()) continue;
      // Codex outputs plain text; wrap in a compatible event shape
      yield { type: "assistant_text", text: line };
    }

    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    const stderr = Buffer.concat(stderrChunks).toString();

    if (exitCode !== 0 && looksLikeRateLimit(stderr)) {
      throw new RateLimitError(`Codex CLI rate limit (exit ${exitCode})`);
    }

    if (exitCode !== 0) {
      throw new ProviderError(`Codex CLI exited with code ${exitCode}`, {
        code: exitCode,
        stderr,
      });
    }
  }
}
