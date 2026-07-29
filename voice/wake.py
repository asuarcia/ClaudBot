"""
Claudbot voice — wake-word detection (openWakeWord).

Two things matter here and both were bugs in the reference implementation:

1. ONE continuous input stream. Burst-recording in short takes with gaps between
   them drops most of the wake word and detection appears broken.
2. Never listen to ourselves. While TTS is playing the gate is muted, detection
   is skipped and the model is reset — otherwise the assistant wakes on its own
   voice.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Callable, Optional

import numpy as np

from . import audio
from . import config as cfg


def _model_key(path: str) -> str:
    """openWakeWord keys custom models by their filename stem."""
    return os.path.splitext(os.path.basename(path))[0]


def load_model() -> tuple[Any, str]:
    """
    Build the detector. Returns (model, human-readable wake phrase).

    Falls back loudly to a stock keyword when the custom bilingual model hasn't
    been trained yet, so voice is usable on day one instead of dead.
    """
    from openwakeword.model import Model

    if cfg.WAKE_MODEL and os.path.isfile(cfg.WAKE_MODEL):
        kwargs: dict[str, Any] = {
            "wakeword_models": [cfg.WAKE_MODEL],
            "inference_framework": "onnx",
        }
        if cfg.WAKE_VERIFIER and os.path.isfile(cfg.WAKE_VERIFIER):
            # The verifier is keyed by the wakeword model it guards.
            kwargs["custom_verifier_models"] = {_model_key(cfg.WAKE_MODEL): cfg.WAKE_VERIFIER}
            kwargs["custom_verifier_threshold"] = cfg.WAKE_VERIFIER_THRESHOLD
            cfg.log("Speaker verifier active — only your voice triggers the wake word.")
        return Model(**kwargs), "Hey Aitor"

    cfg.log(
        f"WARNING: custom wake word not found at {cfg.WAKE_MODEL}. "
        f"Falling back to the stock '{cfg.WAKE_FALLBACK}' keyword. "
        f"Train the real one with: python -m voice.train_wakeword"
    )
    label = cfg.WAKE_FALLBACK.replace("_", " ").title()
    return Model(wakeword_models=[cfg.WAKE_FALLBACK], inference_framework="onnx"), label


class WakeListener:
    """Background thread that fires `on_wake` when the wake phrase is heard."""

    def __init__(self, on_wake: Callable[[], None], stream: Optional[Any] = None) -> None:
        self._on_wake = on_wake
        self._stream = stream
        self._owns_stream = stream is None
        self._model: Any = None
        self.label = ""
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ── control ───────────────────────────────────────────────────────────────

    def start(self) -> bool:
        """Load the model and start detecting. False if the model can't load."""
        if self.is_running:
            return True
        try:
            self._model, self.label = load_model()
        except Exception as e:
            cfg.log(f"Wake word disabled (model load failed): {e}")
            return False

        if self._owns_stream:
            try:
                self._stream = audio.open_input_stream(cfg.OWW_FRAME)
            except Exception as e:
                cfg.log(f"Wake word disabled (no microphone): {e}")
                return False

        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="wake", daemon=True)
        self._thread.start()
        cfg.log(f"Wake word active — say '{self.label}'")
        return True

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._owns_stream and self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def pause(self) -> None:
        """Suspend detection during a conversation turn."""
        self._paused.set()

    def resume(self) -> None:
        self._reset()
        self._paused.clear()

    # ── internals ─────────────────────────────────────────────────────────────

    def _reset(self) -> None:
        """Clear the model's rolling audio buffer so stale audio can't trigger."""
        try:
            reset = getattr(self._model, "reset", None)
            if callable(reset):
                reset()
        except Exception:
            pass

    def _loop(self) -> None:
        stream = self._stream
        while not self._stop.is_set():
            try:
                block, _ = stream.read(cfg.OWW_FRAME)
            except Exception as e:
                cfg.log(f"wake read error: {e}")
                time.sleep(0.05)
                continue

            # Keep draining the stream while paused/muted — if we stop reading, the
            # shared device buffer overflows and the next real phrase is corrupted.
            if self._paused.is_set() or audio.gate.is_muted():
                self._reset()
                continue

            try:
                frame = np.asarray(block, dtype=np.int16).reshape(-1)
                scores = self._model.predict(frame)
                for name, score in (scores or {}).items():
                    if score > cfg.WAKE_THRESHOLD:
                        cfg.log(f"Wake word detected ({name}: {score:.2f})")
                        self._reset()
                        try:
                            self._on_wake()
                        except Exception as e:
                            cfg.log(f"wake handler error: {e}")
                        # Debounce, but stay responsive to stop().
                        self._stop.wait(cfg.WAKE_DEBOUNCE)
                        self._reset()
                        break
            except Exception as e:
                cfg.log(f"wake detection error: {e}")
                time.sleep(0.05)


def available() -> bool:
    """True when wake detection is enabled and openWakeWord is installed."""
    if not cfg.WAKE_ENABLED:
        return False
    try:
        import openwakeword  # noqa: F401
    except Exception:
        return False
    return True
