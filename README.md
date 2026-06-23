# Claudbot

Autonomous agent program. Claude Code is the primary orchestrator (subscription-based, no per-token cost), with OpenAI Codex CLI and NVIDIA NIM as fallbacks.

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and logged in
- Node.js 22+
- Docker + Docker Compose (for sandboxed mode)

## Run locally (no sandbox)

```bash
git clone https://github.com/asuarcia/ClaudBot
cd ClaudBot
npm run setup
node claudbot.mjs
```

## Run in Docker (sandboxed)

```bash
git clone https://github.com/asuarcia/ClaudBot
cd ClaudBot

# Build the image
docker compose build

# First time only — log in to your Claude subscription inside the container
docker compose run claudbot claude auth login

# Start Claudbot
docker compose up
```

Files you want Claude to work on go in the `workspace/` folder — that directory is mounted into the container at `/workspace`.

## Provider chain

| Tier | Provider | Auth |
|------|----------|------|
| Primary | Claude Code | Claude subscription |
| Fallback 1 | OpenAI Codex CLI | OpenAI subscription |
| Fallback 2 | NVIDIA NIM | `NIM_API_KEY` env var |

Claudbot automatically switches to the next provider when a rate limit is hit.

## Add sub-agents

Edit `.claudbot/agents.yaml` — no code changes needed:

```yaml
agents:
  - name: my-agent
    endpoint: https://integrate.api.nvidia.com/v1/chat/completions
    model: meta/llama-3.1-70b-instruct
    apiKeyEnv: NIM_API_KEY
    description: "What this agent is good at"
```
