# Claudbot voice

Talk to Claudbot. Wake word, voice-activity capture, streaming speech, English
and Spanish — and it drives the **real Claude Code agent**, not a side chat.

Ported from the AITOR backend (`C:\Repo\AITOR\Backend`), which is left untouched
and still working. This is Claudbot's own copy, free to diverge.

```
claudbot voice setup      one-time: venv + dependencies
claudbot voice devices    find your microphone
claudbot voice train      train the "Hey Aitor" wake word
claudbot voice            start talking
```

---

## Why Python

openWakeWord, Kokoro, sounddevice and the Riva client are Python-only and
mature. Reimplementing them in Node would trade a working audio stack for a
worse one. Node keeps the CLI, the boot menu and orchestration; Python owns the
microphone.

## Install

```powershell
claudbot voice setup
```

Then download the two Kokoro model files into `voice/models/`:

| File | Source |
|---|---|
| `kokoro-v1.0.onnx` | github.com/thewh1teagle/kokoro-onnx releases |
| `voices-v1.0.bin`  | same release |

Point elsewhere with `CLAUDBOT_VOICE_KOKORO_MODEL` / `..._VOICES` if you already
have them (AITOR keeps its copies in `C:\Repo\AITOR`).

## Bilingual

**TTS** — Kokoro v1.0 ships Spanish voices, so one engine covers both. English
uses `af_sarah`, Spanish uses `ef_dora`; override with `CLAUDBOT_VOICE_EN` /
`CLAUDBOT_VOICE_ES`.

**ASR** — the reply language is decided per utterance from the transcript, so
you can switch languages mid-conversation and it follows you.

Two providers, in order:

1. **NVIDIA Riva** (hosted NVCF). Fast, punctuated — but stock
   `parakeet-ctc-0.6b` is **en-US only**. For bilingual capture, point it at a
   model that isn't:
   - `parakeet-ctc-0.6b-es` — Spanish **+ English code-switch**, the best fit
   - `parakeet-1-1b-rnnt-multilingual` — 28+ languages with auto-detect
   - `canary-1b` — multilingual ASR + translation

   Function ids are per-account. Get yours from the model's **Deploy** tab on
   build.nvidia.com and set:
   ```
   CLAUDBOT_VOICE_ASR_FUNCTION_ID=<id>
   CLAUDBOT_VOICE_ASR_MULTILINGUAL=1     # for a code-switch/multilingual model
   ```
   Riva also needs `pip install nvidia-riva-client` (commented out in
   requirements.txt — it isn't needed for the fallback path).

2. **Google Web Speech** — keyless, language-hinted, and the reason Spanish
   works *before* you configure any of the above. It tries the expected language
   first, so the common case is one round trip.

## Wake word — "Hey Aitor"

openWakeWord has no stock model for this phrase, so it has to be trained.

```
claudbot voice train
```

writes `voice/models/hey_aitor.yaml` and either trains locally (if the training
extras are installed) or prints the exact Colab recipe. The config is
**deliberately bilingual**: an English "hey EYE-tor" and a Spanish "ey AY-tor"
are acoustically different enough that a model trained on one misses the other,
so the phrase list spans both and the synthetic voices include `es_ES` and
`es_MX` alongside the English ones. Do not drop the Spanish voices from that
list — they are the whole point.

Until the model exists, voice falls back to the stock `hey_jarvis` keyword with
a warning, so it is usable immediately.

### Your own voice (recommended, 5 minutes, no GPU)

```
claudbot voice enroll
```

Records 8 positives (both pronunciations) and 6 negatives, then trains
openWakeWord's **custom verifier** — a small model that rejects other speakers.
This is what stops it waking up for the TV or someone else in the room. It needs
the base model to exist first.

**What to record** — the script prompts you, but so you know in advance:
say "Hey Aitor" the English way, then quieter, then from across the room; then
the Spanish way and "Oye Aitor"; then a few normal sentences in each language,
the word "hey" alone, "doctor"/"editor", and one silent clip.

## Echo — it will not hear itself

The one bug AITOR never solved: on laptop speakers the mic hears the assistant's
own TTS, it transcribes itself and talks over its replies.

Fixed with a **half-duplex gate**, on by default. While Kokoro is playing, wake
detection is skipped, the detector is reset, and the VAD drops every frame —
plus a short release tail for room reverb. The stream keeps being drained the
whole time, so the device buffer never overflows and the next real phrase is
clean.

Wearing a headset? `CLAUDBOT_VOICE_DUPLEX=full` lifts the gate and enables
barge-in, so you can interrupt mid-sentence.

## Control

The service listens on `127.0.0.1:4710`:

| | |
|---|---|
| `claudbot voice status` | what it's doing right now |
| `claudbot voice stop`   | interrupt current speech |
| `claudbot voice reset`  | forget the conversation |
| `POST /wake`            | trigger a turn without the wake word |

Spoken shortcuts handled locally (no Claude turn burned): "stop" / "para" /
"cállate", and "new conversation" / "nueva conversación".

## Configuration

Everything is `CLAUDBOT_VOICE_*` in `.env` — see `.env.example`. The ones you
are most likely to touch:

| Variable | Default | |
|---|---|---|
| `CLAUDBOT_VOICE_MIC_INDEX` | system default | from `claudbot voice devices` |
| `CLAUDBOT_VOICE_LANGS` | `en-US,es-ES` | ordered; first is primary |
| `CLAUDBOT_VOICE_DUPLEX` | `half` | `full` for a headset |
| `CLAUDBOT_VOICE_WAKE_THRESHOLD` | `0.5` | raise for fewer false triggers |
| `CLAUDBOT_VOICE_SILENCE_TAIL` | `0.9` | seconds of quiet that end a phrase |
| `CLAUDBOT_VOICE_CWD` | `.claudbot` | which repo the agent works in |

## Cost

Voice is the one path that deliberately uses the Claude plan — you are actively
talking to it, so it is foreground work. Everything unattended runs on NIM. See
`docs/cost-routing.md`.

## Troubleshooting

**It doesn't hear the wake word.** Check the mic:
`claudbot voice devices` then `claudbot voice devices <n>` for a live level
meter. If the bar doesn't move when you talk, it's the wrong device. Then lower
`CLAUDBOT_VOICE_WAKE_THRESHOLD` to 0.4.

**It cuts me off mid-sentence.** Raise `CLAUDBOT_VOICE_SILENCE_TAIL` to 1.3.

**It wakes up on itself.** You are in `full` duplex without a headset — remove
`CLAUDBOT_VOICE_DUPLEX` from `.env`.

**Spanish comes out in an English accent.** The transcript was detected as
English; check what it heard in the console. With Riva, set a Spanish-capable
function id — the English-only model transcribes Spanish as English gibberish.

**No sound at all.** `claudbot voice say "test"` isolates TTS from everything
else.
