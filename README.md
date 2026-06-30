# Claudbot

An autonomous agent program built on top of Claude Code. It runs like an app, works autonomously — reading files, executing commands, browsing the web, writing code — and delegates specialized tasks to sub-agents on any provider. When you hit your Claude rate limit it automatically falls back to NIM so you keep working.

**Cost philosophy:** no per-token billing on the main agent. Claude Code (subscription) is the brain. NIM or any OpenAI-compatible endpoint powers the fallback and all sub-agents.

---

## Install

```bash
git clone https://github.com/asuarcia/ClaudBot && cd ClaudBot && npm run setup && npm install -g .
claudbot onboard
```

That's it. `onboard` walks you through everything — Claude auth, fallback provider, sub-agents, WhatsApp/Telegram channels, safety restrictions, and permission mode — and writes your keys to a gitignored `.env`. When it's done, just run:

```bash
claudbot
```

> Prefer to configure by hand? Copy [`.env.example`](.env.example) to `.env` and fill in the values. The real `.env` is gitignored — never commit it.

---

## Commands

All commands go through `claudbot`:

| Command | What it does |
|---------|-------------|
| `claudbot` | Start the agent (default mode) |
| `claudbot start --mode auto` | Start with a specific permission mode |
| `claudbot restart` | Restart the running agent without closing the terminal |
| `claudbot recall` | List past sessions — pick up where you left off after a reboot |
| `claudbot recall last` | Summarize the previous session |
| `claudbot recall <text>` | Search past sessions for `<text>` |
| `claudbot channels` | Start the WhatsApp / Telegram webhook server |
| `claudbot dream` | Run background tasks once (memory, research, reflection) |
| `claudbot dream --watch` | Run background tasks on a continuous schedule |
| `claudbot onboard` | Re-run the setup wizard |
| `claudbot update` | Pull latest code from GitHub + reinstall deps |
| `claudbot doctor` | Health check — Claude auth, API keys, sub-agents, channels |
| `claudbot help` | Show all commands |

---

## Architecture

```
claudbot
    │
    ├── Primary:  Claude Code (subscription, no per-token cost)
    │       │
    │       ├── claudbot-exec MCP  →  sub-agents (any OpenAI-compatible endpoint)
    │       └── obsidian-brain MCP →  long-term memory (Obsidian vault)
    │
    └── Fallback: NIM (kicks in automatically when Claude hits rate limit)
```

Claude Code is the backend. It has full tool access built in — file system, bash, web search, git — with no extra setup. Claudbot wraps it with a persona, safety restrictions, multi-provider sub-agents, messaging channels, and dreaming.

---

## Permission modes

Controls what Claude can do without asking first:

| Mode | Command | Behavior |
|------|---------|----------|
| `full` | `claudbot` | Everything, no prompts — restrictions still apply |
| `auto` | `claudbot start --mode auto` | Runs safe ops automatically, asks before risky ones |
| `safe` | `claudbot start --mode safe` | Edits files freely, asks before every bash command |
| `readonly` | `claudbot start --mode readonly` | No file edits or bash at all |

The active mode is shown in the startup banner.

---

## Safety restrictions

Claudbot ships with 40+ deny rules pre-enabled — destructive deletes, disk/boot commands, registry edits, remote code execution, force pushes, and writes to system paths and credentials. They're enforced even in full-autonomous mode.

Manage them in `.claudbot/restrictions.yaml`. All rules are on by default. Remove a line to lift that restriction. The file reloads on every start — no restart needed.

```yaml
deny:
  - "Bash(rm -rf *)"
  - "Bash(format *)"
  - "Bash(curl * | bash)"
  - "Bash(git push --force *)"
  - "Write(C:/Users/*/.ssh/*)"
  # ... 35+ more
```

During onboarding you can deselect any rules you want to remove.

---

## Sub-agents

Add any model at any OpenAI-compatible endpoint as a sub-agent. Claude reads `agents.yaml` and delegates tasks automatically — you can also just ask it directly ("use the researcher agent for this").

```yaml
agents:
  - name: researcher
    model: meta/llama-3.1-70b-instruct
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NIM_API_KEY
    jobDescription: >
      Research topics, summarize documents, answer factual questions.

  - name: coder
    model: deepseek-ai/deepseek-r1
    endpoint: https://integrate.api.nvidia.com/v1
    apiKeyEnv: NIM_API_KEY
    jobDescription: >
      Code generation, debugging, and refactoring.

  - name: local
    model: llama3.2
    endpoint: http://localhost:11434/v1
    apiKeyEnv: null
    jobDescription: >
      Fast local model for lightweight tasks. No API key needed.
```

Supported providers out of the box (configured during onboarding): NVIDIA NIM, OpenAI, Anthropic, Google Gemini, Mistral, Groq, Together AI, OpenRouter, xAI, Cohere, DeepInfra, Fireworks, Ollama, LM Studio, vLLM, Custom.

Edit `agents.yaml` anytime — changes take effect in the current session without restarting.

---

## WhatsApp & Telegram

Start the channel server in a separate terminal:

```bash
claudbot channels
```

Add these to your `.env` for WhatsApp (via Twilio):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

And for Telegram:

```
TELEGRAM_BOT_TOKEN=xxxxxxxxxxxx
```

### Locking it down (recommended)

A public webhook is an open door to a paid API. Onboarding sets these automatically from your own number/chat, but you can edit them in `.env`:

```
# Only these senders get answered (comma-separated). Leave unset = anyone.
WHATSAPP_ALLOWED_NUMBERS=whatsapp:+15551234567
TELEGRAM_ALLOWED_CHAT_IDS=12345678

# Optional: require Telegram's secret-token header (set via setWebhook)
TELEGRAM_WEBHOOK_SECRET=some-long-random-string
```

WhatsApp requests are additionally verified with Twilio's HMAC signature, and unknown senders are rejected before any API call. The server warns at startup if a channel is left open with no allowlist.

Register the webhook URLs in your provider dashboard:

```
WhatsApp  →  https://your-domain/webhook/whatsapp
Telegram  →  https://your-domain/webhook/telegram
```

For local testing, expose port 3000 with ngrok:

```bash
npx ngrok http 3000
```

**Getting a WhatsApp number:**
- **Sandbox (free, instant):** Go to [twilio.com/console/messaging/whatsapp/sandbox](https://www.twilio.com/console/messaging/whatsapp/sandbox) — no approval needed, works immediately for testing
- **Production number:** Buy a Twilio number (~$1/month) and apply for WhatsApp Business API access

Channels use NIM for responses and maintain per-user conversation history. Twilio webhooks are signature-validated so only real Twilio requests are accepted.

---

## Dreaming

Background autonomous mode — Claudbot thinks and learns when you're not actively using it.

```bash
claudbot dream            # run all tasks once
claudbot dream --watch    # run on a continuous schedule
claudbot dream --task memory  # run one specific task
```

Default tasks (all configurable in `.claudbot/dream-tasks.yaml`):

| Task | What it does | Default interval |
|------|-------------|-----------------|
| `memory` | Consolidates recent work into Obsidian notes | 1 hour |
| `reflection` | Analyzes performance and generates improvement actions | 2 hours |
| `research` | Proactively researches topics that came up recently | 3 hours |
| `planning` | Thinks ahead about upcoming work | 4 hours |

Outputs are logged to `.claudbot/dream-log.md`.

Dreaming runs on its own agent (default `researcher` → Nemotron 3 Ultra), set via
`CLAUDBOT_DREAM_AGENT`. This is deliberately **separate** from the fallback agent
(`CLAUDBOT_FALLBACK_AGENT`, default `agent` → Kimi K2.6, used when Claude Code hits
its rate limit) so a dream cycle and a rate-limit fallback never contend for the
same model. Both names resolve against `agents.yaml`. Individual dream tasks can
override the model with an `agent:` field in `dream-tasks.yaml`.

---

## Conversation memory (recall)

Claudbot remembers past sessions so you can reboot and pick up where you left off.
It reuses the transcripts Claude Code already writes (no extra capture), so:

```bash
claudbot recall          # list recent sessions, newest first
claudbot recall last     # LLM summary of the previous session — "where we left off"
claudbot recall <text>   # full-text search across every past session
```

Every `claudbot start` also prints a one-line "Last session" banner. Summaries are
generated by `CLAUDBOT_SUMMARY_AGENT` (default `fast` → Nemotron Nano) and cached in
`.claudbot/conversation-index.json`.

---

## Memory (Obsidian)

Claudbot writes to an Obsidian vault for long-term memory across sessions. Configure the vault path during onboarding or edit `.claudbot/.claude/settings.json`:

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

Remove the block entirely if you don't use Obsidian.

---

## Updating

```bash
claudbot update
```

Pulls the latest code from GitHub, shows what changed, and reinstalls dependencies — all in one command.

---

## Extra isolation (optional)

The built-in restrictions cover the critical safety rules. If you want stronger isolation — for example letting Claudbot work in a fully sandboxed environment — run it inside a VM or a Docker container. That way it can't touch anything outside the container regardless of what it tries. This is worth doing if you're using full-autonomous mode on sensitive machines.

---

## Configuration files

| File | What it controls |
|------|-----------------|
| `.claudbot/CLAUDE.md` | Claudbot persona and behavior rules |
| `.claudbot/agents.yaml` | Sub-agent registry |
| `.claudbot/restrictions.yaml` | Deny rules — enforced in all modes |
| `.claudbot/dream-tasks.yaml` | Dream task definitions and intervals |
| `.claudbot/channels.yaml` | Channel credentials (gitignored) |
| `.claudbot/.claude/settings.json` | MCP permissions and trusted servers |
| `.env` | API keys (gitignored) |

---

## File structure

```
ClaudBot/
├── claudbot.mjs              # CLI entry point — all commands go here
├── channel-server.mjs        # WhatsApp / Telegram webhook server
├── dream.mjs                 # Background autonomous tasks
├── providers/
│   ├── base.mjs              # Base class + error types
│   └── nim.mjs               # NIM HTTP provider (fallback)
├── scripts/
│   └── onboard.mjs           # Interactive setup wizard
├── mcp-servers/
│   └── claudbot-exec/        # MCP: sub-agent dispatcher
│       └── index.mjs
├── .claudbot/                # Claude Code project directory
│   ├── CLAUDE.md             # Persona + behavior rules
│   ├── agents.yaml           # Sub-agent registry
│   ├── restrictions.yaml     # Deny rules (pre-populated)
│   ├── dream-tasks.yaml      # Dream task config (auto-generated)
│   └── .claude/
│       └── settings.json     # MCP trust + tool permissions
└── .env                      # API keys (gitignored)
```
