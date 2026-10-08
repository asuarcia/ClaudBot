# The orchestrator

Claudbot used to *be* Claude Code. The TUI was the top-level agent, the NIM
roster hung off it through the `claudbot-exec` MCP server, and that arrangement
had two costs that only showed up with use.

The first was money. Every turn went to the Claude plan — "what's the capital of
France" cost the same as a refactor, because there was only one thing to ask.
The second was structural: Claudbot's identity was welded to one vendor's
harness. Swapping the model meant swapping the whole assistant.

The stack is now three deep:

```
you
 └─ orchestrator        any model, via an OpenAI-compatible gateway
     ├─ claude_code     Claude Code headless: files, git, bash, web, MCP
     │   └─ NIM roster  (its own claudbot-exec delegations)
     └─ NIM roster      direct, for work that needs no filesystem
```

The orchestrator's job is judgment, not labour. It owns the conversation and
decides, per turn, between three options:

| Route | When | Cost |
|---|---|---|
| Answer itself | Conversation, recall, opinion, things it knows | free |
| `run_agent` | Self-contained text work — summarise, classify, extract, draft | cents |
| `claude_code` | Anything needing *hands*: files, repos, git, shell, live web | real money |

Chat stays cheap. Real work still gets the good agent.

## Running it

```bash
claudbot                  # the orchestrator (new default)
claudbot brain            # the orchestrator, explicitly
claudbot brain --model auto/best-coding
claudbot start --claude   # the old Claude Code TUI
```

`claudbot project <repo>` is deliberately **unchanged** and still goes straight
to Claude Code. The point of a project chat is Claude sitting inside the repo
with its files and its own `CLAUDE.md`; putting a router in front of that would
add a hop and subtract context.

Setting `CLAUDBOT_ORCHESTRATOR=0` restores the old default for a bare
`claudbot`.

## The gateway

The model out front comes through [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
(MIT), an OpenAI-compatible gateway that fronts hundreds of providers with
quota-aware fallback:

```bash
npm install -g omniroute
omniroute                 # API + dashboard on http://localhost:20128
```

`claudbot` starts the gateway itself when it is installed and not running, so
after a reboot the first launch is slower rather than quietly worse. Set
`CLAUDBOT_GATEWAY_AUTOSTART=0` to manage the process elsewhere.

**OmniRoute is optional and Claudbot never depends on it.** It is an 830MB
global install, which is larger than the entire portable Claudbot drive, so it
deliberately does not ship there. When no gateway answers, the orchestrator
resolves a registered NIM agent from `.claudbot/agents.yaml` instead
(`CLAUDBOT_ORCHESTRATOR_AGENT`, default `agent`) and carries on. It is the same
client class either way — only the coordinates change.

### The catalog is a menu, not an inventory

`/models` lists 115 ids and `/v1/models` claims 100 of them do tool calling.
Both numbers are close to meaningless. Every concrete id was called on
2026-08-27 and **71 of 73 were unreachable**, for reasons that are structural
rather than transient:

| Family | Count | What actually happens |
|---|---|---|
| `aug/*` — opus4.8, sonnet5, gpt5.6, gemini-3.1-pro | 28 | `502` — OmniRoute shells out to an `auggie` CLI that is not installed |
| `tllm/*` — CLAUDE_4_6_SONNET, gemini_3_pro, GPT_5_4 | 26 | `403` — "blocked by Vercel for this server egress IP"; wants a residential proxy |
| `ddgw/*`, `felo/*` | 11 | no tool calling, and the pools report `400` from them |
| the remainder | 6 | `400`/`401`/`429` — retired, unsupported, or rate-limited |

Two answer: **`oc/hy3-free`** and **`oc/nemotron-3-ultra-free`**. Every `auto/*`
pool tested — `smart`, `chat`, `cheap`, `best-free`, even `offline` — failed
over onto `hy3-free`. The 38 pools are not 38 routes; they are one route with
38 names.

This is worth restating because the dashboard makes it look otherwise: the
gateway is a free, working, tool-calling model with a very long menu in front of
it. It is not unlimited access to frontier models. Unlocking the `aug/*` family
means installing the `auggie` CLI and signing into an Augment Code account;
unlocking `tllm/*` means routing OmniRoute's egress through a residential proxy.

### The default model

`auto/best-chat`, chosen on measurement rather than on the name. Six
tool-calling turns each, 2026-08-27:

| Pool | Succeeded | Routed correctly | Median |
|---|---|---|---|
| `auto/best-chat` | 6/6 | 6/6 | 2.4s |
| `auto/chat` | 6/6 | 6/6 | 2.5s |
| `auto/smart` | 6/6 | 6/6 | 2.6s — but `429`'d on a plain chat turn in an earlier round |
| `oc/nemotron-3-ultra-free` | 5/6 | 5/6 | 4.8s |

"Routed correctly" means it delegated a file task to `claude_code` and answered
`17 × 23` itself. A pool id rather than `oc/hy3-free` directly, deliberately: the
pool keeps working when the backend behind it changes, and a pinned id does not.

### 2026-10-07: the last working route closed

Both models above came through one keyless connection, `opencode`, and it was
the **only** connection configured. OpenCode then locked its free tier to its
own client and retired the rest — every member of every pool, re-probed:

| Member | Result |
|---|---|
| `oc/big-pickle`, `oc/nemotron-3-ultra-free` | `403` "OpenCode's free tier can only be used from within OpenCode" |
| `oc/hy3-free`, `oc/deepseek-v4-flash-free`, `oc/mimo-v2.5-free`, `oc/north-mini-code-free` | `401` "Model … is not supported" |
| `felo/*` (the rest of every pool) | `400`/`429` "Felo thread creation failed" |

`/v1/models` still listed 115 ids and `health()` still said yes. Each chat turn
spent ~5s and three retries before printing a kilobyte of JSON.

OmniRoute 3.8.51+ has a workaround that dresses requests up as the OpenCode
client (`opencodeFreeTierContract.ts`). Claudbot deliberately does **not** rely
on it: it exists to get around the vendor's restriction, OmniRoute's own ToS
audit rates `opencode` "avoid", and a route that depends on impersonation can
close again at any time.

### Making the gateway worth running

OmniRoute's value is failover **across providers**. With no keys it has
nothing to fail over between. The pools fill with real members only when API
keys are added, and in 3.8.49 that is **dashboard-only** — verified, not taken
from the docs:

- `NVIDIA_API_KEY` in the gateway's environment is documented but ignored for
  chat: `nvidia/…` returns `404 No active credentials for provider: nvidia` and
  the pools are unchanged.
- `provider-credentials.json` only overrides OAuth client ids.
- `/api/providers` requires the dashboard login; the CLI has no `add`.

The management API behind the dashboard, though, is scriptable — and
`scripts/gateway-sync.mjs` uses it, so `.env` is the one place keys live:

```bash
# put any of these in .env, then:
#   GEMINI_API_KEY  GROQ_API_KEY  MISTRAL_API_KEY  OPENROUTER_API_KEY
#   COHERE_API_KEY  SAMBANOVA_API_KEY  LLM7_API_KEY  (+ OMNIROUTE_PASSWORD)
npm run gateway:sync          # add providers, re-verify, rebuild the combo
npm run gateway:sync -- --dry # report only; makes no model calls
```

For each provider with a key it creates the connection (once), re-tests it —
which also re-activates one OmniRoute switched off — then calls up to eight of
its chat models and keeps the first two that **answer and make a tool call**.
Those become the `claudbot` combo (priority order: gemini, groq, mistral,
openrouter, cohere, sambanova, llm7), which is the orchestrator's default model
and what the `gateway` agents use. A 429 stops probing that provider: free-tier
limits are per account, so the other models are throttled too. NVIDIA is left
out on purpose; it is managed by hand.

### Why a combo and not the `auto/*` pools

The pools are assembled from OmniRoute's built-in catalog, which goes stale.
When llm7 was first connected, the pools routed to `llm7/gpt-4.1-nano` — no
longer served anonymously — and the 401 made OmniRoute **deactivate the whole
llm7 connection**, killing its working models too. The stale ids are now hidden
(`PATCH /api/provider-models`), and Claudbot routes only through the combo,
whose members were each called before they were added.

### What a key-less setup gets you: almost nothing

Probed 2026-10-07, every provider OmniRoute can use without an account:

| Provider | Result |
|---|---|
| `llm7` (any key) | 11 "turbo" models serve anonymously, ~4 requests a **minute** shared, plus a daily token cap. 3 verified with tools. |
| `pollinations` | the new API is paid; only `openai-fast` (GPT-OSS 20B) is anonymous, and it 401'd through OmniRoute |
| `uncloseai` | OmniRoute's built-in alias rewrites the one live model to a retired one → 404 |

So the `claudbot` combo currently holds three llm7 models, and on a throttled
minute the orchestrator fails over to NIM — which is correct, but means the
gateway only becomes a real brain once a keyed provider is synced in.

### How Claudbot copes when it does not answer

All client-side, so it holds whatever OmniRoute does next:

- **Probe, don't list.** `GatewayProvider.serves()` makes one real completion.
  Startup, `doctor`, and `/model <id>` all use it, so a dead model is a one-line
  warning, not a failed turn.
- **Never wait for the boot.** If the gateway is down, the conversation opens
  on the NIM fallback immediately, the gateway boots in the background, and the
  brain switches over between turns once it answers.
- **Fail over mid-session.** A gateway turn that fails after retries is replayed
  on the NIM fallback, which then holds for the session. `/model <id>` goes back.
- **Roster fallback.** `gateway` falls back to `fast`, `gateway-ultra` to
  `researcher` (the `fallback:` field in `agents.yaml`, one hop, with a note on
  the output saying so).
- **Readable errors.** Only OmniRoute's `error.message` is shown.
- **No browser.** The autostart runs `omniroute serve --no-open --no-tray`;
  the bare command opens the dashboard on every boot.

## Gateway models as roster agents

The gateway is not only the brain's connection — it is also two entries in
`.claudbot/agents.yaml`, so `run_agent` can spend nothing instead of NIM credit:

| Agent | Model | Replaces (and falls back to) |
|---|---|---|
| `gateway` | `claudbot` | `fast` — summaries, drafting, classification, extraction |
| `gateway-ultra` | `claudbot` | `researcher` — reasoning, planning, trade-offs |

They carry `apiKeyEnv: null` because loopback needs no key, and that is what
made them impossible before: `runAgent` was written against NIM and inherited
none of the gateway handling in `providers/gateway.mjs`. Adding a gateway agent
to the registry used to fail immediately — the request omitted `stream`, so
OmniRoute streamed SSE and `res.json()` threw on `data: {…}`. Three more
followed behind it: `Bearer none` sent as an Authorization header, `content:
null` from a reasoning model reported as "empty response", and a pool member's
`401` treated as terminal. `runAgent` now handles all four, and
`test/orchestrator.test.mjs` pins each one against a stub gateway.

## Choosing the brain

Three steps, in order of how explicitly the user asked for it:

1. **`CLAUDBOT_BRAIN=<agent>`** — run the orchestrator on a named registry
   agent. `CLAUDBOT_BRAIN=gateway` is the free path; any entry works.
2. **The gateway**, started if installed and idle (`OMNIROUTE_MODEL`, default
   `auto/best-chat`).
3. **`CLAUDBOT_ORCHESTRATOR_AGENT`** (default `agent`) — a NIM agent, so a
   machine with no gateway still has a working assistant.

Step 2 starting the process is the point of the whole arrangement. OmniRoute is
a long-running server with no service registration: nothing starts it after a
reboot, so a gateway that was installed and configured would silently drop to
step 3, and the only symptom was that the assistant had quietly got worse.

## Gotchas

All three were found by calling OmniRoute 3.8.49, not by reading its docs. Each
one silently breaks a textbook OpenAI client.

### 1. `stream` must be sent explicitly as `false`

Omitting the field is **not** the same as `false`. OmniRoute streams SSE by
default, so a client that only sets `stream: true` on its streaming path gets
back `data: {...}` lines where it expected a JSON body, and `JSON.parse` dies on
the first token. The existing `providers/nim.mjs` client has this bug latent —
it works against NIM only because NIM defaults the other way.

### 2. `content` is `null` on reasoning models, and reasoning eats the budget

The free pool routes to reasoning backends. They put their trace in a separate
`reasoning_content` field and leave `content` as `null` until they are finished.
Code that treats `content` as a string throws; code that treats `null` as "empty
answer" silently drops replies.

Worse, reasoning spends the completion allowance *before* writing a word. A
request with `max_tokens: 30` came back `finish_reason: "length"`, `content:
null`, and nothing else — the model had thought its way through the entire
budget. The default here is **8192** for that reason, and a tight cap on a
reasoning model is always a bug.

### 3. Pool members fail transiently and individually

Observed live: `auto/smart` returned

```
HTTP 401  Model north-mini-code-free is not supported [oc/north-mini-code-free (401)]
```

while five healthy backends sat behind it in the same pool. The identical
request succeeded seconds later on a different member.

A normal client treats 401 as terminal — it means a bad key, and retrying a bad
key is pointless forever. Here it means "the pool picked a broken member", and
retrying works. Getting this wrong makes the orchestrator look broken roughly
one turn in five.

OmniRoute annotates these bodies itself:

```json
"recovery": { "action": "retry", "next_step": "The combo failed transiently…" }
```

`providers/gateway.mjs` retries on 429, on 5xx, **or** on the presence of that
marker — three attempts, backing off from 800ms.

## Session continuity

`claude_code` is not a one-shot command; it is a stateful sub-orchestrator.

A UUID is minted per conversation. The first call passes `--session-id <uuid>`,
every later call passes `--resume <uuid>`, so Claude Code accumulates context
across the orchestrator's turns — it remembers the repo it just explored and the
file it just edited, and can be followed up with rather than re-briefed.

The id is minted locally rather than read back off the first response, so a
first call that crashes can still be resumed instead of orphaning its context.
The session is only marked live once a call has actually succeeded; otherwise a
failed first attempt would send `--resume` for an id Claude Code never created,
and every subsequent call would fail too.

Verified end to end: call 1 was told to reply `ALPHA`; call 2 asked what it had
just said and answered `ALPHA`, in the same session.

`/reset` clears **both** the conversation and Claude Code's session, so a new
topic does not inherit the last one's half-finished exploration.

## Slash commands

Handled by the orchestrator before any model call:

```
/agents               list the specialist sub-agents
/agent <name> <task>  call one directly, bypassing the orchestrator
/claude <task>        call claude_code directly
/model [id]           show or switch the orchestrator model
/models [filter]      list what the gateway can serve
/cost                 what claude_code has spent this session
/verbose              toggle showing the model's reasoning trace
/reset                clear the conversation AND claude_code's session
/help                 this list
/exit                 quit
```

`/agent` and `/claude` exist as guaranteed paths. If a model refuses to
tool-call — and small free models sometimes do — delegation still works by hand.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OMNIROUTE_URL` | `http://localhost:20128/v1` | Gateway base URL |
| `OMNIROUTE_MODEL` | `claudbot` | Which model or pool runs the orchestrator |
| `OMNIROUTE_API_KEY` | *(unset)* | Only needed for a non-loopback gateway |
| `CLAUDBOT_ORCHESTRATOR` | `1` | `0` makes a bare `claudbot` open Claude Code |
| `CLAUDBOT_ORCHESTRATOR_AGENT` | `agent` | NIM agent used when no gateway answers |
| `CLAUDBOT_CLAUDE_MODEL` | *(unset)* | Model for the `claude_code` tool |
| `CLAUDBOT_CLAUDE_TIMEOUT_MS` | `900000` | Real work — installs, test suites — is slow |

## Files

- `orchestrator.mjs` — the REPL, the system prompt, tool dispatch and routing.
- `providers/gateway.mjs` — the OpenAI-compatible client: health, chat with
  tools, streaming, and the retry rules above.
- `providers/claude-code.mjs` — headless Claude Code as a callable tool, with
  session continuity and cost accounting.

## Cost routing

`scripts/check-cost-routing.mjs` enforces the standing rule that nothing running
while the user is away may bill the Claude plan. The orchestrator is a
**foreground** path — the user is sitting there typing — so `claude_code` is
legitimate there.

The guard was extended alongside this change: it now also fails a background
script that *imports* `providers/claude-code.mjs`, not just one that spawns the
`claude` binary directly. Wrapping the binary in a provider module made the
original check trivially bypassable by accident.
