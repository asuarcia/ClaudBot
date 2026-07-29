"""
Claudbot voice — bridge to the real Claude Code agent.

Voice does not talk to a separate NIM chat. It drives the same `claude` binary
Claudbot launches interactively, in the same working directory, with the session
id persisted so consecutive utterances are one continuous conversation rather
than a series of amnesiac one-shots.

Cost note: this is the one deliberately-Claude path in Claudbot. Voice only runs
while the user is speaking to it, so it is foreground work. Everything that runs
unattended is routed to NIM — see docs/cost-routing.md.
"""
from __future__ import annotations

import json
import subprocess
import time
from typing import Optional

from . import config as cfg


def _load_session() -> Optional[str]:
    try:
        with open(cfg.SESSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        sid = data.get("session_id")
        # A stale id from days ago is worse than a fresh session: resume fails and
        # the whole turn is lost. Expire it.
        if sid and time.time() - float(data.get("updated", 0)) < 12 * 3600:
            return sid
    except Exception:
        pass
    return None


def _save_session(session_id: Optional[str]) -> None:
    if not session_id:
        return
    try:
        cfg.SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(cfg.SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump({"session_id": session_id, "updated": time.time()}, f)
    except Exception as e:
        cfg.log(f"could not persist session id: {e}")


def reset_session() -> None:
    """Forget the conversation — the spoken equivalent of /clear."""
    try:
        cfg.SESSION_FILE.unlink()
        cfg.log("Conversation reset.")
    except FileNotFoundError:
        pass
    except Exception as e:
        cfg.log(f"could not reset session: {e}")


def _extract(payload: dict) -> tuple[str, Optional[str]]:
    """Pull (reply text, session id) out of `claude --output-format json`."""
    session_id = payload.get("session_id") or payload.get("sessionId")
    result = payload.get("result")

    if isinstance(result, str):
        return result.strip(), session_id
    # Some versions nest the assistant turn under message.content blocks.
    content = (payload.get("message") or {}).get("content")
    if isinstance(content, list):
        text = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
        return text.strip(), session_id
    if isinstance(content, str):
        return content.strip(), session_id
    return "", session_id


def ask(prompt: str, lang: str = "en", timeout: Optional[float] = None) -> str:
    """
    Send one spoken turn to Claude Code and return the reply as plain text.

    Never raises: a failure returns a short spoken-friendly error so the loop can
    say something and go back to listening.
    """
    prompt = (prompt or "").strip()
    if not prompt:
        return ""

    timeout = timeout or cfg.BRAIN_TIMEOUT
    language_note = (
        "Responde en español." if lang.startswith("es") else "Reply in English."
    )
    system = f"{cfg.BRAIN_STYLE} {language_note}"

    args = [
        cfg.CLAUDE_BIN,
        "-p", prompt,
        "--output-format", "json",
        "--append-system-prompt", system,
    ]
    session_id = _load_session()
    if session_id:
        args += ["--resume", session_id]

    def run(cmd: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            cmd,
            cwd=cfg.BRAIN_CWD,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
        )

    try:
        proc = run(args)
        # A resume against an id Claude no longer knows fails fast; retry clean
        # rather than dropping the user's turn on the floor.
        if proc.returncode != 0 and session_id:
            cfg.log("resume failed — starting a fresh conversation")
            reset_session()
            proc = run([a for a in args if a not in ("--resume", session_id)])
    except FileNotFoundError:
        cfg.log(f"`{cfg.CLAUDE_BIN}` not found on PATH")
        return "I could not find the Claude Code command on this machine."
    except subprocess.TimeoutExpired:
        cfg.log(f"claude timed out after {timeout}s")
        return "That took too long, so I stopped waiting."
    except Exception as e:
        cfg.log(f"claude call failed: {e}")
        return "Something went wrong talking to Claude."

    if proc.returncode != 0:
        cfg.log(f"claude exited {proc.returncode}: {(proc.stderr or '').strip()[:400]}")
        return "Claude returned an error."

    raw = (proc.stdout or "").strip()
    if not raw:
        return ""

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        # Older/plain output modes just print the answer.
        return raw

    if isinstance(payload, list):  # stream-json collected into an array
        text, sid = "", None
        for entry in payload:
            if isinstance(entry, dict):
                t, s = _extract(entry)
                text = t or text
                sid = s or sid
        _save_session(sid)
        return text

    text, sid = _extract(payload)
    _save_session(sid)
    return text


def available() -> bool:
    """True when the claude binary is callable."""
    try:
        subprocess.run(
            [cfg.CLAUDE_BIN, "--version"],
            capture_output=True, timeout=20, shell=False,
        )
        return True
    except Exception:
        return False
