"""
Claudbot voice — microphone capture, playback, and the echo gate.

The echo gate is the fix for the one bug AITOR never solved: on laptop speakers
the microphone hears the assistant's own TTS, so it transcribes itself and talks
over its replies. Every capture path here consults `gate` and drops audio while
speech is playing (plus a release tail for room reverb). Full duplex — headset
assumed, barge-in allowed — is opt-in.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional

import numpy as np
import sounddevice as sd

from . import config as cfg


# ─── RMS ──────────────────────────────────────────────────────────────────────


def rms(block: np.ndarray) -> float:
    """RMS of an int16 block. float64 accumulator so long blocks can't overflow."""
    arr = np.asarray(block)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))


# ─── echo gate ────────────────────────────────────────────────────────────────


class SpeakingGate:
    """Tracks TTS playback so capture can mute itself instead of hearing it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._depth = 0          # re-entrant: streaming TTS speaks many chunks
        self._ended_at = 0.0

    def begin_speaking(self) -> None:
        with self._lock:
            self._depth += 1

    def end_speaking(self) -> None:
        with self._lock:
            self._depth = max(0, self._depth - 1)
            if self._depth == 0:
                self._ended_at = time.monotonic()

    @property
    def speaking_now(self) -> bool:
        with self._lock:
            return self._depth > 0

    def is_muted(self) -> bool:
        """True while speaking and for ECHO_TAIL_MS after. Always False in full duplex."""
        if not cfg.HALF_DUPLEX:
            return False
        with self._lock:
            if self._depth > 0:
                return True
            return (time.monotonic() - self._ended_at) * 1000.0 < cfg.ECHO_TAIL_MS

    @contextmanager
    def speaking(self) -> Iterator[None]:
        self.begin_speaking()
        try:
            yield
        finally:
            self.end_speaking()


gate = SpeakingGate()


# ─── devices ──────────────────────────────────────────────────────────────────


def device_report() -> list[dict[str, Any]]:
    """Every audio device with its index, channel counts and default flags."""
    try:
        devices = sd.query_devices()
        default_in, default_out = sd.default.device
    except Exception as e:
        cfg.log(f"could not query audio devices: {e}")
        return []

    report = []
    for idx, d in enumerate(devices):
        report.append(
            {
                "index": idx,
                "name": d.get("name", "?"),
                "inputs": d.get("max_input_channels", 0),
                "outputs": d.get("max_output_channels", 0),
                "default_input": idx == default_in,
                "default_output": idx == default_out,
            }
        )
    return report


def list_devices() -> None:
    """Print devices so the user can pick CLAUDBOT_VOICE_MIC_INDEX."""
    report = device_report()
    if not report:
        print("No audio devices found.")
        return

    print("\nInput devices (set CLAUDBOT_VOICE_MIC_INDEX):")
    for d in report:
        if d["inputs"] > 0:
            print(f"  [{d['index']:2d}] {d['name']}{'   <- default' if d['default_input'] else ''}")

    print("\nOutput devices (set CLAUDBOT_VOICE_SPEAKER_INDEX):")
    for d in report:
        if d["outputs"] > 0:
            print(f"  [{d['index']:2d}] {d['name']}{'   <- default' if d['default_output'] else ''}")
    print()


def open_input_stream(blocksize: int = cfg.OWW_FRAME) -> sd.InputStream:
    """
    One continuous 16 kHz mono stream.

    AITOR's first wake-word implementation burst-recorded with gaps between
    reads and missed most detections; everything here shares a single stream.
    """
    try:
        stream = sd.InputStream(
            samplerate=cfg.SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=blocksize,
            device=cfg.MIC_DEVICE_INDEX,
        )
        stream.start()
        return stream
    except Exception as e:
        which = cfg.MIC_DEVICE_INDEX if cfg.MIC_DEVICE_INDEX is not None else "system default"
        raise RuntimeError(
            f"Could not open microphone ({which}): {e}. "
            f"Run `python -m voice.devices` to list device indices."
        ) from e


def _read(stream: sd.InputStream, frames: int) -> Optional[np.ndarray]:
    """Read one mono block; None on a transient device error (never raises)."""
    try:
        block, _overflow = stream.read(frames)
    except Exception as e:
        cfg.log(f"mic read error: {e}")
        return None
    arr = np.asarray(block)
    return arr.reshape(-1) if arr.ndim > 1 else arr


# ─── VAD capture ──────────────────────────────────────────────────────────────


def capture_phrase(
    *,
    start_timeout: Optional[float] = None,
    max_phrase: Optional[float] = None,
    silence_tail: Optional[float] = None,
    on_state: Optional[Callable[[str], None]] = None,
    stream: Optional[sd.InputStream] = None,
) -> Optional[np.ndarray]:
    """
    Capture one spoken phrase using voice-activity detection.

    Not a fixed-length recording: it waits for speech to start, keeps going for
    as long as the person is talking, and ends ~`silence_tail` after they stop.
    Returns int16 mono audio, or None if nobody spoke.

    `stream` lets the caller share an already-open stream (the wake-word loop
    hands its stream over so there's no device close/reopen gap between the wake
    word firing and the phrase starting).
    """
    start_timeout = cfg.VAD_START_TIMEOUT if start_timeout is None else start_timeout
    max_phrase = cfg.VAD_MAX_PHRASE if max_phrase is None else max_phrase
    silence_tail = cfg.VAD_SILENCE_TAIL if silence_tail is None else silence_tail

    frame = max(1, int(cfg.FRAME_MS / 1000 * cfg.SAMPLE_RATE))
    owns_stream = stream is None
    if owns_stream:
        stream = open_input_stream(frame)

    def state(s: str) -> None:
        if on_state:
            try:
                on_state(s)
            except Exception:
                pass

    try:
        # Ambient calibration — a fixed threshold is wrong in every other room.
        state("calibrating")
        ambient: list[float] = []
        for _ in range(10):  # ~0.3 s
            block = _read(stream, frame)
            if block is not None and not gate.is_muted():
                ambient.append(rms(block))
        noise = sum(ambient) / len(ambient) if ambient else 0.0
        threshold = max(noise * cfg.VAD_NOISE_FACTOR, cfg.VAD_MIN_THRESHOLD)

        state("listening")

        # Pre-roll: the frame that trips the threshold is already mid-phoneme, so
        # keep the preceding ~150 ms and prepend it.
        pre_roll: deque[np.ndarray] = deque()
        pre_roll_samples = 0
        pre_roll_cap = int(0.150 * cfg.SAMPLE_RATE)

        collected: list[np.ndarray] = []
        recorded_samples = 0
        max_samples = int(max_phrase * cfg.SAMPLE_RATE)
        quiet_samples = 0
        quiet_cap = int(silence_tail * cfg.SAMPLE_RATE)
        deadline = time.monotonic() + start_timeout
        started = False

        while True:
            block = _read(stream, frame)
            if block is None:
                continue

            # Our own TTS: drop it, and don't let it start or extend a phrase.
            if gate.is_muted():
                deadline = time.monotonic() + start_timeout  # don't time out while speaking
                continue

            level = rms(block)
            voiced = level >= threshold

            if not started:
                pre_roll.append(block)
                pre_roll_samples += block.size
                while pre_roll_samples > pre_roll_cap and len(pre_roll) > 1:
                    pre_roll_samples -= pre_roll.popleft().size

                if voiced:
                    started = True
                    state("recording")
                    collected.extend(pre_roll)
                    recorded_samples = sum(b.size for b in collected)
                    pre_roll.clear()
                    pre_roll_samples = 0
                elif time.monotonic() > deadline:
                    state("timeout")
                    return None
                continue

            collected.append(block)
            recorded_samples += block.size
            quiet_samples = 0 if voiced else quiet_samples + block.size

            if quiet_samples >= quiet_cap or recorded_samples >= max_samples:
                break

        state("done")
        if not collected:
            return None
        return np.concatenate(collected).astype(np.int16)

    finally:
        if owns_stream and stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass


# ─── playback ─────────────────────────────────────────────────────────────────


def play(samples: np.ndarray, sample_rate: int = cfg.SAMPLE_RATE,
         blocking: bool = True) -> None:
    """Play audio, holding the echo gate so capture stays muted throughout."""
    arr = np.asarray(samples)
    if arr.size == 0:
        return
    if arr.dtype not in (np.int16, np.float32):
        arr = arr.astype(np.float32)

    try:
        with gate.speaking():
            sd.play(arr, samplerate=sample_rate, device=cfg.SPEAKER_DEVICE_INDEX)
            if blocking:
                sd.wait()
    except Exception as e:
        cfg.log(f"playback error: {e}")


def stop_playback() -> None:
    """Cut playback immediately — the interrupt / barge-in path."""
    try:
        sd.stop()
    except Exception as e:
        cfg.log(f"stop_playback error: {e}")
