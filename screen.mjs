#!/usr/bin/env node
/**
 * `claudbot screen` — screen awareness.
 *
 * Claude can see what you're working on without you pasting screenshots. A
 * heartbeat captures the screen, a NIM vision model describes it, and only a
 * short rolling summary plus the single latest frame ever reach Claude.
 *
 * Three rules this file exists to enforce:
 *
 *   1. OFF BY DEFAULT, never silent. Capture only runs after an explicit
 *      `claudbot screen on`, and the state is visible in the banner, in
 *      `screen status`, and in the watcher's own stdout.
 *   2. NEVER on the Claude plan. Description runs on the `vision` agent from
 *      agents.yaml (NIM). This is background polling; billing it to the plan
 *      would be indefensible. See docs/cost-routing.md.
 *   3. No screenshot history. Identical frames are skipped by hash, and only
 *      the newest PNG is kept on disk — older ones are deleted, not archived.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { agentApiKey, findAgent } from "./providers/agents.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");
const SCREEN_DIR = path.join(CLAUDBOT_ROOT, "screen");
const STATE_FILE = path.join(SCREEN_DIR, "state.json");
const PID_FILE = path.join(SCREEN_DIR, "watcher.pid");
const CAPTURE_PS1 = path.join(ROOT, "scripts", "capture-screen.ps1");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

// How many rolling summary entries Claude ever sees. Small on purpose — this is
// meant to be a paragraph of context, not a log.
const MAX_SUMMARY_ENTRIES = 10;
// Average-hash Hamming distance below which two frames count as "the same
// screen". A cursor blink or a clock tick moves 1-2 bits; a window switch moves
// far more.
const SAME_FRAME_DISTANCE = 4;

// ─── env ─────────────────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}

const intervalMs = () => {
  const n = Number(process.env.CLAUDBOT_SCREEN_INTERVAL_MIN);
  return (Number.isFinite(n) && n > 0 ? n : 5) * 60_000;
};
const visionAgentName = () => process.env.CLAUDBOT_SCREEN_AGENT?.trim() || "vision";
const monitorArg = () => String(Number(process.env.CLAUDBOT_SCREEN_MONITOR) || 0);

// ─── state ───────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { enabled: false, entries: [], lastHash: null, latest: null };
  }
}

function saveState(state) {
  mkdirSync(SCREEN_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Delete every capture except the newest — history never accumulates. */
function pruneCaptures(keepPath) {
  try {
    for (const name of readdirSync(SCREEN_DIR)) {
      if (!name.endsWith(".png")) continue;
      const full = path.join(SCREEN_DIR, name);
      if (keepPath && path.resolve(full) === path.resolve(keepPath)) continue;
      rmSync(full, { force: true });
    }
  } catch { /* non-fatal */ }
}

// ─── capture ─────────────────────────────────────────────────────────────────

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

function capture() {
  if (process.platform !== "win32") {
    return { error: "Screen capture is currently implemented for Windows only." };
  }
  mkdirSync(SCREEN_DIR, { recursive: true });
  const outPath = path.join(SCREEN_DIR, `capture-${Date.now()}.png`);

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
     "-File", CAPTURE_PS1, "-OutPath", outPath, "-Monitor", monitorArg()],
    { encoding: "utf8", timeout: 60_000, windowsHide: true },
  );

  const raw = (result.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (!raw) {
    return { error: `capture failed: ${(result.stderr || "no output").trim().slice(0, 300)}` };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: `capture returned unparseable output: ${raw.slice(0, 200)}` };
  }
}

// ─── description (NIM vision — never Claude) ─────────────────────────────────

const DESCRIBE_PROMPT =
  "You are watching a developer's screen. In 2-3 sentences, plainly state: which " +
  "application is in focus, what is on screen, and what the person appears to be " +
  "doing. Quote any error message, dialog or prominent heading verbatim. Do not " +
  "speculate about intent beyond what is visible. No preamble.";

async function describe(imagePath, { retries = 3 } = {}) {
  let agent;
  try {
    agent = findAgent(visionAgentName());
  } catch (e) {
    return { error: `${e.message} Add a vision agent to .claudbot/agents.yaml.` };
  }

  const apiKey = agentApiKey(agent);
  if (agent.apiKeyEnv && !apiKey) {
    return { error: `${agent.apiKeyEnv} is not set — cannot describe captures.` };
  }

  let b64;
  try {
    b64 = readFileSync(imagePath).toString("base64");
  } catch (e) {
    return { error: `could not read capture: ${e.message}` };
  }

  const body = {
    model: agent.model,
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: DESCRIBE_PROMPT },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
  };

  // NIM key contention is real here — the dream loop and other batch jobs share
  // this key and 429s come in bursts. Back off rather than hammering.
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${agent.endpoint.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });

      if (res.status === 429 || res.status >= 500) {
        const wait = 2000 * 2 ** attempt;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        return { error: `vision endpoint returned HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { error: `vision endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      return text ? { text } : { error: "vision model returned nothing" };
    } catch (e) {
      if (attempt === retries - 1) return { error: `vision call failed: ${e.message}` };
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  return { error: "vision call failed" };
}

// ─── one observation cycle ───────────────────────────────────────────────────

/**
 * Capture, decide whether anything changed, describe only if it did, and fold
 * the result into the rolling summary.
 */
async function observe({ force = false, quiet = false } = {}) {
  const state = loadState();
  const shot = capture();
  if (shot.error) {
    if (!quiet) console.error(`${C.red}[screen] ${shot.error}${C.reset}`);
    return { ...shot, changed: false };
  }

  const distance = hamming(state.lastHash, shot.hash);
  const changed = force || distance > SAME_FRAME_DISTANCE;

  if (!changed) {
    // Identical frame: throw the new PNG away, keep the old one, spend nothing.
    rmSync(shot.path, { force: true });
    state.lastCheckedAt = new Date().toISOString();
    saveState(state);
    if (!quiet) console.log(`${C.dim}[screen] unchanged (distance ${distance}) — not re-analyzed${C.reset}`);
    return { changed: false, distance, latest: state.latest };
  }

  const described = await describe(shot.path);
  const now = new Date().toISOString();

  if (described.error) {
    if (!quiet) console.error(`${C.yellow}[screen] ${described.error}${C.reset}`);
    // Keep the frame and its hash so the next cycle compares against reality,
    // but do not write an entry we could not actually describe.
    pruneCaptures(shot.path);
    state.lastHash = shot.hash;
    state.latest = { path: shot.path, at: now, width: shot.width, height: shot.height };
    state.lastCheckedAt = now;
    saveState(state);
    return { changed: true, distance, error: described.error };
  }

  const entries = [...(state.entries ?? []), { at: now, text: described.text }]
    .slice(-MAX_SUMMARY_ENTRIES);

  pruneCaptures(shot.path);
  saveState({
    ...state,
    entries,
    lastHash: shot.hash,
    lastCheckedAt: now,
    latest: {
      path: shot.path, at: now, width: shot.width,
      height: shot.height, source: shot.source,
    },
  });

  if (!quiet) {
    console.log(`${C.cyan}[screen] ${now.slice(11, 19)}${C.reset} ${described.text}`);
  }
  return { changed: true, distance, text: described.text, latest: shot.path };
}

// ─── watcher ─────────────────────────────────────────────────────────────────

async function watch() {
  const state = loadState();
  state.enabled = true;
  saveState(state);
  writeFileSync(PID_FILE, String(process.pid));

  const every = intervalMs();
  console.log(
    `\n  ${C.green}●${C.reset} ${C.bold}Screen awareness is ON${C.reset}\n` +
    `    capturing every ${every / 60000} minute(s) · described by the ` +
    `${C.cyan}${visionAgentName()}${C.reset} agent (NIM, not Claude)\n` +
    `    ${C.dim}claudbot screen off  to stop · claudbot screen status  to check${C.reset}\n`,
  );

  const stop = () => {
    const s = loadState();
    s.enabled = false;
    saveState(s);
    rmSync(PID_FILE, { force: true });
    console.log(`\n  ${C.dim}Screen awareness off.${C.reset}\n`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await observe({ force: true });
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    if (!loadState().enabled) return stop();
    try {
      await observe();
    } catch (e) {
      console.error(`${C.yellow}[screen] cycle failed: ${e.message}${C.reset}`);
    }
  }
}

function watcherPid() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return null;
  }
}

// ─── commands ────────────────────────────────────────────────────────────────

function cmdOn() {
  if (watcherPid()) {
    console.log(`${C.yellow}[screen] Already on.${C.reset} Run: claudbot screen status`);
    return;
  }
  const child = spawn(process.execPath, [path.join(ROOT, "screen.mjs"), "watch"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const state = loadState();
  state.enabled = true;
  saveState(state);

  console.log(
    `\n  ${C.green}●${C.reset} ${C.bold}Screen awareness ON${C.reset} ` +
    `${C.dim}(pid ${child.pid})${C.reset}\n` +
    `    Your screen is captured every ${intervalMs() / 60000} minute(s) and ` +
    `described by the ${C.cyan}${visionAgentName()}${C.reset} agent on NIM.\n` +
    `    Only the newest frame and a short rolling summary reach Claude.\n` +
    `    ${C.dim}claudbot screen off${C.reset} to stop.\n`,
  );
}

function cmdOff() {
  const state = loadState();
  state.enabled = false;
  saveState(state);

  const pid = watcherPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  rmSync(PID_FILE, { force: true });
  pruneCaptures(null); // leave nothing behind

  console.log(`\n  ${C.dim}○ Screen awareness OFF. Captures deleted.${C.reset}\n`);
}

async function cmdNow() {
  console.log(`${C.dim}[screen] capturing…${C.reset}`);
  // quiet: observe's own per-cycle logging is for the watcher; here we print once.
  const result = await observe({ force: true, quiet: true });
  if (result.error) {
    console.error(`${C.red}[screen] ${result.error}${C.reset}`);
    process.exit(1);
  }
  if (result.text) console.log(`\n${result.text}\n`);
}

function cmdStatus() {
  const state = loadState();
  const pid = watcherPid();
  const on = Boolean(pid) && state.enabled;

  console.log(
    `\n  ${on ? `${C.green}●${C.reset} ON` : `${C.dim}○ OFF${C.reset}`}` +
    `${pid ? `  ${C.dim}(watcher pid ${pid})${C.reset}` : ""}`,
  );
  console.log(`    interval   ${intervalMs() / 60000} min`);
  console.log(`    describer  ${visionAgentName()} ${C.dim}(NIM — never the Claude plan)${C.reset}`);
  console.log(`    monitor    ${monitorArg() === "-1" ? "all (stitched)" : monitorArg()}`);
  if (state.latest) {
    console.log(`    latest     ${state.latest.at} ${C.dim}${state.latest.path}${C.reset}`);
  }
  console.log(`    summary    ${(state.entries ?? []).length} entr(ies) retained\n`);

  for (const e of (state.entries ?? []).slice(-3)) {
    console.log(`    ${C.dim}${e.at.slice(11, 19)}${C.reset} ${e.text}`);
  }
  console.log();
}

/**
 * The compact block Claude actually reads. Latest frame path plus the rolling
 * text summary — never a screenshot history.
 */
function cmdContext() {
  const state = loadState();
  if (!state.enabled && !state.latest) {
    console.log("Screen awareness is off. Turn it on with: claudbot screen on");
    return;
  }

  const lines = [`Screen awareness: ${state.enabled ? "ON" : "off (showing last known state)"}`];
  if (state.latest) {
    lines.push(
      `Latest capture: ${state.latest.path}`,
      `Captured at: ${state.latest.at}`,
      "(Read that path to see the screen. It is the only frame kept.)",
    );
  }
  const entries = state.entries ?? [];
  if (entries.length) {
    lines.push("", "What has been on screen (oldest first):");
    for (const e of entries) lines.push(`- ${e.at.slice(11, 16)} — ${e.text}`);
  }
  console.log(lines.join("\n"));
}

function usage() {
  console.log(`
${C.bold}claudbot screen${C.reset} — let Claude see your screen

  ${C.cyan}claudbot screen on${C.reset}       start the capture heartbeat
  ${C.cyan}claudbot screen off${C.reset}      stop it and delete captures
  ${C.cyan}claudbot screen now${C.reset}      capture and describe right now
  ${C.cyan}claudbot screen status${C.reset}   is it on, and what has it seen
  ${C.cyan}claudbot screen context${C.reset}  the compact block Claude reads

  ${C.dim}Off by default. Captures are described by a NIM vision model, never by
  Claude — background polling must not spend plan usage. Only the newest frame
  and a short rolling summary are kept; there is no screenshot history.

  Tune with CLAUDBOT_SCREEN_INTERVAL_MIN / _AGENT / _MONITOR in .env.${C.reset}
`);
}

// ─── router ──────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  const [cmd] = process.argv.slice(2);

  switch (cmd) {
    case "on": return cmdOn();
    case "off": return cmdOff();
    case "now": return cmdNow();
    case "watch": return watch();
    case "status":
    case undefined: return cmdStatus();
    case "context": return cmdContext();
    case "help":
    case "--help":
    case "-h": return usage();
    default:
      console.error(`${C.red}[screen] Unknown sub-command "${cmd}".${C.reset}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}[screen] Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
