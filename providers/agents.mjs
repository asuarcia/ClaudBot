/**
 * Sub-agent registry + dispatch — shared by the claudbot-exec MCP server
 * (which exposes it to Claude Code) and the NIM fallback REPL (so the fallback
 * can delegate too, not just the primary agent).
 *
 * Reads .claudbot/agents.yaml and calls a named agent at its OpenAI-compatible
 * endpoint. Keeps no state; each call is a fresh context for that agent.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDBOT_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claudbot"
);
const REGISTRY_PATH = path.join(CLAUDBOT_ROOT, "agents.yaml");

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentTimeoutMs());
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: agent.model, messages, max_tokens: agentMaxTokens(agent) }),
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

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Agent "${name}" HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Agent "${name}" returned an empty response.`);
  const clean = sanitizeAgentOutput(content);
  return clean || sanitizeAgentOutput(content.replace(/<\/?think(?:ing)?>/gi, ""));
}
