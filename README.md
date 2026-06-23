# Claudbot

An autonomous agent program built on top of Claude Code. Launch it like any app, talk to it in a terminal, and it works autonomously — reading files, running commands, browsing the web, writing code, and delegating specialized tasks to sub-agents.

**Cost philosophy**: no per-token API billing on the main agent. The primary engine runs on a Claude subscription. A NIM endpoint serves as automatic fallback if a rate limit is hit. Sub-agents also run on NIM (or any OpenAI-compatible endpoint you choose).

---

## Architecture

```
You (terminal)
     │
     ▼
 Claudbot REPL              ← Node.js program (this repo)
     │
     ├─ Primary:   Claude Code CLI    (subscription-based, no per-token cost)
     └─ Fallback:  NVIDIA NIM         (HTTP, kicks in on rate limit)
              │
              ├─ MCP: claudbot-exec   ← sub-agent dispatcher
              │        reads agents.yaml, calls any OpenAI-compatible endpoint
              └─ MCP: obsidian-brain  ← long-term memory (Obsidian vault)
```

Claudbot automatically switches to NIM when Claude Code hits a rate limit — no manual intervention needed.

---

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude auth login`)
- Node.js 22+
- Git
- An [NVIDIA NIM](https://www.nvidia.com/en-us/ai/) API key (for fallback + sub-agents)

Optional:
- Docker + Docker Compose — for the sandboxed mode
- [Ollama](https://ollama.com) — to run local sub-agents

---

## Installation

```bash
git clone https://github.com/asuarcia/ClaudBot
cd ClaudBot
npm run setup      # install dependencies
npm run onboard    # interactive setup wizard
```

The onboarding wizard walks you through:
1. **Risk acknowledgment** — understand what autonomous mode means
2. **Claude Code auth** — log in to your Claude subscription
3. **NIM API key** — for fallback + sub-agent inference
4. **Obsidian vault** — optional long-term memory
5. **Sub-agents** — create as many as you want (name, endpoint, model, description)
6. **Channels** — connect Discord, Telegram, Slack, or WhatsApp
7. **Restrictions** — hard-block specific commands or file paths
8. **Permission mode** — choose your default autonomy level
9. **Health check** — verify everything is working

After onboarding, start Claudbot:

```bash
source .env          # load API keys written by onboarding
node claudbot.mjs
```

Or install globally:

```bash
npm install -g .
source .env
claudbot
```

You'll see the REPL prompt:

```
 claudbot (claude-code)>
```

Type any prompt and press Enter. Claude Code handles it autonomously. If it hits a rate limit, Claudbot switches to NIM automatically.

---

## Permission modes

Control what Claude is allowed to do without needing Docker:

| Mode | Flag | What Claude can do |
|------|------|--------------------|
| `full` | *(default)* | Everything — no prompts, no restrictions |
| `auto` | `--mode auto` | Runs safe ops automatically, asks before risky ones |
| `safe` | `--mode safe` | Edits files freely, asks before every bash command |
| `readonly` | `--mode readonly` | Read and plan only — no file edits, no bash |

```bash
claudbot                  # full autonomous (default)
claudbot --mode auto      # asks before risky shell ops
claudbot --mode safe      # asks before any bash command
claudbot --mode readonly  # pure read-only analysis
```

The active mode is shown in the startup banner.

---

## Sandboxed mode (Docker)

Docker gives Claude an isolated Linux container — it can't touch your host filesystem outside the `workspace/` folder.

### 1. Build the image

```bash
docker compose build
```

### 2. Authenticate (first time only)

```bash
docker compose run claudbot claude auth login
```

Follow the browser prompt. Credentials persist in a named Docker volume.

### 3. Run

```bash
docker compose up
```

### Working with files

Drop files into `workspace/` on your host — that folder is mounted into the container at `/workspace`. Claude can read, edit, and create files there.

### Resource limits

Defaults: **2 CPU cores / 2 GB RAM**. Edit `docker-compose.yml` to change:

```yaml
deploy:
  resources:
    limits:
      cpus: "4"
      memory: 4G
```

---

## Sub-agents — `.claudbot/agents.yaml`

Add any model at any OpenAI-compatible endpoint as a sub-agent. Claude reads this file and routes tasks to sub-agents automatically — no code changes needed.

```yaml
agents:
  - name: researcher
    model: meta/llama-3.1-70b-instruct
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NIM_API_KEY
    jobDescription: >
      Research topics, summarize documents, answer factual questions.
      Best for: web research, summarization, literature review.

  - name: nemotron
    model: nvidia/llama-3.3-nemotron-super-49b-v1
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NIM_API_KEY
    jobDescription: >
      Deep reasoning and complex multi-step problem solving.
      Best for: hard analytical tasks, evaluation, long-context reasoning.

  - name: my-agent
    model: any-model-id
    endpoint: https://any-openai-compatible-endpoint/v1
    apiKeyEnv: MY_API_KEY_ENV_VAR
    jobDescription: >
      Describe what this agent does so Claude knows when to delegate to it.
```

**Fields:**

| Field | Description |
|-------|-------------|
| `name` | Short identifier. Claude calls agents by this name. |
| `model` | Model ID as the endpoint expects it. |
| `endpoint` | Base URL of any OpenAI-compatible API (`/chat/completions` is appended automatically). |
| `apiKeyEnv` | Name of the env var holding the API key. Use `null` for local endpoints (Ollama, LM Studio). |
| `jobDescription` | Plain English description. Claude reads this to decide when to delegate. |

---

## NIM configuration

Set these before running (or add to a `.env` file you source):

```bash
# Required for fallback + NIM-based sub-agents
export NIM_API_KEY=nvapi-xxxxxxxxxxxx

# Optional — these are the defaults
export NIM_BASE_URL=https://integrate.api.nvidia.com/v1
export NIM_MODEL=meta/llama-3.1-70b-instruct
```

---

## Memory (Obsidian)

Claudbot writes to an Obsidian vault for long-term memory. Default vault path: `C:\Repo\MyBrain`.

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

Remove the `obsidian-brain` block entirely if you don't use Obsidian.

---

## Configuration files

| File | What it controls |
|------|-----------------|
| `.claudbot/agents.yaml` | Sub-agent registry — add/remove agents here |
| `.claudbot/CLAUDE.md` | Claude's persona, behavior rules, session checklist |
| `.claudbot/.claude/settings.json` | MCP server declarations and tool permissions |
| `docker-compose.yml` | Container resource limits, volume mounts, env vars |

---

## File structure

```
ClaudBot/
├── claudbot.mjs              # Main REPL + provider orchestration
├── providers/
│   ├── base.mjs              # Base class + error types
│   ├── claude.mjs            # Claude Code CLI provider (primary)
│   └── nim.mjs               # NVIDIA NIM HTTP provider (fallback)
├── mcp-servers/
│   └── claudbot-exec/        # MCP server: sub-agent dispatcher
│       └── index.mjs
├── .claudbot/                # Claude Code project directory
│   ├── CLAUDE.md             # Claudbot persona + behavior rules
│   ├── agents.yaml           # Sub-agent registry (edit freely)
│   ├── skills/               # Skill files Claude uses automatically
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
npm run setup    # re-run if MCP server deps changed
```

In Docker:

```bash
git pull
docker compose build
docker compose up
```
