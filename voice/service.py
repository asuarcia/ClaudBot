"""
Claudbot voice — the service loop.

wake word -> VAD capture -> ASR -> Claude Code -> streaming TTS, and back to
listening. Also exposes a tiny localhost control server so other processes (or
`claudbot voice stop`) can interrupt speech or trigger a turn without a wake word.

Run: python -m voice.service       (or: claudbot voice)
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from . import asr, audio, brain
from . import config as cfg
from . import tts
from . import wake

CONTROL_HOST = "127.0.0.1"
CONTROL_PORT = int(__import__("os").getenv("CLAUDBOT_VOICE_PORT", "4710"))


class VoiceService:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._turn_lock = threading.Lock()
        self._wake_event = threading.Event()
        self._listener: Optional[wake.WakeListener] = None
        self._stream = None
        self.last_lang = asr._primary_prefix()
        self.state = "idle"

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> None:
        cfg.STATE_DIR.mkdir(parents=True, exist_ok=True)

        if not brain.available():
            cfg.log(
                f"WARNING: `{cfg.CLAUDE_BIN}` is not on PATH. Voice will hear you "
                f"but has nothing to answer with."
            )

        threading.Thread(target=self._warmup, name="warmup", daemon=True).start()
        self._serve_control()

        if wake.available():
            # The wake listener owns the mic stream and hands it to capture, so
            # there is no close/reopen gap between the wake word and the phrase.
            self._listener = wake.WakeListener(on_wake=self._wake_event.set)
            if not self._listener.start():
                self._listener = None
        else:
            cfg.log("Wake word unavailable — press Enter to talk.")

        if self._listener is None:
            threading.Thread(target=self._push_to_talk, name="ptt", daemon=True).start()

        self._banner()
        self._run()

    def _banner(self) -> None:
        duplex = "half (speakers-safe)" if cfg.HALF_DUPLEX else "full (headset, barge-in)"
        langs = ", ".join(cfg.LANGS)
        phrase = self._listener.label if self._listener else "push-to-talk"
        print(
            f"\n  Claudbot voice\n"
            f"    wake     {phrase}\n"
            f"    langs    {langs}\n"
            f"    duplex   {duplex}\n"
            f"    control  http://{CONTROL_HOST}:{CONTROL_PORT}\n"
            f"    Ctrl+C to quit\n",
            flush=True,
        )

    def _warmup(self) -> None:
        try:
            asr.warmup()
        except Exception:
            pass
        try:
            tts.warmup()
        except Exception:
            pass

    def stop(self) -> None:
        self._stop.set()
        self._wake_event.set()
        tts.interrupt()
        if self._listener:
            self._listener.stop()

    # ── main loop ─────────────────────────────────────────────────────────────

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                if not self._wake_event.wait(timeout=0.25):
                    continue
                self._wake_event.clear()
                if self._stop.is_set():
                    break
                self._turn()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()
            print("\n  Voice off.\n", flush=True)

    def _turn(self) -> None:
        """One wake → answer cycle. Never raises out."""
        if not self._turn_lock.acquire(blocking=False):
            return  # a turn is already running; ignore the extra trigger
        try:
            if self._listener:
                self._listener.pause()

            # Any speech still playing means the user interrupted us.
            tts.interrupt()
            tts.clear_interrupt()

            self.state = "listening"
            audio_data = audio.capture_phrase(on_state=self._on_capture_state)
            if audio_data is None or audio_data.size == 0:
                cfg.log("nothing heard")
                return

            self.state = "thinking"
            text, lang = asr.transcribe(audio_data, expect_lang=self.last_lang)
            if not text:
                cfg.log("could not transcribe")
                return
            self.last_lang = lang
            print(f"  you ({lang}): {text}", flush=True)

            if self._local_command(text, lang):
                return

            reply = brain.ask(text, lang=lang)
            if not reply:
                return
            print(f"  claudbot: {reply}", flush=True)

            self.state = "speaking"
            tts.speak(reply, lang=lang)
        except Exception as e:
            cfg.log(f"turn failed: {e}")
        finally:
            self.state = "idle"
            if self._listener:
                self._listener.resume()
            self._turn_lock.release()

    def _on_capture_state(self, s: str) -> None:
        if s in ("recording", "listening"):
            cfg.log(s)

    # Spoken control phrases handled locally instead of burning a Claude turn.
    _STOP_WORDS = {"stop", "stop talking", "be quiet", "para", "cállate", "callate", "silencio"}
    _RESET_WORDS = {"new conversation", "start over", "reset", "nueva conversación",
                    "nueva conversacion", "empezar de nuevo", "olvida todo"}

    def _local_command(self, text: str, lang: str) -> bool:
        norm = text.strip().lower().rstrip(".!?¡¿")
        if norm in self._STOP_WORDS:
            tts.interrupt()
            return True
        if norm in self._RESET_WORDS:
            brain.reset_session()
            tts.speak("Empecemos de nuevo." if lang == "es" else "Starting fresh.", lang=lang)
            return True
        return False

    # ── push-to-talk (no wake model) ──────────────────────────────────────────

    def _push_to_talk(self) -> None:
        while not self._stop.is_set():
            try:
                line = sys.stdin.readline()
            except Exception:
                return
            if line == "":
                return
            if line.strip().lower() in ("q", "quit", "exit"):
                self.stop()
                return
            self._wake_event.set()

    # ── control server ────────────────────────────────────────────────────────

    def _serve_control(self) -> None:
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):  # silence per-request stdout noise
                pass

            def _json(self, code: int, payload: dict) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/") in ("/status", ""):
                    return self._json(200, {
                        "state": service.state,
                        "speaking": audio.gate.speaking_now,
                        "lang": service.last_lang,
                        "wake": bool(service._listener),
                    })
                return self._json(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                path = self.path.rstrip("/")
                if path == "/stop":
                    tts.interrupt()
                    return self._json(200, {"ok": True, "stopped": True})
                if path == "/wake":
                    service._wake_event.set()
                    return self._json(200, {"ok": True, "woke": True})
                if path == "/reset":
                    brain.reset_session()
                    return self._json(200, {"ok": True, "reset": True})
                if path == "/quit":
                    self._json(200, {"ok": True})
                    threading.Thread(target=service.stop, daemon=True).start()
                    return
                return self._json(404, {"error": "not found"})

        try:
            server = ThreadingHTTPServer((CONTROL_HOST, CONTROL_PORT), Handler)
        except OSError as e:
            cfg.log(f"control server not started ({e}) — voice still works")
            return
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, name="control", daemon=True).start()


def main() -> int:
    VoiceService().start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
