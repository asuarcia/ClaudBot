#!/usr/bin/env node
/**
 * `claudbot voice` — launcher for the Python voice subsystem.
 *
 * The audio stack (openWakeWord, Kokoro, sounddevice, Riva) is Python-only, so
 * voice runs as a sidecar rather than a Node rewrite. This file's job is
 * everything around it: find the right interpreter, pass the repo `.env`
 * through, and offer the sub-commands without making the user remember module
 * paths.
 *
 *   claudbot voice            start the service
 *   claudbot voice devices    list microphones / speakers
 *   claudbot voice train      train the bilingual "Hey Aitor" wake word
 *   claudbot voice enroll     record your voice, train the speaker verifier
 *   claudbot voice say <text> speak something (TTS smoke test)
 *   claudbot voice stop       interrupt whatever the running service is saying
 *   claudbot voice status     what the running service is doing
 *   claudbot voice setup      create the venv and install requirements
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = path.join(ROOT, "voice");
const VENV_PY = process.platform === "win32"
  ? path.join(VOICE_DIR, ".venv", "Scripts", "python.exe")
  : path.join(VOICE_DIR, ".venv", "bin", "python");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", red: "\x1b[31m",
};

// ─── env ─────────────────────────────────────────────────────────────────────

/** Load the repo .env without clobbering anything already in the environment. */
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}

/** Prefer the voice venv; fall back to whatever python is on PATH. */
function pythonBin() {
  if (existsSync(VENV_PY)) return VENV_PY;
  for (const candidate of ["python", "python3", "py"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function controlPort() {
  return process.env.CLAUDBOT_VOICE_PORT || "4710";
}

// ─── running the sidecar ─────────────────────────────────────────────────────

function runPython(moduleName, args = [], { detached = false } = {}) {
  const py = pythonBin();
  if (!py) {
    console.error(`${C.red}[voice] No Python interpreter found.${C.reset}`);
    console.error(`        Install Python 3.11+, then: claudbot voice setup`);
    process.exit(1);
  }

  if (py !== VENV_PY) {
    console.log(`${C.dim}[voice] Using system Python (no venv). ` +
                `Run \`claudbot voice setup\` for an isolated install.${C.reset}`);
  }

  const child = spawn(py, ["-m", moduleName, ...args], {
    cwd: ROOT,                       // package imports resolve as `voice.*`
    stdio: "inherit",
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    detached,
  });

  child.on("error", (err) => {
    console.error(`${C.red}[voice] Could not start Python: ${err.message}${C.reset}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  return child;
}

function cmdSetup() {
  const py = pythonBin();
  if (!py) {
    console.error(`${C.red}[voice] Install Python 3.11+ first.${C.reset}`);
    process.exit(1);
  }

  if (!existsSync(VENV_PY)) {
    console.log(`${C.cyan}[voice] Creating venv at voice/.venv…${C.reset}`);
    const made = spawnSync(py, ["-m", "venv", path.join(VOICE_DIR, ".venv")], { stdio: "inherit" });
    if (made.status !== 0) {
      console.error(`${C.red}[voice] venv creation failed.${C.reset}`);
      process.exit(1);
    }
  }

  console.log(`${C.cyan}[voice] Installing requirements (this takes a few minutes)…${C.reset}`);
  const install = spawnSync(
    VENV_PY,
    ["-m", "pip", "install", "-r", path.join(VOICE_DIR, "requirements.txt")],
    { stdio: "inherit" },
  );
  if (install.status !== 0) {
    console.error(`${C.red}[voice] pip install failed.${C.reset}`);
    process.exit(1);
  }

  console.log(`\n${C.bold}Next:${C.reset}`);
  console.log(`  1. Download the Kokoro TTS model files into voice/models/`);
  console.log(`     ${C.dim}kokoro-v1.0.onnx and voices-v1.0.bin — see voice/README.md${C.reset}`);
  console.log(`  2. ${C.cyan}claudbot voice devices${C.reset}  pick your microphone`);
  console.log(`  3. ${C.cyan}claudbot voice train${C.reset}    train the "Hey Aitor" wake word`);
  console.log(`  4. ${C.cyan}claudbot voice${C.reset}          start talking\n`);
}

/** Talk to a running service's control server. */
async function control(pathname, method = "POST") {
  const url = `http://127.0.0.1:${controlPort()}${pathname}`;
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => ({}));
    console.log(JSON.stringify(body, null, 2));
  } catch {
    console.error(`${C.yellow}[voice] No running voice service on port ${controlPort()}.${C.reset}`);
    process.exit(1);
  }
}

function usage() {
  console.log(`
${C.bold}claudbot voice${C.reset} — talk to Claudbot

  ${C.cyan}claudbot voice${C.reset}             start the voice service
  ${C.cyan}claudbot voice setup${C.reset}       create the venv + install dependencies
  ${C.cyan}claudbot voice devices${C.reset}     list microphones and speakers
  ${C.cyan}claudbot voice devices <n>${C.reset} live level meter for device n
  ${C.cyan}claudbot voice train${C.reset}       train the bilingual "Hey Aitor" wake word
  ${C.cyan}claudbot voice enroll${C.reset}      record your voice -> speaker verifier
  ${C.cyan}claudbot voice say <text>${C.reset}  speak text (TTS smoke test)
  ${C.cyan}claudbot voice status${C.reset}      what the running service is doing
  ${C.cyan}claudbot voice stop${C.reset}        interrupt current speech
  ${C.cyan}claudbot voice reset${C.reset}       forget the current conversation

  ${C.dim}Config lives in .env (CLAUDBOT_VOICE_*). See voice/README.md.${C.reset}
`);
}

// ─── router ──────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  const [sub, ...rest] = process.argv.slice(2);

  switch (sub) {
    case undefined:
    case "start":   return void runPython("voice.service");
    case "setup":   return cmdSetup();
    case "devices": return void runPython("voice.devices", rest);
    case "train":   return void runPython("voice.train_wakeword", rest);
    case "enroll":  return void runPython("voice.record_samples");
    case "say":     return void runPython("voice.say", rest);
    case "status":  return control("/status", "GET");
    case "stop":    return control("/stop");
    case "reset":   return control("/reset");
    case "quit":    return control("/quit");
    case "help":
    case "--help":
    case "-h":      return usage();
    default:
      console.error(`${C.red}[voice] Unknown sub-command "${sub}".${C.reset}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}[voice] Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
