#!/usr/bin/env node
/**
 * claudbot-exec MCP server
 *
 * Exposes two tools to Claude Code:
 *   list_agents  — returns all registered agents from agents.yaml
 *   run_agent    — calls a named agent at its configured endpoint
 *
 * Agent configs live in .claudbot/agents.yaml (sibling of this server's
 * location at ../../../.claudbot/agents.yaml relative to this file).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "../../.claudbot/agents.yaml");

// Load .env so API keys reach sub-agents even if the shell didn't source it
function loadDotEnv() {
  const envPath = path.join(__dirname, "../../.env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}
loadDotEnv();

// Safe agent name: lowercase letters, numbers, hyphens only
const SAFE_NAME = /^[a-z0-9-]{1,64}$/;

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = parse(readFileSync(REGISTRY_PATH, "utf8"));
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

function findAgent(name) {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid agent name "${name}"`);
  const agents = loadRegistry();
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    const names = agents.map((a) => a.name).join(", ");
    throw new Error(`Agent "${name}" not found. Available: ${names}`);
  }
  return agent;
}

// 120s proved too short for the bigger NIM models (researcher/longcontext, and
// coder/fast under load all exceed it); overridable per install.
const envTimeout = Number(process.env.CLAUDBOT_AGENT_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300_000;

// Completion cap sent to the endpoint: per-agent `maxTokens` in agents.yaml,
// else CLAUDBOT_AGENT_MAX_TOKENS, else 4096.
function agentMaxTokens(agent) {
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

// Reasoning models (Nemotron reasoning, Kimi) emit <think> traces that can
// dwarf the actual answer; never forward them into the caller's context.
function sanitizeAgentOutput(text, maxChars) {
  let s = typeof text === "string" ? text : "";
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  s = s.replace(/<think(?:ing)?>[\s\S]*$/i, ""); // unclosed trace
  const lastClose = s.toLowerCase().lastIndexOf("</think");
  if (lastClose !== -1) s = s.slice(s.indexOf(">", lastClose) + 1); // orphaned close tag
  s = s.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + `\n\n[output truncated at ${maxChars} chars]`;
  return s;
}

async function callAgent(agent, prompt, systemPrompt) {
  if (!agent.endpoint || typeof agent.endpoint !== "string") {
    throw new Error(`Agent "${agent.name}" has no valid endpoint configured.`);
  }

  const needsKey = agent.apiKeyEnv && agent.apiKeyEnv !== "null";
  const apiKey = needsKey ? process.env[agent.apiKeyEnv] : null;

  if (needsKey && !apiKey) {
    throw new Error(
      `API key env var "${agent.apiKeyEnv}" is not set. ` +
        `Add it to .env before running claudbot.`
    );
  }

  const baseUrl = agent.endpoint.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  const system = systemPrompt || agent.jobDescription?.trim() || "";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // omit for local/keyless

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: agent.model, messages, max_tokens: agentMaxTokens(agent) }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Agent "${agent.name}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Agent "${agent.name}" request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Agent "${agent.name}" HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Agent "${agent.name}" returned an empty response.`);
  }
  const maxChars = agentMaxOutputChars();
  const clean = sanitizeAgentOutput(content, maxChars);
  // If the model put its entire answer inside a think block, the raw text is
  // better than nothing.
  return clean || sanitizeAgentOutput(content.replace(/<\/?think(?:ing)?>/gi, ""), maxChars);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "claudbot-exec", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_agents",
      description:
        "List all registered sub-agents and their job descriptions. " +
        "Call this before run_agent to decide who to delegate to.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "run_agent",
      description:
        "Send a prompt to a named sub-agent and get its response back as a string. " +
        "The agent runs at its configured endpoint (local or remote). " +
        "Use list_agents first if you are unsure which agent to pick.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The agent name from the registry (e.g. 'researcher').",
          },
          prompt: {
            type: "string",
            description: "The task or question to send to the agent.",
          },
          systemPrompt: {
            type: "string",
            description:
              "Optional system prompt override. Defaults to the agent's jobDescription.",
          },
        },
        required: ["name", "prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_agents") {
    const agents = loadRegistry();
    const summary = agents
      .map((a) => `**${a.name}** (${a.model})\n${a.jobDescription?.trim()}`)
      .join("\n\n");
    return {
      content: [{ type: "text", text: summary || "No agents registered." }],
    };
  }

  if (name === "run_agent") {
    if (typeof args?.name !== "string" || typeof args?.prompt !== "string" || !args.prompt.trim()) {
      throw new Error("run_agent requires a string 'name' and a non-empty 'prompt'.");
    }
    const agent = findAgent(args.name);
    const result = await callAgent(agent, args.prompt, args.systemPrompt);
    return {
      content: [
        {
          type: "text",
          text: `[${args.name}]:\n\n${result}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
