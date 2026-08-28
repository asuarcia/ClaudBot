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
// Overridable so the dispatch path can be tested against a stub endpoint —
// every agent in the real registry points at a live third party, and a test
// that calls one of those is a test of NVIDIA's uptime, not of this code.
const registryPath = () => process.env.CLAUDBOT_AGENTS_FILE || path.join(CLAUDBOT_ROOT, "agents.yaml");
const USAGE_PATH    = path.join(CLAUDBOT_ROOT, "usage.json");

// Safe agent name: lowercase letters, numbers, hyphens only.
const SAFE_NAME = /^[a-z0-9-]{1,64}$/;

export function loadAgents() {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    return yamlParse(readFileSync(p, "utf8"))?.agents ?? [];
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
 *
 * The body clause is for gateway endpoints. An `auto/*` id on OmniRoute is a
 * POOL, not a model, and a request can die because the one member it happened
 * to pick is broken while healthy ones sit behind it — observed live:
 * `oc/north-mini-code-free` 401s with "Model … is not supported" inside a pool
 * whose next member answers fine. Against a single endpoint a 401 is terminal;
 * against a pool it usually is not. OmniRoute marks the difference itself with
 * `"recovery":{"action":"retry"}`, so honour that and fall back to the
 * status-code rules when it is absent.
 */
const RETRYABLE = (status, bodyText = "") =>
  status === 429 ||
  (status >= 500 && status < 600) ||
  /"action"\s*:\s*"retry"/.test(bodyText);

/** Attempts, and how long to wait between them. Doubling, from one second. */
const RETRIES = 3;
const backoffMs = (attempt) => 1000 * 2 ** (attempt - 1);

export async function runAgent(name, prompt, systemPrompt) {
  const agent = findAgent(name);

  const usesKey = agent.apiKeyEnv && agent.apiKeyEnv !== "null" && agent.apiKeyEnv !== null;
  const apiKey = usesKey ? process.env[agent.apiKeyEnv] : undefined;
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

  const body = JSON.stringify({
    model: agent.model,
    messages,
    max_tokens: agentMaxTokens(agent),
    // Explicit, not defaulted. Omitting the field is NOT the same as false on a
    // gateway: OmniRoute streams SSE by default, so a keyless local agent would
    // get back `data: {...}` lines and res.json() would throw on the first one.
    stream: false,
  });

  // Only when there is a key. A local gateway serves loopback without auth, and
  // `Bearer none` is worse than no header at all — some upstreams reject a
  // malformed key with a 401 that reads like a configuration problem.
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  for (let attempt = 1; ; attempt++) {
    // A fresh controller per attempt: an aborted one stays aborted, so reusing
    // it would make every retry fail instantly with the first attempt's timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), agentTimeoutMs());
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Agent "${name}" timed out after ${agentTimeoutMs() / 1000}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) break;

    // Read the body before deciding: on a gateway the retry verdict is IN the
    // body, not just the status. Reading it also drains the connection for reuse.
    const text = await res.text().catch(() => "(no body)");
    if (attempt >= RETRIES || !RETRYABLE(res.status, text)) {
      throw new Error(`Agent "${name}" HTTP ${res.status}: ${text}`);
    }
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }

  const data = await res.json();
  recordUsage(name, data?.usage);

  // `content` is null on reasoning models, which put their trace in a separate
  // `reasoning_content` field and leave content null until they are done. A
  // model that spent its whole completion budget thinking returns exactly that
  // shape, and reporting it as "empty response" throws away the one thing it
  // did produce. Prefer real content; fall back to the trace rather than
  // nothing, and say which finish reason got us there.
  const message = data?.choices?.[0]?.message;
  const content =
    (typeof message?.content === "string" && message.content.trim() && message.content) ||
    (typeof message?.reasoning_content === "string" && message.reasoning_content.trim() &&
      message.reasoning_content);

  if (!content) {
    const why = data?.choices?.[0]?.finish_reason;
    throw new Error(
      `Agent "${name}" returned an empty response` +
        (why ? ` (finish_reason: ${why}${why === "length" ? " — raise maxTokens in agents.yaml" : ""}).` : "."),
    );
  }
  const clean = sanitizeAgentOutput(content);
  return clean || sanitizeAgentOutput(content.replace(/<\/?think(?:ing)?>/gi, ""));
}
