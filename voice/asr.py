"""
Claudbot voice — bilingual speech-to-text.

Two providers, in order: NVIDIA Riva (hosted NVCF) then Google Web Speech.
Riva is fast and punctuates well but the stock parakeet-ctc-0.6b is en-US only,
and NVCF function ids are per-account — so Riva is entirely env-configured and
Google (keyless, language-hinted) is what makes Spanish work before anyone sets
a function id up.

All heavy imports live inside functions so this module imports cleanly on a box
where riva.client / speech_recognition aren't installed yet.
"""
from __future__ import annotations

from typing import Optional

from . import config as cfg

# Riva clients are expensive to build; cache one per function id.
_riva_services: dict = {}

_ES_MARKERS = set("¿¡ñáéíóúü")
_ES_WORDS = {
    "que", "de", "la", "el", "los", "las", "para", "porque", "cómo", "como",
    "qué", "dónde", "gracias", "hola", "sí", "muy", "está", "hacer", "puedes",
    "quiero", "tengo", "ahora", "bien", "por", "favor", "vamos", "eso", "esto",
}
_EN_WORDS = {
    "the", "and", "is", "you", "what", "how", "can", "please", "thanks", "hey",
    "with", "this", "that", "have", "want", "now", "to", "for", "it", "of",
}


def _primary_prefix() -> str:
    return cfg.PRIMARY_LANG.split("-")[0][:2].lower()


def detect_language(text: str) -> str:
    """
    "es" or "en" from the transcript alone — no network, no model.

    The reply language is decided per utterance rather than from a fixed
    setting, so switching languages mid-session just works.
    """
    if not text or not text.strip():
        return _primary_prefix()

    tokens = [t.strip(".,!?¿¡;:\"'()") for t in text.lower().split()]
    tokens = [t for t in tokens if t]
    if not tokens:
        return _primary_prefix()

    n = len(tokens)
    # Accents and inverted punctuation are near-conclusive; weight them heavily.
    marker_hits = sum(1 for ch in text.lower() if ch in _ES_MARKERS)
    es = (2.0 * marker_hits + sum(1 for t in tokens if t in _ES_WORDS)) / n
    en = sum(1 for t in tokens if t in _EN_WORDS) / n

    if es > en:
        return "es"
    if en > es:
        return "en"
    return _primary_prefix()


# ─── NVIDIA Riva (hosted) ─────────────────────────────────────────────────────


def _riva_service(function_id: str):
    """Lazily build + cache the Riva ASR client for one NVCF function id."""
    svc = _riva_services.get(function_id)
    if svc is None:
        import riva.client

        auth = riva.client.Auth(
            uri=cfg.RIVA_URI,
            use_ssl=True,
            metadata_args=[
                ["function-id", function_id],
                ["authorization", "Bearer " + cfg.NVIDIA_API_KEY],
            ],
        )
        svc = riva.client.ASRService(auth)
        _riva_services[function_id] = svc
    return svc


def _transcribe_riva(int16_audio, sample_rate: int, language_code: str,
                     function_id: str) -> str:
    """
    Transcribe an int16 mono array through Riva streaming ASR.

    Uses riva.client's own `streaming_response_generator` rather than hand-rolled
    protobuf requests — the client handles chunking and the request stream, and
    this is the call path already proven against the hosted NVCF endpoint.
    """
    import io

    import numpy as np
    import riva.client
    import scipy.io.wavfile as wav

    buf = io.BytesIO()
    wav.write(buf, sample_rate, np.asarray(int16_audio, dtype=np.int16))
    data = buf.getvalue()

    streaming_config = riva.client.StreamingRecognitionConfig(
        config=riva.client.RecognitionConfig(
            language_code=language_code,
            max_alternatives=1,
            enable_automatic_punctuation=True,
            sample_rate_hertz=sample_rate,
            audio_channel_count=1,
        ),
        interim_results=False,
    )

    parts = []
    for resp in _riva_service(function_id).streaming_response_generator(
        audio_chunks=[data], streaming_config=streaming_config
    ):
        for result in resp.results:
            if result.is_final and result.alternatives:
                parts.append(result.alternatives[0].transcript)
    return "".join(parts).strip()


# ─── Google Web Speech (keyless fallback) ─────────────────────────────────────


def _transcribe_google(int16_audio, sample_rate: int, language: str) -> str:
    """Language-hinted fallback. Returns "" rather than raising on no-speech."""
    import os
    import tempfile

    import numpy as np
    import scipy.io.wavfile as wav
    import speech_recognition as sr

    fd, temp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        wav.write(temp_path, sample_rate, np.asarray(int16_audio, dtype=np.int16))
        recognizer = sr.Recognizer()
        with sr.AudioFile(temp_path) as source:
            audio = recognizer.record(source)
        try:
            return (recognizer.recognize_google(audio, language=language) or "").strip()
        except sr.UnknownValueError:
            return ""
    except Exception as e:  # network, codec, missing package
        cfg.log(f"Google ASR ({language}) failed: {e}")
        return ""
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


# ─── public API ───────────────────────────────────────────────────────────────


def _riva_function_id(expect_lang: Optional[str]) -> str:
    if expect_lang and expect_lang.startswith("es") and cfg.RIVA_FUNCTION_ID_ES:
        return cfg.RIVA_FUNCTION_ID_ES
    return cfg.RIVA_FUNCTION_ID


def _riva_language(expect_lang: Optional[str]) -> str:
    if cfg.RIVA_LANG_CODE:
        return cfg.RIVA_LANG_CODE
    if cfg.RIVA_MULTILINGUAL:
        return "multi"
    if expect_lang:
        # Accept both "es" and "es-ES"; Riva wants the full tag.
        for tag in cfg.LANGS:
            if tag.lower().startswith(expect_lang[:2].lower()):
                return tag
    return cfg.PRIMARY_LANG


def transcribe(int16_audio, sample_rate: Optional[int] = None,
               expect_lang: Optional[str] = None) -> tuple[str, str]:
    """
    Transcribe one captured phrase.

    Returns (text, "en"|"es"). Never raises — a failed turn returns ("", primary)
    and the caller simply listens again.
    """
    sample_rate = sample_rate or cfg.SAMPLE_RATE

    if cfg.USE_RIVA_ASR and cfg.NVIDIA_API_KEY:
        function_id = _riva_function_id(expect_lang)
        if function_id:
            try:
                text = _transcribe_riva(
                    int16_audio, sample_rate, _riva_language(expect_lang), function_id
                )
                if text:
                    return text, detect_language(text)
                cfg.log("Riva returned nothing — trying Google.")
            except Exception as e:
                cfg.log(f"Riva ASR failed ({e}) — falling back to Google.")

    if not cfg.USE_GOOGLE_FALLBACK:
        return "", _primary_prefix()

    # Try the expected language first so the common case is a single round trip;
    # only widen to the other configured languages if it comes back empty.
    order = list(cfg.LANGS)
    if expect_lang:
        order.sort(key=lambda t: 0 if t.lower().startswith(expect_lang[:2].lower()) else 1)

    fallback: tuple[str, str] | None = None
    for tag in order:
        text = _transcribe_google(int16_audio, sample_rate, tag)
        if not text:
            continue
        detected = detect_language(text)
        # A transcript that "reads as" the language it was decoded in is almost
        # always the right decode; take it immediately.
        if detected == tag.split("-")[0][:2].lower():
            return text, detected
        if fallback is None:
            fallback = (text, detected)

    if fallback:
        return fallback
    return "", _primary_prefix()


def warmup() -> None:
    """Pre-build Riva clients so the first utterance isn't slow. Never raises."""
    if not (cfg.USE_RIVA_ASR and cfg.NVIDIA_API_KEY):
        return
    for fid in {cfg.RIVA_FUNCTION_ID, cfg.RIVA_FUNCTION_ID_ES}:
        if not fid:
            continue
        try:
            _riva_service(fid)
        except Exception:
            pass
