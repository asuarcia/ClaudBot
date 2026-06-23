---
name: dispatch-agent
description: Protocol for routing tasks to sub-agents via claudbot-exec MCP tools
---

# Dispatching to Sub-agents

Use sub-agents when a task would benefit from a different model or a specialized capability. Do not delegate tasks you can handle well yourself.

## When to delegate

- User asks for deep research or long-form summarization → `researcher`
- Task requires heavy reasoning, comparison, or multi-step evaluation → `nemotron`
- User explicitly asks you to use a specific agent

## Protocol

1. **Check what's available** (do this once per session or when unsure):
   ```
   list_agents()
   ```

2. **Craft a focused prompt** — the sub-agent has no conversation history. Give it all context it needs in a single prompt.

3. **Call the agent**:
   ```
   run_agent(name="researcher", prompt="Summarize the current state of MCP-based agent architectures...")
   ```

4. **Integrate the result** — synthesize the agent's response into your reply. Don't just paste it raw; add your own commentary or follow-up.

5. **Save useful outputs** to Obsidian if they're worth keeping (see memory.md skill).

## Notes

- Sub-agent calls are **stateless** — each call is a fresh context window for that model.
- If an agent returns an error (endpoint down, key missing), tell the user clearly and offer to handle it yourself instead.
- You can call multiple agents sequentially for complex tasks (e.g., researcher feeds into nemotron for deeper analysis).
