"""
Claudbot voice — streaming bilingual text-to-speech (Kokoro ONNX).

Two things make this feel fast instead of laggy:

1. Markdown never reaches the synthesizer. A model reply is full of backticks,
   bullets and links; read aloud verbatim it is unlistenable.
2. Sentences are pipelined. Sentence N+1 is synthesized on a worker thread while
   sentence N is playing, so speech starts as soon as the first sentence is ready
   and never gaps afterwards.

Kokoro v1.0 ships Spanish voices, so one local engine covers EN and ES — no
second TTS stack, and no hosted round trip.
"""
from __future__ import annotations

import concurrent.futures
import re
import threading
from pathlib import Path
from typing import Callable, Optional

from . import audio
from . import config as cfg

_kokoro = None
_kokoro_lock = threading.Lock()
_interrupt = threading.Event()

# ─── markdown stripping ───────────────────────────────────────────────────────

_EMOJI = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U00002B00-\U00002BFF"
    "\U0000FE00-\U0000FE0F"
    "\U0001F1E6-\U0001F1FF"
    "]+",
    flags=re.UNICODE,
)


def strip_markdown(text: str) -> str:
    """
    Reduce a markdown reply to speakable prose.

    Fenced code is summarized rather than read (nobody wants a function body
    spelled out); inline code keeps its content, since that is usually a single
    identifier the listener needs to hear.
    """
    if not text:
        return ""

    s = text
    s = re.sub(r"```[\s\S]*?```", " code block. ", s)
    s = re.sub(r"```[\s\S]*$", " code block. ", s)          # unterminated fence
    s = re.sub(r"~~~[\s\S]*?~~~", " code block. ", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)                      # inline code: keep content
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " image. ", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)          # links -> label
    s = re.sub(r"<[^>\n]{1,200}>", "", s)                   # html tags
    s = re.sub(r"https?://\S+", " a link ", s)
    s = re.sub(r"^\s{0,3}#{1,6}\s+", "", s, flags=re.MULTILINE)
    s = re.sub(r"^\s{0,3}>\s?", "", s, flags=re.MULTILINE)
    s = re.sub(r"^\s{0,3}([-*_])\s*\1\s*\1[-*_\s]*$", "", s, flags=re.MULTILINE)
    s = re.sub(r"^\s*[-*+]\s+", "", s, flags=re.MULTILINE)
    s = re.sub(r"^\s*\d+[.)]\s+", "", s, flags=re.MULTILINE)
    s = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"\*(.+?)\*", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"__(.+?)__", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"~~(.+?)~~", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"\|", " ", s)                               # table pipes
    s = _EMOJI.sub("", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


# ─── sentence splitting ───────────────────────────────────────────────────────

# Splitting on every "." would cut "Dr." and "e.g." mid-word and make the voice
# stutter, so these are masked before the split and restored after.
_ABBREVIATIONS = [
    "mr", "mrs", "ms", "dr", "prof", "sr", "sra", "srta", "jr", "st", "vs",
    "etc", "inc", "ltd", "co", "vol", "approx", "dept", "e.g", "i.e", "ej",
]
_ABBREV_RE = re.compile(
    r"\b(" + "|".join(re.escape(a) for a in _ABBREVIATIONS) + r")\.",
    re.IGNORECASE,
)
_DOT = ""  # private-use sentinel; cannot occur in a model reply
_MIN_CHUNK = 25


def split_sentences(text: str) -> list[str]:
    """
    Chunk text into sentences for pipelined synthesis.

    Fragments shorter than ~25 chars are merged forward: invoking Kokoro on "Ok."
    costs a whole model call for a word and produces an audible stutter.
    """
    if not text:
        return []

    masked = _ABBREV_RE.sub(lambda m: m.group(1) + _DOT, text)
    # Break after sentence-final punctuation (and its closing quotes/brackets),
    # or at a newline. Spanish opening marks stay attached to what follows.
    parts = re.split(r'(?<=[.!?…])["\')\]]*\s+|\n+', masked)

    chunks: list[str] = []
    for part in parts:
        cleaned = part.replace(_DOT, ".").strip()
        if cleaned:
            chunks.append(cleaned)

    merged: list[str] = []
    for chunk in chunks:
        if merged and len(merged[-1]) < _MIN_CHUNK:
            merged[-1] = f"{merged[-1]} {chunk}"
        else:
            merged.append(chunk)
    # A trailing runt has nothing to merge forward into; fold it backwards.
    # (pop() first — doing it inside the assignment would shift the target index.)
    if len(merged) > 1 and len(merged[-1]) < _MIN_CHUNK:
        tail = merged.pop()
        merged[-1] = f"{merged[-1]} {tail}"
    return merged


# ─── engine ───────────────────────────────────────────────────────────────────


def get_kokoro():
    """Load Kokoro once, lazily — it costs a few seconds and ~300 MB."""
    global _kokoro
    with _kokoro_lock:
        if _kokoro is not None:
            return _kokoro

        model = Path(cfg.KOKORO_MODEL)
        voices = Path(cfg.KOKORO_VOICES)
        for path, var in ((model, "CLAUDBOT_VOICE_KOKORO_MODEL"),
                          (voices, "CLAUDBOT_VOICE_KOKORO_VOICES")):
            if not path.exists():
                raise FileNotFoundError(
                    f"Kokoro file not found: {path}\n"
                    f"Download kokoro-v1.0.onnx and voices-v1.0.bin into "
                    f"{cfg.MODELS_DIR}, or set {var} to their location.\n"
                    f"See voice/README.md."
                )

        from kokoro_onnx import Kokoro

        cfg.log("loading Kokoro TTS...")
        _kokoro = Kokoro(str(model), str(voices))
        cfg.log("Kokoro ready.")
        return _kokoro


def voice_for(lang: str) -> tuple[str, str]:
    """(kokoro voice, kokoro lang code) for a language tag; English by default."""
    prefix = (lang or "en")[:2].lower()
    return cfg.VOICES.get(prefix, cfg.VOICES["en"])


def synth(text: str, lang: str = "en", speed: Optional[float] = None):
    """Synthesize one chunk. Returns (samples, sample_rate)."""
    voice, kokoro_lang = voice_for(lang)
    return get_kokoro().create(
        text, voice=voice, speed=cfg.TTS_SPEED if speed is None else speed,
        lang=kokoro_lang,
    )


# ─── speaking ─────────────────────────────────────────────────────────────────


def speak(text: str, lang: str = "en", speed: Optional[float] = None,
          on_sentence: Optional[Callable[[str], None]] = None) -> None:
    """
    Say `text` out loud, streaming sentence by sentence.

    Returns when playback finishes or `interrupt()` is called. Never raises — a
    TTS failure should cost the reply, not the session.
    """
    clear_interrupt()
    sentences = split_sentences(strip_markdown(text))
    if not sentences:
        return

    try:
        get_kokoro()
    except Exception as e:
        cfg.log(f"TTS unavailable: {e}")
        return

    # One worker: synthesis for chunk N+1 overlaps playback of chunk N. More
    # workers would just queue up audio we may be about to interrupt.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(synth, sentences[0], lang, speed)
        for i, sentence in enumerate(sentences):
            if _interrupt.is_set():
                break
            try:
                samples, sample_rate = pending.result()
            except Exception as e:
                cfg.log(f"TTS error on \"{sentence[:40]}\": {e}")
                break

            # Queue the next chunk before playing this one — that overlap is the
            # whole point.
            pending = (
                pool.submit(synth, sentences[i + 1], lang, speed)
                if i + 1 < len(sentences) and not _interrupt.is_set()
                else None
            )

            if on_sentence:
                try:
                    on_sentence(sentence)
                except Exception:
                    pass

            audio.play(samples, sample_rate, blocking=True)

            if pending is None:
                break
        # Drop any in-flight synthesis for text we are no longer going to say.
        if pending is not None:
            pending.cancel()


def interrupt() -> None:
    """Stop speaking immediately and abandon the rest of the reply."""
    _interrupt.set()
    audio.stop_playback()


def clear_interrupt() -> None:
    _interrupt.clear()


def warmup() -> None:
    """Pre-load the model so the first reply isn't preceded by a long pause."""
    try:
        get_kokoro()
    except Exception as e:
        cfg.log(f"TTS warmup skipped: {e}")
