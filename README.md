# Claudbot

An autonomous agent program built on top of Claude Code. You launch it like any app, talk to it in a terminal, and it works autonomously — reading files, running commands, browsing the web, writing code, and delegating specialized tasks to sub-agents.

**Cost philosophy**: no per-token API billing. The primary engine runs on a Claude subscription. Codex CLI (OpenAI subscription) and NVIDIA NIM endpoints serve as automatic fallbacks if a rate limit is hit.

---

## Architecture

```
You (terminal)
     │
     ▼
 Claudbot REPL          ← Node.js program (this repo)
     │
     ├─ Provider 1: Claude Code CLI     (claude -p, subscription-based)
     ├─ Provider 2: OpenAI Codex CLI    (subscription-based fallback)
     └─ Provider 3: NVIDIA NIM          (HTTP fallback, NIM_API_KEY)
              │
              ├─ MCP: claudbot-exec     ← sub-agent dispatcher
              │        reads agents.yaml, calls any OpenAI-compatible endpoint
              └─ MCP: obsidian-brain    ← long-term memory (Obsidian vault)
```

Claudbot automatically switches to the next provider when a rate limit is detected — no manual intervention needed.

---

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude auth login`)
- Node.js 22 or later
- Git

Optional:
- [OpenAI Codex CLI](https://github.com/openai/codex) — for the second fallback tier
- Docker + Docker Compose — for the sandboxed mode
- [Ollama](https://ollama.com) — to run local sub-agents (e.g. `qwen3:14b`)
- An [NVIDIA NIM](https://www.nvidia.com/en-us/ai/) API key — for the NIM fallback and NIM-powered sub-agents

---

## Quick start (local, no sandbox)

```bash
git clone https://github.com/asuarcia/ClaudBot
cd ClaudBot
npm run setup        # installs MCP server dependencies
node claudbot.mjs    # start the REPL
```

Or install globally so you can run `claudbot` from anywhere:

```bash
npm install -g .
claudbot
```

You'll see the REPL prompt:

```
 claudbot (claude-code)> 
```

Type any prompt and press Enter. Claude Code handles it autonomously.

---

## Sandboxed mode (Docker)

Docker gives Claude an isolated Linux container — it can't touch your host filesystem outside the `workspace/` folder.

### 1. Build the image

```bash
docker compose build
```

### 2. Authenticate (first time only)

Log in to your Claude subscription inside the container. The credentials are stored in a named Docker volume so you only need to do this once:

```bash
docker compose run claudbot claude auth login
```

Follow the browser prompt to complete sign-in.

### 3. Run

```bash
docker compose up
```

### Working with files

Drop any files you want Claude to access into the `workspace/` folder in this repo. That folder is mounted into the container at `/workspace`. Claude can read, edit, and create files there, and you'll see the results on your host.

### Resource limits

The container is capped at **2 CPU cores** and **2 GB RAM** by default. Edit `docker-compose.yml` to adjust:

```yaml
deploy:
  resources:
    limits:
      cpus: "4"
      memory: 4G
```

---

## Configuration

### Sub-agents — `.claudbot/agents.yaml`

Add any OpenAI-compatible model as a sub-agent without touching code. Claude discovers and routes to them automatically.

```yaml
agents:
  - name: researcher
    model: qwen3:14b
    endpoint: http://localhost:11434/v1   # Ollama (local, no key needed)
    apiKeyEnv: null
    jobDescription: >
      Research topics, summarize documents, answer factual questions.

  - name: nemotron
    model: nvidia/llama-3.3-nemotron-super-49b-v1
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NVIDIA_API_KEY
    jobDescription: >
      Deep reasoning and complex multi-step analytical tasks.

  - name: my-custom-agent
    model: meta/llama-3.1-70b-instruct
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NVIDIA_API_KEY
    jobDescription: >
      Describe what this agent is good at so Claude knows when to use it.
```

**Fields:**

| Field | Description |
|-------|-------------|
| `name` | Short identifier. Claude calls agents by this name. |
| `model` | Model ID as the endpoint expects it. |
| `endpoint` | Base URL of any OpenAI-compatible API (`/chat/completions` is appended automatically). |
| `apiKeyEnv` | Name of the environment variable holding the API key. Use `null` for local endpoints (Ollama, LM Studio, etc.). |
| `jobDescription` | Plain English description of what this agent does well. Claude reads this to decide when to delegate. |

### NIM fallback — environment variables

Set these before running (or add to a `.env` file):

```bash
export NIM_API_KEY=nvapi-xxxxxxxxxxxx
export NIM_BASE_URL=https://integrate.api.nvidia.com/v1   # default
export NIM_MODEL=meta/llama-3.1-70b-instruct              # default
```

### Claude Code behavior — `.claudbot/CLAUDE.md`

This file is the system prompt Claudbot runs with. Edit it to change Claude's persona, priorities, or default behavior. It survives updates — it's your config, not part of the program.

### MCP servers — `.claudbot/.claude/settings.json`

MCP servers are declared here. `claudbot-exec` (sub-agent dispatcher) and `obsidian-brain` (Obsidian memory) are pre-configured. Add any MCP server the same way Claude Code supports them.

---

## Memory (Obsidian)

Claudbot writes to an Obsidian vault for long-term memory. By default it looks for a vault at `C:\Repo\MyBrain` (Windows) via the `obsidian-brain` MCP server.

To point it at a different vault, edit `.claudbot/.claude/settings.json`:

```json
{
  "mcpServers": {
    "obsidian-brain": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian", "C:\\path\\to\\your\\vault"]
    }
  }
}
```

Remove the `obsidian-brain` block entirely if you don't use Obsidian — everything else still works.

---

## Provider fallback

Claudbot tries providers in order and switches automatically on rate limit or quota errors:

```
Claude Code  →  (rate limit)  →  Codex CLI  →  (rate limit)  →  NIM endpoint
```

- **Claude Code**: uses your `claude.ai` subscription. No API key needed.
- **Codex CLI**: uses your OpenAI subscription. Requires `codex` on PATH and `OPENAI_API_KEY`.
- **NIM**: HTTP calls to NVIDIA's inference endpoints. Requires `NIM_API_KEY`.

When a provider switch happens, session history is not carried over (each provider starts fresh). The switch is logged to the terminal.

---

## File structure

```
ClaudBot/
├── claudbot.mjs              # Main REPL + provider orchestration
├── providers/
│   ├── base.mjs              # Base class + error types
│   ├── claude.mjs            # Claude Code CLI provider
│   ├── codex.mjs             # OpenAI Codex CLI provider
│   └── nim.mjs               # NVIDIA NIM HTTP provider
├── mcp-servers/
│   └── claudbot-exec/        # MCP server: sub-agent dispatcher
│       └── index.mjs
├── .claudbot/                # Claude Code project directory
│   ├── CLAUDE.md             # Claudbot persona + behavior rules
│   ├── agents.yaml           # Sub-agent registry (edit to add agents)
│   ├── skills/               # Skill files Claude reads automatically
│   └── .claude/
│       └── settings.json     # MCP server declarations + permissions
├── workspace/                # Sandboxed file area (Docker mode)
├── Dockerfile
└── docker-compose.yml
```

---

## Updating

```bash
git pull
npm run setup    # re-run if mcp-server deps changed
```

In Docker:

```bash
git pull
docker compose build
docker compose up
```
