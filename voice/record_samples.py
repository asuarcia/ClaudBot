"""
Record your own "Hey Aitor" samples and train a speaker verifier.

This is the cheap half of wake-word accuracy. Training the base model from
synthetic speech (voice/train_wakeword.py) needs a GPU and an hour; this needs a
microphone and about five minutes, runs on CPU, and is what stops the assistant
waking up for the TV, a podcast, or someone else in the room.

    python -m voice.record_samples

It records positives (you saying the wake phrase, in both languages) and
negatives (you talking normally, plus silence), then trains openWakeWord's
custom verifier and writes it next to the wake model.

Requires the base hey_aitor.onnx to exist first — a verifier verifies a model,
it does not replace one.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import scipy.io.wavfile as wav

from . import audio
from . import config as cfg

POSITIVE_PROMPTS = [
    ("en", "Hey Aitor            (English: 'hey EYE-tor')"),
    ("en", "Hey Aitor            (again, normal speaking volume)"),
    ("en", "Hey Aitor            (again, quieter, like you're tired)"),
    ("en", "Hey Aitor            (again, from further away)"),
    ("es", "Hey Aitor            (Spanish: 'ey AY-tor')"),
    ("es", "Oye Aitor            (natural Spanish)"),
    ("es", "Hey Aitor            (again, native pronunciation)"),
    ("en", "Hey Aitor            (last one, however you normally say it)"),
]

NEGATIVE_PROMPTS = [
    "Say any normal sentence, no wake word    (e.g. 'what's the weather today')",
    "Say a sentence in Spanish, no wake word  (e.g. 'no sé qué hacer ahora')",
    "Say 'hey' on its own, then stop",
    "Say 'doctor' and 'editor'",
    "Say 'a tour of the house'",
    "Stay silent for the whole recording",
]

CLIP_SECONDS = 2.5


def _record(path: Path, seconds: float) -> bool:
    """Fixed-length capture — the verifier wants uniform clips, not VAD output."""
    import sounddevice as sd

    frames = int(seconds * cfg.SAMPLE_RATE)
    try:
        data = sd.rec(frames, samplerate=cfg.SAMPLE_RATE, channels=1,
                      dtype="int16", device=cfg.MIC_DEVICE_INDEX)
        sd.wait()
    except Exception as e:
        print(f"  recording failed: {e}")
        return False

    clip = np.asarray(data).reshape(-1).astype(np.int16)
    if audio.rms(clip) < 60 and "silent" not in path.stem:
        print("  that was almost silent — retrying")
        return False
    wav.write(str(path), cfg.SAMPLE_RATE, clip)
    return True


def _countdown(label: str) -> None:
    print(f"\n  {label}")
    for n in ("3", "2", "1", "GO"):
        print(f"    {n}", end="\r", flush=True)
        time.sleep(0.5)
    print("    recording...", end="", flush=True)


def collect(out_dir: Path) -> tuple[list[str], list[str]]:
    pos_dir = out_dir / "positive"
    neg_dir = out_dir / "negative"
    pos_dir.mkdir(parents=True, exist_ok=True)
    neg_dir.mkdir(parents=True, exist_ok=True)

    print("\n  Recording positives — say the phrase right after 'GO'.\n")
    positives: list[str] = []
    for i, (lang, prompt) in enumerate(POSITIVE_PROMPTS):
        path = pos_dir / f"hey_aitor_{lang}_{i:02d}.wav"
        while True:
            _countdown(prompt)
            if _record(path, CLIP_SECONDS):
                print(" ok")
                positives.append(str(path))
                break

    print("\n  Now negatives — anything EXCEPT the wake phrase.\n")
    negatives: list[str] = []
    for i, prompt in enumerate(NEGATIVE_PROMPTS):
        name = "silent" if "silent" in prompt.lower() else "neg"
        path = neg_dir / f"{name}_{i:02d}.wav"
        while True:
            _countdown(prompt)
            if _record(path, CLIP_SECONDS):
                print(" ok")
                negatives.append(str(path))
                break

    return positives, negatives


def train(positives: list[str], negatives: list[str]) -> bool:
    try:
        from openwakeword.utils import train_custom_verifier
    except Exception as e:
        print(f"\n  openWakeWord verifier training unavailable: {e}")
        print("  Install it with: pip install openwakeword scikit-learn")
        return False

    out = Path(cfg.WAKE_VERIFIER)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"\n  Training verifier -> {out}")
    try:
        train_custom_verifier(
            positive_reference_clips=positives,
            negative_reference_clips=negatives,
            output_path=str(out),
            model_name=cfg.WAKE_MODEL,
        )
    except Exception as e:
        print(f"  training failed: {e}")
        return False

    print("\n  Done. Restart `claudbot voice` — it will report:")
    print("    Speaker verifier active — only your voice triggers the wake word.")
    print(f"\n  Too strict? Lower CLAUDBOT_VOICE_WAKE_VERIFIER_THRESHOLD "
          f"(currently {cfg.WAKE_VERIFIER_THRESHOLD}).")
    return True


def main() -> int:
    if not Path(cfg.WAKE_MODEL).exists():
        print(f"\n  The base wake model is missing: {cfg.WAKE_MODEL}")
        print("  Train it first:  python -m voice.train_wakeword")
        print("  A verifier refines a model; it cannot replace one.\n")
        return 1

    print("\n  Wake-word sample recording")
    print(f"  Mic: {cfg.MIC_DEVICE_INDEX if cfg.MIC_DEVICE_INDEX is not None else 'system default'}"
          f"   (change with CLAUDBOT_VOICE_MIC_INDEX, list with `python -m voice.devices`)")
    print(f"  {len(POSITIVE_PROMPTS)} positive + {len(NEGATIVE_PROMPTS)} negative clips, "
          f"{CLIP_SECONDS}s each.")
    try:
        input("\n  Press Enter when you're ready (Ctrl+C to cancel)...")
    except KeyboardInterrupt:
        print("\n  cancelled\n")
        return 1

    samples_dir = Path(cfg.MODELS_DIR) / "samples"
    try:
        positives, negatives = collect(samples_dir)
    except KeyboardInterrupt:
        print("\n  cancelled\n")
        return 1

    print(f"\n  Saved {len(positives)} positive and {len(negatives)} negative clips in {samples_dir}")
    return 0 if train(positives, negatives) else 1


if __name__ == "__main__":
    raise SystemExit(main())
