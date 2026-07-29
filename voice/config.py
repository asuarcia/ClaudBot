"""
Claudbot voice — configuration.

Everything is environment-driven. No secrets live in this file; keys are read
from the process environment, which `voice.mjs` populates from the repo `.env`
before spawning Python. Nothing here should ever be committed with a value that
isn't a safe public default.
"""
import os
from pathlib import Path

# ─── Paths ────────────────────────────────────────────────────────────────────

VOICE_DIR     = Path(__file__).resolve().parent
REPO_ROOT     = VOICE_DIR.parent
CLAUDBOT_DIR  = REPO_ROOT / ".claudbot"
MODELS_DIR    = Path(os.getenv("CLAUDBOT_VOICE_MODELS_DIR", str(VOICE_DIR / "models")))
STATE_DIR     = CLAUDBOT_DIR / "voice"


def _flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


def _num(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


# ─── Audio devices ────────────────────────────────────────────────────────────

# None = system default. Find indices with: python -m voice.devices
_mic = os.getenv("CLAUDBOT_VOICE_MIC_INDEX", "").strip()
MIC_DEVICE_INDEX = int(_mic) if _mic not in ("", "-1") else None

_spk = os.getenv("CLAUDBOT_VOICE_SPEAKER_INDEX", "").strip()
SPEAKER_DEVICE_INDEX = int(_spk) if _spk not in ("", "-1") else None

SAMPLE_RATE = 16000          # everything upstream (oww, Riva) expects 16 kHz mono
FRAME_MS    = 30             # VAD frame size
OWW_FRAME   = 1280           # 80 ms @ 16 kHz — openWakeWord's required chunk

# ─── Duplex / echo control ────────────────────────────────────────────────────
#
# AITOR's unsolved bug was that the mic heard the speakers, so the assistant
# transcribed itself and talked over its own replies. "half" gates all capture
# while TTS is playing (plus a release tail for room reverb) and is the default
# because it is correct on laptop speakers. "full" assumes a headset and allows
# barge-in.
DUPLEX          = os.getenv("CLAUDBOT_VOICE_DUPLEX", "half").strip().lower()
HALF_DUPLEX     = DUPLEX != "full"
ECHO_TAIL_MS    = _num("CLAUDBOT_VOICE_ECHO_TAIL_MS", 350)   # mute-after-speech tail
BARGE_IN        = _flag("CLAUDBOT_VOICE_BARGE_IN", "1" if DUPLEX == "full" else "0")

# ─── Voice-activity detection ─────────────────────────────────────────────────

VAD_START_TIMEOUT = _num("CLAUDBOT_VOICE_START_TIMEOUT", 6.0)   # wait for speech
VAD_MAX_PHRASE    = _num("CLAUDBOT_VOICE_MAX_PHRASE", 30.0)     # hard cap
VAD_SILENCE_TAIL  = _num("CLAUDBOT_VOICE_SILENCE_TAIL", 0.9)    # end-of-phrase quiet
VAD_MIN_THRESHOLD = _num("CLAUDBOT_VOICE_MIN_THRESHOLD", 350)   # RMS floor
VAD_NOISE_FACTOR  = _num("CLAUDBOT_VOICE_NOISE_FACTOR", 2.5)    # x ambient RMS

# ─── Languages ────────────────────────────────────────────────────────────────
#
# Ordered; the first is the primary. Detection is per-utterance, so a session can
# switch languages freely.
LANGS = [c.strip() for c in os.getenv("CLAUDBOT_VOICE_LANGS", "en-US,es-ES").split(",") if c.strip()]
PRIMARY_LANG = LANGS[0] if LANGS else "en-US"

# ─── ASR: NVIDIA Riva (hosted NVCF) ───────────────────────────────────────────
#
# Stock parakeet-ctc-0.6b is en-US ONLY. For bilingual capture point this at the
# Spanish/English code-switch model (parakeet-ctc-0.6b-es) or the multilingual
# RNNT (parakeet-1-1b-rnnt-multilingual) — function ids are per-account, grab
# yours from the model's Deploy tab on build.nvidia.com.
USE_RIVA_ASR      = _flag("CLAUDBOT_VOICE_USE_RIVA", "1")
RIVA_URI          = os.getenv("CLAUDBOT_VOICE_RIVA_URI", "grpc.nvcf.nvidia.com:443")
RIVA_FUNCTION_ID  = os.getenv("CLAUDBOT_VOICE_ASR_FUNCTION_ID", "").strip()
# Optional: a second function id used when Spanish is expected. If unset, the
# primary id is used for every language.
RIVA_FUNCTION_ID_ES = os.getenv("CLAUDBOT_VOICE_ASR_FUNCTION_ID_ES", "").strip()
# True when the configured model handles both languages in one pass (code-switch
# or multilingual) — then we never split by language.
RIVA_MULTILINGUAL = _flag("CLAUDBOT_VOICE_ASR_MULTILINGUAL", "0")
RIVA_LANG_CODE    = os.getenv("CLAUDBOT_VOICE_ASR_LANG", "").strip()  # override
NVIDIA_API_KEY    = (os.getenv("NVIDIA_API_KEY") or os.getenv("NIM_API_KEY") or "").strip()

# Google Web Speech fallback — keyless, language-hinted, and the reason Spanish
# works before an NVCF function id is configured.
USE_GOOGLE_FALLBACK = _flag("CLAUDBOT_VOICE_GOOGLE_FALLBACK", "1")

# ─── TTS: Kokoro (local ONNX) ─────────────────────────────────────────────────
#
# Chosen over hosted TTS for latency. v1.0 ships Spanish voices, so one engine
# covers both languages.
KOKORO_MODEL  = os.getenv("CLAUDBOT_VOICE_KOKORO_MODEL",  str(MODELS_DIR / "kokoro-v1.0.onnx"))
KOKORO_VOICES = os.getenv("CLAUDBOT_VOICE_KOKORO_VOICES", str(MODELS_DIR / "voices-v1.0.bin"))
TTS_SPEED     = _num("CLAUDBOT_VOICE_TTS_SPEED", 1.0)

# lang-tag → (kokoro voice, kokoro lang code)
VOICES = {
    "en": (os.getenv("CLAUDBOT_VOICE_EN", "af_sarah"), "en-us"),
    "es": (os.getenv("CLAUDBOT_VOICE_ES", "ef_dora"),  "es"),
}

# ─── Wake word (openWakeWord) ─────────────────────────────────────────────────

WAKE_ENABLED   = _flag("CLAUDBOT_VOICE_WAKE", "1")
# Custom bilingual "hey aitor" model. Falls back to a stock keyword (loudly) when
# the file is missing, so voice is usable before the model is trained.
WAKE_MODEL     = os.getenv("CLAUDBOT_VOICE_WAKE_MODEL", str(MODELS_DIR / "hey_aitor.onnx"))
WAKE_FALLBACK  = os.getenv("CLAUDBOT_VOICE_WAKE_FALLBACK", "hey_jarvis")
WAKE_THRESHOLD = _num("CLAUDBOT_VOICE_WAKE_THRESHOLD", 0.5)
WAKE_DEBOUNCE  = _num("CLAUDBOT_VOICE_WAKE_DEBOUNCE", 2.0)
# openWakeWord "custom verifier": a tiny sklearn model trained on the user's own
# recordings that rejects other speakers. Optional, no GPU needed.
WAKE_VERIFIER  = os.getenv("CLAUDBOT_VOICE_WAKE_VERIFIER", str(MODELS_DIR / "hey_aitor_verifier.pkl"))
WAKE_VERIFIER_THRESHOLD = _num("CLAUDBOT_VOICE_WAKE_VERIFIER_THRESHOLD", 0.3)

# ─── Brain (the real Claude Code agent) ───────────────────────────────────────

CLAUDE_BIN     = os.getenv("CLAUDBOT_VOICE_CLAUDE_BIN", "claude")
BRAIN_CWD      = os.getenv("CLAUDBOT_VOICE_CWD", str(CLAUDBOT_DIR))
BRAIN_TIMEOUT  = _num("CLAUDBOT_VOICE_BRAIN_TIMEOUT", 300)
SESSION_FILE   = STATE_DIR / "session.json"
# Spoken replies should be short; the transcript still has the full answer.
BRAIN_STYLE    = os.getenv(
    "CLAUDBOT_VOICE_STYLE",
    "You are being spoken to out loud and your reply will be read by a "
    "text-to-speech voice. Answer in at most 3 short sentences, plain prose, no "
    "markdown, no code blocks, no lists, no emoji. Reply in the same language "
    "the user spoke.",
)

# ─── Misc ─────────────────────────────────────────────────────────────────────

VERBOSE = _flag("CLAUDBOT_VOICE_VERBOSE", "1")


def log(msg: str) -> None:
    if VERBOSE:
        print(f"[voice] {msg}", flush=True)
