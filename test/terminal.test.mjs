/**
 * test/terminal.test.mjs — the reset that makes the NIM fallback usable.
 *
 * These assert on the exact escape sequences, which normally would be testing
 * an implementation detail. Here it is the whole behaviour: the bug was a reset
 * that undid the modes you could see and left the ones that made the terminal
 * unusable, and nothing but the byte-level content distinguishes the fixed
 * version from the broken one. The specific modes checked are the ones the
 * shipped `claude` binary actually sets — found by scanning it, not guessed.
 *
 * Run: node --test test/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { RESTORE, restoreTerminal, drainStdin } from "../terminal.mjs";

/** A stdout that records what was written to it. */
function fakeOut() {
  return { written: "", write(s) { this.written += s; return true; } };
}

/** A stdin that reports as a TTY and remembers raw-mode changes. */
function fakeIn({ isTTY = true } = {}) {
  const s = new EventEmitter();
  s.isTTY = isTTY;
  s.raw = null;
  s.setRawMode = (v) => { s.raw = v; };
  s.paused = true;
  s.isPaused = () => s.paused;
  s.resume = () => { s.paused = false; };
  s.pause = () => { s.paused = true; };
  s.queue = [];
  s.read = () => s.queue.shift() ?? null;
  return s;
}

test("turns off the keyboard protocols that garble every keypress", () => {
  // With either of these left on, `a` arrives as an escape sequence and
  // readline echoes it as text. This is the actual reported symptom: the
  // screen filling with numbers and letters.
  assert.match(RESTORE, /\x1b\[<u/, "pops the kitty keyboard stack (CSI > 1 u)");
  assert.match(RESTORE, /\x1b\[>4;0m/, "turns modifyOtherKeys off (CSI > 4 ; 2 m)");
});

test("turns off every mouse reporting mode", () => {
  // The binary sets 1000 and 1006; the rest are free insurance, since a
  // mode-off for a mode that was never on does nothing.
  for (const mode of [1000, 1002, 1003, 1005, 1006, 1015, 1004]) {
    assert.ok(RESTORE.includes(`\x1b[?${mode}l`), `disables mouse mode ${mode}`);
  }
});

test("leaves the alternate screen before resetting per-screen state", () => {
  // Cursor visibility, colours and the character set are per-screen in xterm.
  // Reset them first and they are applied to the buffer being thrown away.
  const alt = RESTORE.indexOf("\x1b[?1049l");
  assert.ok(alt >= 0, "leaves the alternate screen");
  for (const after of ["\x1b[?25h", "\x1b[0m", "\x1b(B"]) {
    assert.ok(RESTORE.indexOf(after) > alt, `${JSON.stringify(after)} comes after leaving the alt screen`);
  }
});

test("restores the cursor, autowrap and the ASCII charset", () => {
  assert.ok(RESTORE.includes("\x1b[?25h"), "cursor visible");
  assert.ok(RESTORE.includes("\x1b[?7h"), "autowrap on");
  assert.ok(RESTORE.includes("\x1b(B"), "ASCII in G0, undoing DEC line drawing");
  assert.ok(RESTORE.includes("\x1b[?2004l"), "bracketed paste off");
});

test("every sequence is a well-formed escape sequence", () => {
  // A malformed one would be printed as literal text — the very failure this
  // module exists to prevent.
  const remainder = RESTORE.replace(/\x1b(?:\[[0-9;<>?=]*[a-zA-Z]|[()][AB0-2]|[>=])/g, "");
  assert.equal(remainder, "", `unrecognised bytes left over: ${JSON.stringify(remainder)}`);
});

test("restoreTerminal writes the reset and drops raw mode", () => {
  const out = fakeOut();
  const input = fakeIn();
  input.setRawMode(true);

  restoreTerminal(out, input);

  assert.equal(input.raw, false, "raw mode off — readline sets its own up");
  assert.ok(out.written.startsWith(RESTORE), "the full reset went out");
  assert.ok(out.written.endsWith("\n"), "ends on a fresh line");
});

test("restoreTerminal survives a stdin that cannot do raw mode", () => {
  const out = fakeOut();
  const input = fakeIn();
  input.setRawMode = () => { throw new Error("not a tty"); };
  // A pipe rather than a terminal is a normal way to run this, and it must not
  // take the fallback down before it starts.
  assert.doesNotThrow(() => restoreTerminal(out, input));
  assert.ok(out.written.includes("\x1b[?1049l"));
});

test("drainStdin discards what arrived before the reset landed", async () => {
  const input = fakeIn();
  // A mouse report and a kitty-encoded keypress, already in the pipe.
  input.queue.push("\x1b[<35;80;24M", "\x1b[97;1u");

  await drainStdin(input, 5);

  assert.equal(input.read(), null, "nothing left to hand to readline");
  assert.equal(input.paused, true, "left paused, as it was found");
});

test("drainStdin is a no-op when stdin is not a TTY", async () => {
  const input = fakeIn({ isTTY: false });
  input.queue.push("real piped input");
  await drainStdin(input, 5);
  // Piped input is the user's actual data, not terminal noise — swallowing it
  // would break `echo "..." | claudbot`.
  assert.equal(input.read(), "real piped input");
});
