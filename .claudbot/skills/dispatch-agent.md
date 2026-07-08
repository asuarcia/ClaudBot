---
name: dispatch-agent
description: Protocol for routing tasks to sub-agents via claudbot-exec MCP tools
---

# Dispatching to Sub-agents

**Delegation is mandatory, not optional.** You are an orchestrator. Whenever a
piece of work matches a registered agent's specialty, it goes to that agent —
even if you could do it yourself. "I could do it faster myself" is not a reason
to skip the roster. The only work you do directly is orchestration: deciding
what to delegate, giving each agent the context it needs, integrating results,
and the native file/git/bash/edit operations that actually apply the agents'
output to disk.

## The roster (see agents.yaml for exact models)

- `coder` (DeepSeek V4 Pro) — writing, reviewing, refactoring, debugging code
- `researcher` (Nemotron 3 Ultra) — deep research, reasoning, planning, comparison
- `fast` (Nemotron 3 Nano) — quick/cheap tasks: summaries, classification, extraction, short drafts
- `agent` (Kimi K2.6) — agentic multi-step automation, tool-use planning, agentic coding
- `longcontext` (DeepSeek V4 Flash, 1M ctx) — long documents, large-codebase sweeps, log analysis

## Routing rules

| Task | Send to |
|------|---------|
| Implement / fix / refactor / review code | `coder` |
| Research, plan, compare options, reason deeply | `researcher` |
| Quick summary, classify, extract, reformat, short text | `fast` |
| Multi-step automation, workflow/tool-use design, agentic coding | `agent` |
| Anything with a huge input (long docs, big codebases, logs) | `longcontext` |

When a task spans categories, decompose it and chain agents (e.g. `researcher`
plans → `coder` implements → `fast` writes the summary).

## Protocol

1. **Know the roster.** Call `list_agents()` once before your first delegation
   each session — not at greeting, so sessions with no delegation don't pay for
   the roster dump.

2. **Craft a focused, self-contained prompt.** Each call is stateless — the
   sub-agent has zero conversation history. Paste in all the code, context, and
   constraints it needs in the single prompt.

3. **Call the agent:**
   ```
   run_agent(name="coder", prompt="<full task + context>")
   ```

4. **Integrate, don't paste.** Synthesize the agent's response into your reply,
   apply its output to the actual files yourself, verify it, and add your own
   commentary. Briefly tell the user which agent you used and why.

5. **Save useful outputs** to Obsidian when worth keeping (see memory.md).

## Notes

- Sub-agent calls are **stateless** — fresh context window every time.
- Replies are sanitized: reasoning-model `<think>` traces are stripped and the
  text is capped at ~24k chars (`CLAUDBOT_AGENT_MAX_OUTPUT`). Completions are
  capped at 4096 tokens (`maxTokens` per agent in agents.yaml, or
  `CLAUDBOT_AGENT_MAX_TOKENS`). Calls time out after 300s
  (`CLAUDBOT_AGENT_TIMEOUT_MS`).
- If an agent errors (endpoint down, key missing, bad model ID), tell the user
  clearly, then either retry via a different agent or fall back to doing it
  yourself — never silently stall.
- Chain agents for complex work; one agent's output can become the next's input.
