#!/usr/bin/env node
/**
 * claudbot-exec MCP server
 *
 * Exposes two tools to Claude Code:
 *   list_agents  — returns all registered agents from agents.yaml
 *   run_agent    — calls a named agent at its configured endpoint
 *
 * The agent machinery itself lives in agents.mjs, so non-MCP callers (Forge's
 * CAD generator) can use the same roster and the same transports.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadRegistry, findAgent, callAgent } from "./agents.mjs";

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
