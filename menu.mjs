// menu.mjs — zero-dependency interactive terminal menu for Claudbot
// Node 22+, pure ESM, builtins only (readline, process).
// Written by the `coder` sub-agent; integrated + hardened by Claudbot.

import readline from "node:readline";
import process from "node:process";

// ─── public helpers ──────────────────────────────────────────────────────────

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ─── ANSI ────────────────────────────────────────────────────────────────────

const A = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[97m",
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  CLEAR_LINE: "\x1b[2K",
  UP: (n) => `\x1b[${n}A`,
};

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// ─── menu definition ─────────────────────────────────────────────────────────

const MENU_ITEMS = [
  { label: "▶ Start Claudbot",       desc: "launch the Claude Code agent",               action: "start" },
  { label: "🗓 Organizer",           desc: "your day: tasks, calendar & overnight news", action: "organizer" },
  { label: "↻ Resume last session",  desc: "summarize where you left off, then start",   action: "resume" },
  { label: "🔍 Recall",              desc: "browse & search past sessions",              action: "recall" },
  { label: "📊 Dashboard",           desc: "morning command center on :4500",            action: "dashboard" },
  { label: "📰 Briefing",            desc: "build the news-to-learn digest",             action: "briefing" },
  { label: "💤 Dream",               desc: "run background tasks once",                  action: "dream" },
  { label: "🌙 Night",               desc: "dream + briefing + dashboard bundle",        action: "night" },
  { label: "🩺 Doctor",              desc: "health check",                               action: "doctor" },
  { label: "⬆ Update",              desc: "pull latest + reinstall",                    action: "update" },
  { label: "✕ Exit",                desc: "",                                           action: "exit" },
];

// ─── rendering ───────────────────────────────────────────────────────────────

function truncate(str, max) {
  if (max <= 0) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function renderRow(index, selected, termWidth) {
  const item = MENU_ITEMS[index];
  // 1–9 for the first nine items, 0 for the last (exit); anything between is
  // reachable by arrows only. Keeps the menu length-agnostic as items are added.
  const num = index === MENU_ITEMS.length - 1 ? "0" : index < 9 ? String(index + 1) : "·";
  const prefix = selected ? `${A.CYAN}${A.BOLD}❯ ` : `${A.DIM}  `;
  const labelColor = selected ? `${A.RESET}${A.BOLD}${A.WHITE}` : `${A.RESET}`;
  // budget: 2 prefix + label + " <num>" + "  " + desc
  const descMax = termWidth - 2 - item.label.length - num.length - 5;
  const desc = item.desc ? `  ${A.DIM}${truncate(item.desc, descMax)}${A.RESET}` : "";
  return `${prefix}${A.RESET}${A.DIM}${num}${A.RESET} ${labelColor}${item.label}${A.RESET}${desc}`;
}

function renderLastSession(ls, termWidth) {
  if (!ls?.topic) return [];
  const W = Math.min(62, termWidth - 6);
  const fit = (s) => truncate((s || "").replace(/\s+/g, " ").trim(), W).padEnd(W);
  const head = `Last session · ${ls.rel || ""} `;
  const lines = [];
  lines.push(`${A.DIM}┌─ ${A.RESET}${A.BOLD}${head}${A.RESET}${A.DIM}${"─".repeat(Math.max(0, W - head.length))}─┐${A.RESET}`);
  lines.push(`${A.DIM}│${A.RESET} ${A.WHITE}${fit(ls.topic)}${A.RESET} ${A.DIM}│${A.RESET}`);
  for (const l of (ls.summary || "").split("\n").filter(Boolean).slice(0, 3)) {
    lines.push(`${A.DIM}│ ${fit(l)} │${A.RESET}`);
  }
  lines.push(`${A.DIM}└${"─".repeat(W + 2)}┘${A.RESET}`);
  return lines;
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * Render the Claudbot menu and resolve with the chosen action string:
 * start | organizer | resume | recall | dashboard | briefing | dream |
 * night | doctor | update | exit
 */
export async function showMenu({ lastSession } = {}) {
  if (!isInteractive()) return "start";

  const stdin = process.stdin;
  const stdout = process.stdout;
  let selected = 0;
  let prevLines = 0;
  let done = false;

  const write = (s) => { try { stdout.write(s); } catch { /* ignore */ } };

  return new Promise((resolve) => {
    function cleanup() {
      if (done) return;
      done = true;
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.removeListener("keypress", onKeypress);
      stdin.pause();
      write(A.SHOW_CURSOR + "\n");
    }

    function finish(action) {
      cleanup();
      resolve(action);
    }

    function redraw() {
      try {
        const termWidth = stdout.columns || 80;
        const lines = [];
        const box = renderLastSession(lastSession, termWidth);
        if (box.length) { lines.push(...box.map((l) => "  " + l)); lines.push(""); }
        for (let i = 0; i < MENU_ITEMS.length; i++) {
          lines.push("  " + renderRow(i, i === selected, termWidth - 2));
        }
        lines.push("");
        lines.push(`  ${A.DIM}↑↓ / j k move · 1-9,0 jump · enter select · q / esc exit${A.RESET}`);

        if (prevLines > 0) write(A.UP(prevLines) + "\r");
        for (let i = 0; i < lines.length; i++) {
          write(A.CLEAR_LINE + lines[i] + "\n");
        }
        prevLines = lines.length;
      } catch { /* rendering must never crash the CLI */ }
    }

    function onKeypress(chunk, key) {
      if (done) return;
      try {
        const name = key?.name ?? "";
        const seq = key?.sequence ?? (typeof chunk === "string" ? chunk : "");

        if (name === "escape" || (name === "c" && key?.ctrl) || seq === "q") return finish("exit");
        if (name === "return" || name === "enter" || name === "space") {
          return finish(MENU_ITEMS[selected].action);
        }
        if (/^[1-9]$/.test(seq)) return finish(MENU_ITEMS[Number(seq) - 1].action);
        if (seq === "0") return finish(MENU_ITEMS[MENU_ITEMS.length - 1].action);
        if (name === "up" || seq === "k") {
          selected = (selected - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
          return redraw();
        }
        if (name === "down" || seq === "j" || name === "tab") {
          selected = (selected + 1) % MENU_ITEMS.length;
          return redraw();
        }
      } catch { /* swallow — a bad keypress must not kill the menu */ }
    }

    write(A.HIDE_CURSOR);
    readline.emitKeypressEvents(stdin);
    try { stdin.setRawMode(true); } catch { /* non-TTY edge */ }
    stdin.on("keypress", onKeypress);
    stdin.resume();
    redraw();
  });
}
