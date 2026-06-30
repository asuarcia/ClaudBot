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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: agent.model, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Agent "${name}" HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Agent "${name}" returned an empty response.`);
  return content;
}
