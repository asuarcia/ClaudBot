# Cost routing

**The rule: anything that runs while you are not typing runs on NIM, never on
the Claude plan.**

Enforced by `scripts/check-cost-routing.mjs`, which fails if a background script
ever gains a `claude` spawn. Run it any time:

```
node scripts/check-cost-routing.mjs
```

---

## Routing table

### Background — NIM only

These run unattended: on a timer, on a schedule, at logon, or detached while you
do something else. None of them may invoke the `claude` binary.

| Path | Runs when | Agent | Resolved by |
|---|---|---|---|
| `dream.mjs` | hourly / on a schedule | `researcher` | `CLAUDBOT_DREAM_AGENT` |
| `briefing.mjs` | every 6h in `--watch` | `fast` | `CLAUDBOT_BRIEFING_AGENT` |
| `night.mjs` | nightly bundle | *(spawns the three below)* | — |
| `night-sync.mjs` | every launch | *(no inference — HTTP pull from the NUC)* | — |
| `memory.mjs` | on start and exit, detached | `fast` | `CLAUDBOT_SUMMARY_AGENT` |
| `screen.mjs` | 5-minute heartbeat | `vision` | `CLAUDBOT_SCREEN_AGENT` |
| `organizer.mjs` | web server on :4700 | *(no inference)* | — |
| `dashboard.mjs` | web server on :4500 | *(no inference)* | — |
| `widgets/bridge.mjs` | poll loop feeding the desktop widgets | *(no inference — Finnhub + local files)* | — |
| `channel-server.mjs` | inbound WhatsApp / Telegram | `agent` | `CLAUDBOT_FALLBACK_AGENT` |

Every one of these goes through `providers/agents.mjs → runAgent()`, which reads
`.claudbot/agents.yaml`. Changing an agent for a role is a one-line env change,
not a code change.

### Foreground — Claude is correct

| Path | Why |
|---|---|
| `claudbot.mjs` (`cmdStart`) | the interactive session — this *is* the product |
| `scripts/onboard.mjs` | `claude auth login`, you are at the keyboard |
| `voice/brain.py` | you are speaking to it; a voice turn is foreground work |

`claude auth status` in `doctor` also shells out to the binary, but it does no
inference and costs nothing.

---

## Why `screen.mjs` matters most

Screen awareness polls every five minutes for as long as it is on. At ~290
captures a day, describing those on the Claude plan would be the single largest
line item in the whole system, and it would be spent on frames that mostly say
"still the same editor". So:

1. **Change detection first.** The capture script computes a 64-bit average hash
   itself. Frames within a Hamming distance of 4 are dropped before any model is
   called. On a static screen this is the common case, and it costs nothing.
2. **NIM vision for the rest.** `nvidia/nemotron-nano-12b-v2-vl` — small,
   cheap, ~2.5s, good at reading text off a screen.
3. **Claude sees text, not images.** Only the newest frame path plus a ≤10-entry
   rolling summary is ever loaded. There is no screenshot history to dump.

---

## Agent roster

| Agent | Model | Used for |
|---|---|---|
| `gemini` | Gemini CLI (OAuth) | **default for research / deep-web** |
| `researcher` | `nvidia/nemotron-3-ultra-550b-a55b` | research fallback, planning |
| `coder` | `deepseek-ai/deepseek-v4-pro` | writing and reviewing code |
| `fast` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | summaries, classification, extraction |
| `agent` | `nvidia/nemotron-3-super-120b-a12b` | multi-step automation |
| `longcontext` | `deepseek-ai/deepseek-v4-flash` | huge inputs |
| `vision` | `nvidia/nemotron-nano-12b-v2-vl` | describing screen captures |

### Gemini is the research default

Two reasons it goes ahead of `researcher`:

- **Latency.** `researcher` (Nemotron Ultra) and `longcontext` routinely exceed
  the MCP request cap on large prompts, and the call dies with nothing to show
  for the wait. Gemini Flash finishes inside it.
- **Freshness.** Research questions are usually about the current state of the
  world, which is Gemini's strength.

`researcher` stays registered as the fallback for when Gemini is unavailable,
and for deep reasoning where latency does not matter.

### Gemini runs through the CLI, not the API

The Gemini API is metered per token, and Pro-tier models left its free tier on
2026-04-01 — so the API route means either paying or being capped at Flash. The
CLI is a different door onto the same models: it authenticates with an OAuth
login against a Google AI Pro subscription, which is a flat monthly price the
user already pays. Marginal cost per research call is therefore zero, the quota
is ~1,500 requests/day, and Pro-tier models are in scope again.

That is why `claudbot-exec` grew a `transport: cli` mode. The agent is spawned
as a subprocess instead of POSTed to:

- `-p` forces headless mode; the real prompt goes in on **stdin**, which keeps
  untrusted text out of `argv` and dodges the ~32k Windows command-line limit.
- `--approval-mode plan` keeps the CLI read-only — a research agent has no
  business editing files — and `--skip-trust` stops that mode from being
  silently downgraded to interactive, which would hang a headless run forever.
- `spawn` runs with `shell: false`, always. On Windows npm installs JS bins as
  `.cmd` shims that `spawn` cannot execute, so `resolveCliCommand()` unwraps the
  shim and runs the real `.js` under the current node binary rather than
  reaching for a shell.

**Setup:** `npm install -g @google/gemini-cli`, then run `gemini` once and
complete the browser login with the account holding the subscription. Auth is
cached in `~/.gemini/`; every later call is non-interactive.

`GEMINI_API_KEY` is now optional. If it is set, the HTTP endpoint stays as an
automatic fallback for when the CLI is missing or logged out — keep the key in
`.env`, never in `agents.yaml` (the registry stores the env var *name*, never a
value).

---

## Practical notes

**NIM key contention is real.** TradeAlgo batch jobs and the dream loop have hit
429s at the same time. Anything new that calls NIM on a loop needs backoff —
`screen.mjs` retries at 2s / 4s / 8s on 429 and 5xx.

**Adding a new background job?** Two things:

1. Route it through `runAgent()` with a role env var, following the pattern in
   `briefing.mjs`.
2. Add its filename to `BACKGROUND` in `scripts/check-cost-routing.mjs`, so the
   guard covers it from day one.
