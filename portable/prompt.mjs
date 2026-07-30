/**
 * portable/prompt.mjs — terminal prompts shared by boot, sync and provisioning.
 *
 * Passphrase entry needs raw mode so nothing is echoed, which is fiddly enough
 * that three copies of it had started to drift. This is the one copy.
 *
 * Control keys are built with String.fromCharCode rather than written as escape
 * sequences: an earlier version of this logic silently lost its backspace
 * comparison to a mangled literal, so the intent is spelled out here.
 */

import readline from "node:readline";

const CTRL_C    = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE    = String.fromCharCode(127);

/**
 * One keystroke of passphrase editing, as a pure function so it can be tested
 * without a terminal.
 * @returns {{buf: string, done: "submit"|"cancel"|null}}
 */
export function feedPassphraseChar(buf, c) {
  if (c === "\r" || c === "\n")            return { buf, done: "submit" };
  if (c === CTRL_C)                        return { buf, done: "cancel" };
  if (c === DELETE || c === BACKSPACE)     return { buf: buf.slice(0, -1), done: null };
  if (c < " ")                             return { buf, done: null };  // ignore other control keys
  return { buf: buf + c, done: null };
}

/** Read a line with no echo. Rejects with "cancelled" on Ctrl-C. */
export function askHidden(prompt = "Passphrase: ") {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("no terminal available to read a passphrase"));
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";
    const finish = (fn, arg) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      fn(arg);
    };
    const onData = (ch) => {
      // A paste arrives as one chunk — handle it a character at a time.
      for (const c of ch) {
        const step = feedPassphraseChar(buf, c);
        if (step.done === "submit") return finish(resolve, step.buf);
        if (step.done === "cancel") return finish(reject, new Error("cancelled"));
        buf = step.buf;
      }
    };
    stdin.on("data", onData);
  });
}

/** Ask for a new passphrase twice, refusing short or mismatched entries. */
export async function askNewPassphrase({ minLength = 8, warn = console.log } = {}) {
  for (;;) {
    const a = await askHidden("  Choose a passphrase: ");
    if (a.length < minLength) { warn(`  At least ${minLength} characters, please.`); continue; }
    const b = await askHidden("  Again to confirm:    ");
    if (a !== b) { warn("  Those didn't match. Try again."); continue; }
    return a;
  }
}

/** Plain yes/no. Anything other than y/yes is a no. */
export function askYesNo(question, { defaultYes = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (a) => {
      rl.close();
      const t = a.trim();
      if (!t) return resolve(defaultYes);
      resolve(/^y(es)?$/i.test(t));
    });
  });
}
