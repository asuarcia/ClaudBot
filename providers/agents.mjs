/**
 * Sub-agent registry + dispatch — shared by the claudbot-exec MCP server
 * (which exposes it to Claude Code) and the NIM fallback REPL (so the fallback
 * can delegate too, not just the primary agent).
 *
 * Reads .claudbot/agents.yaml and calls a named agent at its OpenAI-compatible
 * endpoint. Keeps no state; each call is a fresh context for that agent.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDBOT_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claudbot"
);
const REGISTRY_PATH = path.join(CLAUDBOT_ROOT, "agents.yaml");
const USAGE_PATH    = path.join(CLAUDBOT_ROOT, "usage.json");

// Safe agent name: lowercase letters, numbers, hyphens only.
const SAFE_NAME = /^[a-z0-9-]{1,64}$/;

export function loadAgents() {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return yamlParse(readFileSync(REGISTRY_PATH, "utf8"))?.agents ?? [];
  } catch {
    return [];
  }
}

export function findAgent(name) {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid agent name "${name}"`);
  const agents = loadAgents();
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    const names = agents.map((a) => a.name).join(", ") || "(none registered)";
    throw new Error(`Agent "${name}" not found. Available: ${names}`);
  }
  return agent;
}

/**
 * Resolve an agent for a role (fallback REPL, dreaming, …) from an env var that
 * names the agent, with a default. Returns the agent record or null if neither
 * the env-named nor the default agent is registered.
 */
export function resolveAgent(envVar, defaultName) {
  const name = (process.env[envVar] || defaultName || "").trim();
  if (!name) return null;
  try { return findAgent(name); } catch { return null; }
}

/** API key for an agent record (honors its apiKeyEnv; null for keyless local). */
export function agentApiKey(agent) {
  const usesKey = agent?.apiKeyEnv && agent.apiKeyEnv !== "null" && agent.apiKeyEnv !== null;
  return usesKey ? process.env[agent.apiKeyEnv] : undefined;
}

/** One-line summaries for prompting / display. */
export function describeAgents() {
  return loadAgents()
    .map((a) => `- ${a.name} (${a.model}): ${(a.jobDescription ?? "").trim().replace(/\s+/g, " ")}`)
    .join("\n");
}

// Completion cap sent to the endpoint: per-agent `maxTokens` in agents.yaml,
// else CLAUDBOT_AGENT_MAX_TOKENS, else 4096.
export function agentMaxTokens(agent) {
  for (const v of [agent?.maxTokens, process.env.CLAUDBOT_AGENT_MAX_TOKENS]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 4096;
}

function agentMaxOutputChars() {
  const n = Number(process.env.CLAUDBOT_AGENT_MAX_OUTPUT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24_000;
}

function agentTimeoutMs() {
  const n = Number(process.env.CLAUDBOT_AGENT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

// Reasoning models (Nemotron reasoning, Kimi) emit <think> traces that can
// dwarf the actual answer; never forward them to callers.
export function sanitizeAgentOutput(text, maxChars = agentMaxOutputChars()) {
  let s = typeof text === "string" ? text : "";
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  s = s.replace(/<think(?:ing)?>[\s\S]*$/i, ""); // unclosed trace
  const lastClose = s.toLowerCase().lastIndexOf("</think");
  if (lastClose !== -1) s = s.slice(s.indexOf(">", lastClose) + 1); // orphaned close tag
  s = s.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + `\n\n[output truncated at ${maxChars} chars]`;
  return s;
}

/**
 * Record one agent call against today's tally in .claudbot/usage.json.
 *
 * Rolling 30-day window, keyed by local date then agent name. This is the only
 * place Claudbot has ever counted tokens — the endpoints return an
 * OpenAI-compatible `usage` block on every response and it used to be dropped
 * on the floor. The desktop Status widget reads this file.
 *
 * Deliberately best-effort and swallowed: metering must never be able to fail
 * a call that already succeeded.
 */
function recordUsage(name, usage) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    let db = { days: {} };
    if (existsSync(USAGE_PATH)) {
      try { db = JSON.parse(readFileSync(USAGE_PATH, "utf8")) ?? db; } catch { /* start fresh */ }
    }
    db.days ??= {};
    const agents = (db.days[day] ??= { agents: {} }).agents ??= {};
    const a = (agents[name] ??= { calls: 0, promptTokens: 0, completionTokens: 0 });
    a.calls += 1;
    a.promptTokens     += Number(usage?.prompt_tokens) || 0;
    a.completionTokens += Number(usage?.completion_tokens) || 0;

    for (const d of Object.keys(db.days).sort().slice(0, -30)) delete db.days[d];

    // Atomic: the widget bridge polls this file and must never read a partial write.
    mkdirSync(CLAUDBOT_ROOT, { recursive: true });
    const tmp = `${USAGE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, USAGE_PATH);
  } catch { /* metering is never worth failing a successful call over */ }
}

/**
 * Statuses worth trying again, and the ones that are final.
 *
 * 429 and 5xx are the endpoint being busy — NVIDIA returns 529 "Service
 * temporarily overloaded" under load, and a request that fails that way
 * succeeds seconds later. 4xx other than 429 is our mistake and will fail
 * identically forever: 410 means the model was retired, 401 means the key is
 * wrong. Retrying those wastes the caller's time and hides the real message.
 */
const RETRYABLE = (status) => status === 429 || (status >= 500 && status < 600);

/** Attempts, and how long to wait between them. Doubling, from one second. */
const RETRIES = 3;
const backoffMs = (attempt) => 1000 * 2 ** (attempt - 1);

export async function runAgent(name, prompt, systemPrompt) {
  const agent = findAgent(name);

  const usesKey = agent.apiKeyEnv && agent.apiKeyEnv !== "null" && agent.apiKeyEnv !== null;
  const apiKey = usesKey ? process.env[agent.apiKeyEnv] : "none";
  if (usesKey && !apiKey) {
    throw new Error(
      `Agent "${name}" needs env var "${agent.apiKeyEnv}", which is not set.`
    );
  }

  const url = `${agent.endpoint.replace(/\/$/, "")}/chat/completions`;
  const system = systemPrompt || agent.jobDescription?.trim() || "";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = JSON.stringify({ model: agent.model, messages, max_tokens: agentMaxTokens(agent) });

  let res;
  for (let attempt = 1; ; attempt++) {
    // A fresh controller per attempt: an aborted one stays aborted, so reusing
    // it would make every retry fail instantly with the first attempt's timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), agentTimeoutMs());
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Agent "${name}" timed out after ${agentTimeoutMs() / 1000}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) break;
    if (attempt >= RETRIES || !RETRYABLE(res.status)) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`Agent "${name}" HTTP ${res.status}: ${text}`);
    }
    // Drain the body before the next attempt so the connection can be reused.
    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }

  const data = await res.json();
  recordUsage(name, data?.usage);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Agent "${name}" returned an empty response.`);
  const clean = sanitizeAgentOutput(content);
  return clean || sanitizeAgentOutput(content.replace(/<\/?think(?:ing)?>/gi, ""));
}
