"""
List audio devices and show a live input level meter.

Use this to find the right microphone index when the wake word isn't hearing you:

    python -m voice.devices           list devices
    python -m voice.devices 7         watch the level meter for device 7
"""
from __future__ import annotations

import sys
import time

import numpy as np

from . import audio
from . import config as cfg


def meter(index: int | None, seconds: float = 20.0) -> None:
    """Live RMS bar so you can see which device actually hears you."""
    import sounddevice as sd

    print(f"\nWatching device {index if index is not None else 'default'} — talk. Ctrl+C to stop.\n")
    frame = int(cfg.FRAME_MS / 1000 * cfg.SAMPLE_RATE)
    try:
        with sd.InputStream(samplerate=cfg.SAMPLE_RATE, channels=1, dtype="int16",
                            blocksize=frame, device=index) as stream:
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                block, _ = stream.read(frame)
                level = audio.rms(np.asarray(block).reshape(-1))
                bar = "#" * min(60, int(level / 100))
                print(f"\r  {level:7.0f} |{bar:<60}|", end="", flush=True)
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"\n  could not open device {index}: {e}")
    print("\n")


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        try:
            meter(int(argv[1]))
        except ValueError:
            print(f"Not a device index: {argv[1]}")
            return 1
        return 0

    audio.list_devices()
    print("  Set the index in .env:  CLAUDBOT_VOICE_MIC_INDEX=<n>")
    print("  Watch a device's level: python -m voice.devices <n>\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
