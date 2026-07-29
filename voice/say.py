"""
Speak text from the command line — the TTS smoke test.

    claudbot voice say "Hello, this is a test"
    claudbot voice say "Hola, esto es una prueba"

Language is detected from the text, so this also exercises the bilingual path.
"""
from __future__ import annotations

import sys

from . import asr, tts


def main(argv: list[str]) -> int:
    text = " ".join(argv).strip()
    if not text:
        print('Usage: claudbot voice say "something to say"')
        return 1

    lang = asr.detect_language(text)
    voice, kokoro_lang = tts.voice_for(lang)
    print(f"  lang={lang}  voice={voice}  ({kokoro_lang})")
    tts.speak(text, lang=lang, on_sentence=lambda s: print(f"  > {s}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
