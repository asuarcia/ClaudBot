/**
 * terminal.mjs — putting the terminal back after hard-killing a full-screen TUI.
 *
 * Claudbot kills the Claude Code TUI to hand over to the NIM fallback, and on
 * Windows `kill("SIGTERM")` is TerminateProcess — there is no signal handler, no
 * cleanup, no chance for the TUI to undo anything it turned on. Whatever modes
 * it set are still set when the fallback REPL starts.
 *
 * That is not cosmetic. Scanning the shipped `claude` binary for mode-setting
 * sequences finds `?1049h` (alternate screen), `?1000h` + `?1006h` (SGR mouse
 * reporting), `>4;2m` (xterm modifyOtherKeys) and `>1u` (the kitty keyboard
 * protocol). The last two are the ones that hurt: with either still active,
 * every ordinary keypress arrives as an escape sequence like `\x1b[97;1u`
 * instead of the letter `a`, and readline — which knows nothing about those
 * protocols — echoes the raw text. Typing anything fills the screen with
 * numbers, letters and semicolons. With mouse reporting still on, so does
 * moving the mouse.
 *
 * The old reset here sent three sequences: leave the alternate screen, show the
 * cursor, reset colours. It undid the part you could see and none of the parts
 * that made the terminal unusable.
 *
 * So this resets everything a TUI might plausibly have turned on, whether or not
 * this particular one did. Sending a mode-off for a mode that was never on is
 * free, and a well-formed CSI sequence a terminal does not implement is parsed
 * and discarded rather than printed — so the belt-and-braces entries cannot make
 * things worse on a terminal that lacks them.
 */

/**
 * Every sequence, in the order they have to go out.
 *
 * Leaving the alternate screen comes first: cursor visibility, colours and the
 * selected character set are per-screen in xterm and its descendants, so
 * resetting them while still on the alternate screen would reset the screen
 * that is about to be discarded.
 */
export const RESTORE = [
  "\x1b[?1049l", // leave the alternate screen buffer

  // Keyboard protocols. These are the ones that turn every keypress into
  // gibberish, and the reason this module exists.
  "\x1b[<u",     // pop the kitty keyboard protocol stack (undoes CSI > 1 u)
  "\x1b[>4;0m",  // modifyOtherKeys off (undoes CSI > 4 ; 2 m)
  "\x1b[?1l",    // normal cursor keys, not application mode
  "\x1b>",       // normal keypad, not application keypad

  // Mouse reporting, in every encoding a TUI might have asked for. Left on,
  // moving the mouse writes coordinate reports straight into the input stream.
  "\x1b[?1000l", // click tracking
  "\x1b[?1002l", // drag tracking
  "\x1b[?1003l", // any-motion tracking
  "\x1b[?1005l", // UTF-8 extended coordinates
  "\x1b[?1006l", // SGR extended coordinates
  "\x1b[?1015l", // urxvt extended coordinates
  "\x1b[?1004l", // focus in/out reporting

  "\x1b[?2004l", // bracketed paste off
  "\x1b[?7h",    // autowrap back on
  "\x1b(B",      // ASCII in G0 — undoes DEC line-drawing, which shows as symbols
  "\x1b[0m",     // default colours and attributes
  "\x1b[?25h",   // cursor visible
].join("");

/**
 * Restore the terminal to a state a line-based REPL can use.
 *
 * Also drops raw mode: the TUI put stdin into it, and readline expects to set
 * that up itself.
 */
export function restoreTerminal(out = process.stdout, input = process.stdin) {
  try { if (input.isTTY) input.setRawMode(false); } catch { /* not a TTY */ }
  out.write(RESTORE);
  out.write("\n");
}

/**
 * Throw away input that arrived before the reset landed.
 *
 * Between the TUI dying and the modes being turned off there is a window — a
 * few milliseconds, plus however long the terminal takes — in which mouse
 * movement and keystrokes are still being encoded as escape sequences. That
 * text is already in the pipe, and readline would take it as the user's first
 * line and hand a screenful of `[<35;80;24M` to the model.
 *
 * Resolves after `settleMs`, which has to be long enough for the terminal to
 * process the reset and stop sending, and short enough not to be felt.
 */
export function drainStdin(input = process.stdin, settleMs = 150) {
  return new Promise((resolve) => {
    if (!input.isTTY) return resolve();

    // resume() is what actually makes the buffered data readable; without it
    // the stream stays paused and read() returns null however much is queued.
    const wasPaused = input.isPaused();
    input.resume();

    const timer = setTimeout(() => {
      while (input.read() !== null) { /* discard */ }
      if (wasPaused) input.pause();
      resolve();
    }, settleMs);

    // Never hold the process open on account of a cleanup timer.
    timer.unref?.();
  });
}
