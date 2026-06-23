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
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "../../.claudbot/agents.yaml");

function loadRegistry() {
  const raw = readFileSync(REGISTRY_PATH, "utf8");
  const parsed = parse(raw);
  return parsed?.agents ?? [];
}

function findAgent(name) {
  const agents = loadRegistry();
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    const names = agents.map((a) => a.name).join(", ");
    throw new Error(`Agent "${name}" not found. Available: ${names}`);
  }
  return agent;
}

async function callAgent(agent, prompt, systemPrompt) {
  const apiKey =
    agent.apiKeyEnv && agent.apiKeyEnv !== "null"
      ? process.env[agent.apiKeyEnv]
      : "none";

  if (agent.apiKeyEnv && agent.apiKeyEnv !== "null" && !apiKey) {
    throw new Error(
      `API key env var "${agent.apiKeyEnv}" is not set. ` +
        `Export it before running claudbot.`
    );
  }

  const baseUrl = agent.endpoint.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

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
    body: JSON.stringify({
      model: agent.model,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Agent "${agent.name}" HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Agent "${agent.name}" returned an empty response.`);
  }
  return content;
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
