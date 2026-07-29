# Claudbot v2 — build plan

Voice, device control, screen awareness, cost routing, project chats.
Written 2026-07-28 at HEAD `f7c6899`. Live repo: `C:\Users\casuro\claudbot`.

---

## Phase 0 — Recon findings

**Repo state.** `git status` clean, `claudbot doctor` green (2 optional warnings:
Twilio + Telegram not configured — channels inactive by design).

**Stale clone verdict — `C:\Repo\Claudbot`.** Same `origin`
(`github.com/asuarcia/ClaudBot.git`), HEAD `be8c027`. It has **4 commits that are
not in the live repo** (`8e4621a`, `ab59ce8`, `0f34a03`, `be8c027`) — they touch
`.claudbot/CLAUDE.md`, `agents.yaml`, `restrictions.yaml`, `.env.example`,
`claudbot.mjs`. All four are superseded: the live repo's roster, restrictions and
NIM-fallback code are far past them. The only content with any residual value is
the Proxmox NUC access block, which is already captured in Claudbot's memory.
Two untracked vendor dirs (`NemoClaw-main`, `openclaw-main`) are *not* tracked by
git and exist only there.

> **Verdict: safe to delete** once you've confirmed you don't want
> `NemoClaw-main` / `openclaw-main`. Those two are unversioned third-party
> checkouts — nothing else is unique. (A copy of the divergent diffs was taken to
> scratchpad during recon.)

**Existing architecture worth building on.**

| Piece | File | Note |
|---|---|---|
| CLI router | `claudbot.mjs` | `main()` switch; add `voice` / `screen` / `project` here |
| Boot menu | `menu.mjs` | `MENU_ITEMS` array; length-agnostic renderer |
| Sub-agent dispatch | `providers/agents.mjs` | shared by MCP server + NIM REPL |
| Conversation memory | `memory.mjs` | parses `~/.claude/projects/<encoded-cwd>/*.jsonl`, caches LLM summaries in `.claudbot/conversation-index.json` |
| MCP pattern | `mcp-servers/claudbot-exec/index.mjs` | hand-written JSON Schema, `.env` self-loading |

**AITOR voice subsystem** (`C:\Repo\AITOR\Backend`): `voice.py` (RMS-VAD capture
+ Riva Parakeet ASR + Google fallback + Kokoro TTS + `stop_speaking`),
`wake_word.py` (openWakeWord single continuous 1280-frame stream, `hey_jarvis`),
`_future/` (parked Porcupine + custom-oww notes + Colab training doc).

---

## Phase 1 — Voice

**Decision: ship voice as a Python sidecar, not a Node rewrite.** openWakeWord,
kokoro-onnx, sounddevice and riva.client are Python-only. Reimplementing them in
Node would be a large regression in reliability for zero benefit. Node keeps the
CLI/menu/orchestration; Python owns the audio loop.

```
voice/
  config.py    env-driven config, no secrets in code
  audio.py     VAD capture + device pick + half-duplex gate
  asr.py       Riva (configurable function-id) → Google fallback, bilingual
  tts.py       Kokoro streaming, sentence-by-sentence, EN + ES voices
  wake.py      openWakeWord continuous stream + custom verifier
  brain.py     bridge to the real Claude Code agent (`claude -p`, session-resumed)
  service.py   wake → listen → ASR → Claude → TTS loop
  train_wakeword.py / record_samples.py
voice.mjs      Node launcher: `claudbot voice`
```

**Bilingual calls.**
- *TTS:* Kokoro v1.0 already ships Spanish voices (`ef_dora`, `em_alex`,
  `em_santa`) under `lang="es"`. No second engine needed.
- *ASR:* stock `parakeet-ctc-0.6b` is **en-US only**. NVIDIA's catalog has
  `parakeet-ctc-0.6b-es` (Spanish **+ English code-switch**, punctuated) and
  `parakeet-1-1b-rnnt-multilingual`. Function IDs are per-account, so the
  function-id is env-driven (`CLAUDBOT_VOICE_ASR_FUNCTION_ID`) and the Google
  fallback is language-hinted, which makes Spanish work out of the box even
  before the right NVCF id is set.
- *Reply language:* detected from the transcript (script + stopword scoring),
  not from a fixed setting — so mixing languages mid-session works.

**Wake word "Hey Aitor".** openWakeWord has no stock model. Two-track:
1. `train_wakeword.py` — synthetic pipeline (Piper TTS) generating **both**
   EN-accented and native-ES pronunciations of "aitor" so one model covers both.
   GPU/Colab; produces `hey_aitor.onnx`.
2. `record_samples.py` — openWakeWord's *custom verifier* path: a small
   sklearn model trained on the user's own recordings. No GPU, minutes not
   hours, and it sharply cuts false accepts.

Until a model exists, voice falls back to a stock oww keyword with a loud
warning, so the service is usable on day one.

**Echo / self-hearing.** AITOR's open bug. Fix: **half-duplex gating by
default** — a shared speaking flag mutes wake detection and VAD capture while
Kokoro plays, plus a short release tail to swallow room reverb. `full` duplex
(headset-assumed, barge-in enabled) is opt-in via `CLAUDBOT_VOICE_DUPLEX=full`.

**Voice drives the real agent.** `brain.py` shells out to `claude -p` with
`--output-format stream-json` in the project cwd, persisting the session id so
turns chain. Voice is user-initiated, so Claude plan usage is correct here —
this is the one path deliberately *not* routed to NIM.

---

## Phase 2 — Device control MCP

`mcp-servers/device-control/index.mjs`, hand-written JSON Schemas (no
`zodToJsonSchema` — it silently returns empty schemas on zod v4).

Tools: `list_devices`, `adb_shell`, `adb_screencap`, `adb_input`, `adb_logcat`,
`adb_install` / `adb_uninstall`, `adb_push` / `adb_pull`, `ios_info`,
`ios_syslog`, `serial_ports`.

iOS is read-mostly by design — Apple does not expose UI automation to a desktop
without a paid developer profile, so libimobiledevice gives info/logs/backup and
that's the honest ceiling.

Destructive verbs (`factory reset`, `wipe`, `fastboot flash`, bootloader unlock)
are denied at two layers: a hard blocklist inside the server *and* deny rules in
`restrictions.yaml`.

---

## Phase 3 — Screen awareness

`screen.mjs` — off by default, `claudbot screen on|off|now|status`.

- 5-minute heartbeat + immediate manual capture.
- Perceptual hash / downsampled diff → identical frames are never re-analyzed.
- Description + OCR runs on **NIM vision**, never Claude.
- State file holds *the latest capture path + a rolling text summary only*.
  Screenshot history is pruned; it never enters Claude's context.
- Visible indicator while armed; capture is never silent.

---

## Phase 4 — Cost routing

Audit result up front: `dream.mjs`, `briefing.mjs`, `night.mjs`, `night-sync.mjs`
and `memory.mjs` **already** contain no `claude` spawn — grep-verified. The work
is to keep it that way (documented table + a guard test) and to make sure the new
screen loop follows suit.

**Gemini as research agent.** Registered in `agents.yaml` against the
OpenAI-compatible Generative Language endpoint, key from `GEMINI_API_KEY`,
default for research/deep-web; NIM `researcher` demoted to fallback.

---

## Phase 5 — Chat model

- `claudbot` bare → **main chat, no memory**. No project context, no transcript
  banner, clean slate.
- `claudbot project <path|name>` (and "let's go into repo X" from inside a chat)
  → project-scoped chat with persistent memory for that repo.
- Memory is a **compact rolling file** per project
  (`.claudbot/projects/<slug>/memory.md`), not raw transcripts. Refreshed
  incrementally: only sessions newer than the last merge get summarized, by the
  `fast` NIM agent, then merged into the rolling file.
- `memory.mjs` is extended (`projectDir(cwd)` already takes a cwd) — not replaced.
- A `project-memory` skill loads that one small file on demand, which is the
  "remember without re-reading everything" mechanism.
- Obsidian `Projects/<name>.md` is pulled in as the long-term layer.
