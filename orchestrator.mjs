#!/usr/bin/env node
/**
 * The orchestrator — Claudbot's top tier.
 *
 * Until now Claudbot WAS Claude Code. The TUI was the top-level agent, the NIM
 * roster hung off it through the claudbot-exec MCP, and every turn — "what's on
 * my calendar", "summarise this" — was billed to the Claude plan and shaped by
 * one vendor's harness.
 *
 * The stack is now three deep:
 *
 *     you
 *      └─ orchestrator        any model, via the gateway (this file)
 *          ├─ claude_code     the code orchestrator: files, git, bash, MCP
 *          │   └─ NIM roster  (its own claudbot-exec delegations)
 *          └─ NIM roster      direct, for work that needs no filesystem
 *
 * The orchestrator's job is judgment, not labour. It talks to you, and it
 * decides which of two very different things a turn needs: a cheap specialist
 * (`run_agent`) or the expensive generalist with hands (`claude_code`). Chat
 * stays cheap; anything touching the disk still gets the good agent.
 *
 * Nothing here is Claude-specific. The gateway takes any OpenAI-compatible
 * endpoint, so the model out front is a config line, not an architecture.
 */

import readline from "node:readline";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GatewayProvider,
  DEFAULT_GATEWAY_URL,
  DEFAULT_ORCHESTRATOR_MODEL,
  ensureGateway,
} from "./providers/gateway.mjs";
import { ClaudeCodeProvider } from "./providers/claude-code.mjs";
import * as agents from "./providers/agents.mjs";

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m",
  green: "\x1b[32m", red: "\x1b[31m", blue: "\x1b[34m",
};

// ─── model selection ─────────────────────────────────────────────────────────

/**
 * Default orchestrator model. OmniRoute's `auto/*` ids are virtual pools rather
 * than single models: it picks a live backend behind them and fails over when
 * one is rate-limited, which is the entire reason to put a gateway in front.
 *
 * `auto/best-chat`, not `auto/smart`, on measurement rather than on the name.
 * Probed 2026-08-27, six tool-calling turns each: best-chat answered 6/6 and
 * routed 6/6 correctly at a 2.4s median, while smart returned a 429 on a plain
 * "what is the capital of France" in the same round. Both resolve to the same
 * backend when they succeed; the chat pool just fails less, and a conversation
 * is what the orchestrator is for.
 */
const DEFAULT_MODEL = DEFAULT_ORCHESTRATOR_MODEL;

/**
 * Build a provider for a registry agent. The roster is already a table of
 * OpenAI-compatible endpoints, so an agent makes a perfectly good brain — this
 * is what lets `CLAUDBOT_BRAIN=gateway` put a gateway model out front instead
 * of whatever the fallback chain would have picked.
 */
function brainFromAgent(agent, via) {
  return {
    provider: new GatewayProvider({
      baseUrl: agent.endpoint,
      apiKey: agents.agentApiKey(agent),
      model: agent.model,
    }),
    model: agent.model,
    via: `${via}:${agent.name}`,
    catalog: [],
    url: agent.endpoint,
  };
}

/**
 * Work out what the orchestrator runs on, preferring the gateway but never
 * requiring it. OmniRoute is an 830MB global install that does not fit the
 * portable drive, so a Claudbot on a USB stick has to reach the same place
 * through the NIM roster instead.
 *
 * Three steps, in order of how much the user asked for it:
 *
 *   1. `CLAUDBOT_BRAIN` names a roster agent — an explicit choice, honoured
 *      without probing anything else.
 *   2. The gateway, started if it is installed and idle. This step is the
 *      whole point: an installed-but-not-running gateway used to fall silently
 *      through to step 3, which reads as "my assistant got worse today".
 *   3. A registered NIM agent, so a machine with no gateway still works.
 */
async function resolveBrain({ onProgress } = {}) {
  const named = process.env.CLAUDBOT_BRAIN?.trim();
  if (named) {
    const agent = agents.resolveAgent("CLAUDBOT_BRAIN", null);
    if (agent) return brainFromAgent(agent, "agent");
    onProgress?.(`CLAUDBOT_BRAIN="${named}" is not in the registry — ignoring it`);
  }

  const url = process.env.OMNIROUTE_URL ?? DEFAULT_GATEWAY_URL;
  const model = process.env.OMNIROUTE_MODEL ?? DEFAULT_MODEL;

  const gw = await ensureGateway({ baseUrl: url, onProgress });
  if (gw.ok) {
    return {
      provider: new GatewayProvider({ baseUrl: url, model }),
      model,
      via: "omniroute",
      catalog: gw.models ?? [],
      url,
      startedGateway: gw.started,
    };
  }

  // No gateway. Fall back to a registered NIM agent — same OpenAI-compatible
  // shape, so the identical client class works with different coordinates.
  const fb = agents.resolveAgent("CLAUDBOT_ORCHESTRATOR_AGENT", "agent");
  if (!fb) return { provider: null, reason: gw.reason };

  return { ...brainFromAgent(fb, "nim"), gatewayError: gw.reason };
}

// ─── the tools the orchestrator can reach for ────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "claude_code",
      description:
        "Delegate to Claude Code — a full coding agent with real tools: read/write files, " +
        "run shell commands, git, web search, and the Obsidian vault. Use this for ANYTHING " +
        "that touches the filesystem, a repository, or the live web, and for multi-step " +
        "engineering work. It is the most capable and most expensive option, so do not use " +
        "it for questions you can answer yourself or that a sub-agent can handle. " +
        "It REMEMBERS earlier calls in this conversation, so you can follow up on its work.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The full task. Be specific and include file paths, repo names and acceptance " +
              "criteria. It can ask its own follow-up questions of its own sub-agents.",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List the cheap specialist sub-agents available for direct delegation.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_agent",
      description:
        "Delegate a self-contained task to a named specialist sub-agent. Cheap and fast, " +
        "but it has NO filesystem, NO web and NO memory of anything — put every piece of " +
        "context it needs into `prompt`. Prefer this over claude_code for pure text work: " +
        "summarising, classifying, extracting, drafting, reasoning about something you paste in.",
      parameters: {
        type: "object",
        properties: {
          name:   { type: "string", description: "Agent name from the registry." },
          prompt: { type: "string", description: "The complete, self-contained task." },
        },
        required: ["name", "prompt"],
      },
    },
  },
];

// ─── system prompt ───────────────────────────────────────────────────────────

function loadPersona() {
  const p = path.join(CLAUDBOT_ROOT, "CLAUDE.md");
  if (!existsSync(p)) return "";
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function buildSystemPrompt(roster) {
  return `${loadPersona()}

## You are the orchestrator

You are the top tier of a three-tier agent. You talk to the user directly. You
do not have hands: no filesystem, no shell, no web. What you have is judgment
and three tools.

Route every turn deliberately:

- **Answer it yourself** when it is conversation, recall, an opinion, or
  something you simply know. Most turns are this. Do not delegate to look busy.
- **run_agent** for self-contained text work — summarise, classify, extract,
  draft, reason over something already in the conversation. Cheap and fast.
  The sub-agent starts blank every time, so restate the context in the prompt.
- **claude_code** when the turn needs *hands*: reading or writing files, a repo,
  git, shell commands, builds, tests, or the live web. It is a full coding agent
  and the expensive option. It keeps its context across calls in this
  conversation, so treat it as a colleague you can follow up with rather than a
  one-shot command.

Delegating trivia to claude_code wastes real money. Answering a "fix the bug in
src/api.mjs" yourself is worse — you cannot see the file, and guessing at its
contents produces confident nonsense. Pick honestly.

After a tool returns, integrate the result into your own reply in your own
voice. Never paste raw tool output at the user, and say briefly who you used and
why when you delegated.

## Sub-agents available to run_agent

${roster || "(none registered)"}`;
}

// ─── spinner ─────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * An animated spinner, but only where animation means anything. Carriage
 * returns do not overwrite anything in a pipe or a log file, so on a non-TTY
 * every frame becomes its own line and a 30-second call buries the actual
 * answer under three hundred lines of spinner. Print one static line instead.
 */
function spinner(label) {
  const plain = label.replace(/\x1b\[[0-9;]*m/g, "");

  if (!process.stdout.isTTY) {
    process.stdout.write(`  … ${plain}\n`);
    return (final = "") => { if (final) console.log(final); };
  }

  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${C.cyan}${FRAMES[i++ % FRAMES.length]}${C.reset}  ${C.dim}${label}…${C.reset}   `);
  }, 90);
  return (final = "") => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
    if (final) console.log(final);
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function runOrchestrator({ cwd = CLAUDBOT_ROOT, mode = "full" } = {}) {
  // A cold gateway takes about a minute to answer. Say so while it happens —
  // an unexplained silent minute at startup reads as a hang, and the user is
  // sitting at a prompt waiting for it.
  let note;
  const brain = await resolveBrain({
    onProgress: (m) => {
      if (m === note) return;
      note = m;
      console.log(`  ${C.dim}… ${m}${C.reset}`);
    },
  });

  if (!brain.provider) {
    console.error(
      `\n  ${C.red}✗${C.reset}  No orchestrator model available.\n\n` +
      `      No gateway at ${C.cyan}${process.env.OMNIROUTE_URL ?? DEFAULT_GATEWAY_URL}${C.reset} ` +
      `${C.dim}(${brain.reason})${C.reset}\n` +
      `      and no usable agent in ${C.cyan}.claudbot/agents.yaml${C.reset}.\n\n` +
      `      Start one:  ${C.cyan}omniroute${C.reset}   ${C.dim}— or set NIM_API_KEY${C.reset}\n`,
    );
    process.exit(1);
  }

  const roster = agents.describeAgents();
  const claude = new ClaudeCodeProvider({ cwd, mode });

  // Banner. Three ways to get here and the difference matters: running on the
  // gateway is the good case, running on NIM means something is wrong and the
  // reason belongs on screen rather than in a log nobody reads.
  const viaLabel =
    brain.via === "omniroute"
      ? `${C.green}OmniRoute${C.reset} ${C.dim}${brain.catalog.length} models` +
        `${brain.startedGateway ? " · started just now" : ""}${C.reset}`
      : brain.via.startsWith("agent:")
        ? `${C.green}${brain.via.slice(6)}${C.reset} ${C.dim}(CLAUDBOT_BRAIN)${C.reset}`
        : `${C.yellow}NIM${C.reset} ${C.dim}(no gateway — ${brain.gatewayError})${C.reset}`;

  console.log(`
  ${C.bold}${C.cyan}◆ CLAUDBOT${C.reset}  ${C.dim}│${C.reset}  orchestrator mode
  ${C.dim}${"─".repeat(64)}${C.reset}
  ${C.dim}brain    ${C.reset}${C.bold}${brain.model}${C.reset}  ${C.dim}via${C.reset} ${viaLabel}
  ${C.dim}hands    ${C.reset}claude_code ${C.dim}(${mode} · ${cwd})${C.reset}
  ${C.dim}agents   ${C.reset}${agents.loadAgents().map((a) => a.name).join(", ") || "(none)"}
  ${C.dim}${"─".repeat(64)}${C.reset}
  ${C.dim}/help for commands · /exit to quit${C.reset}
`);

  const system = buildSystemPrompt(roster);
  const history = [{ role: "system", content: system }];
  let verbose = false;

  // ── tool dispatch ──────────────────────────────────────────────────────────

  async function executeTool(tc) {
    const fn = tc.function?.name;
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* malformed */ }

    if (fn === "list_agents") return roster || "(no agents registered)";

    if (fn === "run_agent") {
      const stop = spinner(`${C.magenta}${args.name}${C.reset}${C.dim} working`);
      try {
        const out = await agents.runAgent(args.name, args.prompt);
        stop(`  ${C.magenta}↪${C.reset} ${C.dim}delegated to ${args.name}${C.reset}`);
        return out;
      } catch (e) {
        stop(`  ${C.yellow}↪${C.reset} ${C.dim}${args.name} failed${C.reset}`);
        return `Error from ${args.name}: ${e.message}`;
      }
    }

    if (fn === "claude_code") {
      const stop = spinner(`${C.blue}claude_code${C.reset}${C.dim} working`);
      try {
        const r = await claude.run(args.task, {
          onEvent: () => {},
        });
        stop(
          `  ${C.blue}↪${C.reset} ${C.dim}claude_code · ${r.turns} turn${r.turns === 1 ? "" : "s"} · ` +
          `${(r.durationMs / 1000).toFixed(1)}s · $${r.costUsd.toFixed(4)}${C.reset}`,
        );
        return r.text || "(Claude Code returned no text)";
      } catch (e) {
        stop(`  ${C.yellow}↪${C.reset} ${C.dim}claude_code failed${C.reset}`);
        return `Error from claude_code: ${e.message}`;
      }
    }

    return `Unknown tool: ${fn}`;
  }

  // ── one user turn ──────────────────────────────────────────────────────────

  // Enough hops for orchestrator → tool → follow-up tool → answer, with room to
  // spare, but bounded: a model that loops on a failing tool would otherwise
  // burn the whole budget silently.
  const MAX_HOPS = 8;

  async function turn(userText) {
    const messages = [...history, { role: "user", content: userText }];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const stop = spinner(`${C.dim}${brain.model}${C.reset}${C.dim} thinking`);
      let msg;
      try {
        msg = await brain.provider.chat(messages, { tools: TOOLS });
      } finally {
        stop();
      }

      if (verbose && msg.reasoning) {
        console.log(`  ${C.dim}┆ ${msg.reasoning.replace(/\n/g, `\n  ${C.dim}┆ `)}${C.reset}\n`);
      }

      if (msg.tool_calls?.length) {
        messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          const result = await executeTool(tc);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            // Capped: a full repo dump from claude_code would blow the context
            // window on the very next hop and take the conversation with it.
            content: String(result).slice(0, 24_000),
          });
        }
        continue;
      }

      return msg.content?.trim() || "(no response)";
    }
    return `(stopped after ${MAX_HOPS} tool hops without a final answer)`;
  }

  // ── REPL ───────────────────────────────────────────────────────────────────

  const printReply = (text) => {
    console.log(`  ${C.dim}${"─".repeat(64)}${C.reset}`);
    console.log("  " + text.replace(/\n/g, "\n  "));
    console.log(`  ${C.dim}${"─".repeat(64)}${C.reset}`);
  };

  const help = () => console.log(`
  ${C.bold}Commands${C.reset}
    ${C.cyan}/agents${C.reset}              list the specialist sub-agents
    ${C.cyan}/agent <name> <task>${C.reset} call one directly, bypassing the orchestrator
    ${C.cyan}/claude <task>${C.reset}       call claude_code directly
    ${C.cyan}/model [id]${C.reset}          show or switch the orchestrator model
    ${C.cyan}/models [filter]${C.reset}     list what the gateway can serve
    ${C.cyan}/cost${C.reset}                what claude_code has spent this session
    ${C.cyan}/verbose${C.reset}             toggle showing the model's reasoning
    ${C.cyan}/reset${C.reset}               clear the conversation and claude_code's session
    ${C.cyan}/exit${C.reset}                quit
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("SIGINT", () => { console.log(`\n\n  ${C.dim}Bye.${C.reset}\n`); process.exit(0); });

  // Piped input ends. Every prompt() below is reached from an async callback,
  // so without this the last turn's completion calls rl.question() on a closed
  // interface and the process dies with ERR_USE_AFTER_CLOSE instead of exiting.
  let closed = false;
  rl.on("close", () => { closed = true; });

  const prompt = () => {
    if (closed) { process.exit(0); }
    rl.question(`  ${C.cyan}${C.bold}◆ claudbot${C.reset} ${C.bold}›${C.reset} `, async (input) => {
      const text = input.trim();
      if (!text) return prompt();

      if (["/exit", "/quit", "exit", "quit"].includes(text.toLowerCase())) {
        console.log(`\n  ${C.dim}Bye.${C.reset}\n`);
        process.exit(0);
      }

      if (text === "/help") { help(); return prompt(); }

      if (text === "/agents") {
        console.log(`\n${roster ? roster.split("\n").map((l) => "  " + l).join("\n") : "  (none)"}\n`);
        return prompt();
      }

      if (text === "/cost") {
        console.log(
          `\n  claude_code: ${C.bold}${claude.calls}${C.reset} call${claude.calls === 1 ? "" : "s"}, ` +
          `${C.bold}$${claude.costUsd.toFixed(4)}${C.reset}` +
          `${claude.sessionId ? `\n  ${C.dim}session ${claude.sessionId}${C.reset}` : ""}\n`,
        );
        return prompt();
      }

      if (text === "/verbose") {
        verbose = !verbose;
        console.log(`\n  ${C.dim}reasoning traces ${verbose ? "on" : "off"}${C.reset}\n`);
        return prompt();
      }

      if (text === "/reset") {
        history.length = 1; // keep the system prompt
        claude.reset();
        console.log(`\n  ${C.dim}Conversation and claude_code session cleared.${C.reset}\n`);
        return prompt();
      }

      const modelCmd = text.match(/^\/model(?:\s+(\S+))?$/);
      if (modelCmd) {
        if (!modelCmd[1]) {
          console.log(`\n  ${C.bold}${brain.model}${C.reset} ${C.dim}via ${brain.via}${C.reset}\n`);
        } else {
          brain.model = modelCmd[1];
          brain.provider = new GatewayProvider({
            baseUrl: brain.url,
            apiKey: process.env.OMNIROUTE_API_KEY,
            model: brain.model,
          });
          console.log(`\n  ${C.green}✓${C.reset} orchestrator now on ${C.bold}${brain.model}${C.reset}\n`);
        }
        return prompt();
      }

      const modelsCmd = text.match(/^\/models(?:\s+(.+))?$/);
      if (modelsCmd) {
        const filter = modelsCmd[1]?.toLowerCase();
        const list = brain.catalog.filter((m) => !filter || m.toLowerCase().includes(filter));
        console.log(
          `\n  ${list.length} model${list.length === 1 ? "" : "s"}` +
          `${filter ? ` matching "${filter}"` : ""}:\n` +
          list.slice(0, 60).map((m) => `    ${m}`).join("\n") +
          (list.length > 60 ? `\n    ${C.dim}… and ${list.length - 60} more${C.reset}` : "") + "\n",
        );
        return prompt();
      }

      const claudeCmd = text.match(/^\/claude\s+([\s\S]+)$/);
      if (claudeCmd) {
        console.log();
        const stop = spinner(`${C.blue}claude_code${C.reset}${C.dim} working`);
        try {
          const r = await claude.run(claudeCmd[1]);
          stop();
          printReply(r.text);
          console.log(`  ${C.dim}${r.turns} turns · ${(r.durationMs / 1000).toFixed(1)}s · $${r.costUsd.toFixed(4)}${C.reset}`);
        } catch (e) {
          stop();
          console.error(`\n  ${C.yellow}⚠${C.reset}  ${e.message}`);
        }
        console.log();
        return prompt();
      }

      const agentCmd = text.match(/^\/agent\s+(\S+)\s+([\s\S]+)$/);
      if (agentCmd) {
        console.log();
        const stop = spinner(`${C.magenta}${agentCmd[1]}${C.reset}${C.dim} working`);
        try {
          const out = await agents.runAgent(agentCmd[1], agentCmd[2]);
          stop();
          printReply(`[${agentCmd[1]}]\n\n${out}`);
        } catch (e) {
          stop();
          console.error(`\n  ${C.yellow}⚠${C.reset}  ${e.message}`);
        }
        console.log();
        return prompt();
      }

      console.log();
      try {
        const reply = await turn(text);
        printReply(reply);
        history.push({ role: "user", content: text });
        history.push({ role: "assistant", content: reply });
        // Rolling window, system prompt pinned. Tool traffic is deliberately not
        // kept: the orchestrator's decisions matter to the next turn, the raw
        // tool output does not, and keeping it would evict real conversation.
        while (history.length > 21) history.splice(1, 2);
      } catch (e) {
        console.error(`\n  ${C.yellow}⚠${C.reset}  ${e.message}`);
      }
      console.log();
      prompt();
    });
  };

  help();
  prompt();
}

/**
 * .env loading, duplicated from claudbot.mjs rather than shared.
 *
 * The split on /\r?\n/ and the trim are not incidental: a CRLF .env on Windows
 * silently gave every parser in this project keys with a trailing \r, which
 * fails auth in a way that looks like a wrong key. Any new reader of .env has
 * to handle it the same way.
 */
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}

// Runnable on its own: `node orchestrator.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  runOrchestrator().catch((err) => {
    console.error("[orchestrator] Fatal:", err);
    process.exit(1);
  });
}
