#!/usr/bin/env node
/**
 * Claudbot night mode — the idle-process supervisor.
 *
 * Runs every background process together, the way you'd leave it overnight:
 *   • dream     — reflection / memory / research / planning  (dream.mjs --watch)
 *   • briefing  — the "news to learn from" crawler+digest     (briefing.mjs --watch)
 *   • dashboard — the morning command center web app          (dashboard.mjs)
 *
 * Each runs as its own child process (isolated, individually restartable). If
 * one crashes it's relaunched with backoff; the others keep running. This is the
 * exact thing the NUC VM runs as a service, so your PC doesn't stay on overnight.
 *
 * Usage:
 *   node night.mjs                     # dream + briefing + dashboard
 *   node night.mjs --no-dashboard      # headless (e.g. a NUC box with no browser)
 *   node night.mjs --only dream,briefing
 *   node night.mjs --port 4600         # dashboard port
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

const argv = process.argv.slice(2);
const noDashboard = argv.includes("--no-dashboard");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx !== -1 ? (argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const portIdx = argv.indexOf("--port");
const port = portIdx !== -1 ? argv[portIdx + 1] : (process.env.DASHBOARD_PORT ?? "4500");

// The processes night mode supervises.
const PROCS = [
  { name: "dream",     script: "dream.mjs",     args: ["--watch"] },
  { name: "briefing",  script: "briefing.mjs",  args: ["--watch"] },
  { name: "dashboard", script: "dashboard.mjs", args: ["--port", String(port)], skip: noDashboard },
].filter((p) => !p.skip && (!only || only.includes(p.name)));

const C = { reset: "\x1b[0m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };
const tag = (n) => `${C.cyan}[${n}]${C.reset}`;

const children = new Map();
let shuttingDown = false;

function launch(proc, backoffMs = 1000) {
  const child = spawn("node", [path.join(ROOT, proc.script), ...proc.args], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(proc.name, child);

  const pipe = (stream, isErr) => {
    stream.on("data", (buf) => {
      for (const line of buf.toString().split("\n")) {
        if (line.trim()) process.stdout.write(`${tag(proc.name)} ${isErr ? C.yellow : ""}${line}${C.reset}\n`);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on("exit", (code, signal) => {
    children.delete(proc.name);
    if (shuttingDown) return;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    // Clean exit of a one-shot is fine; but these are --watch/servers, so any
    // exit is unexpected — relaunch with capped exponential backoff.
    const next = Math.min(backoffMs * 2, 60_000);
    console.log(`${tag(proc.name)} ${C.red}exited (${why}) — restarting in ${backoffMs / 1000}s${C.reset}`);
    setTimeout(() => { if (!shuttingDown) launch(proc, next); }, backoffMs);
  });

  child.on("error", (err) => {
    console.log(`${tag(proc.name)} ${C.red}failed to start: ${err.message}${C.reset}`);
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${C.dim}[night] stopping ${children.size} process(es)…${C.reset}`);
  for (const child of children.values()) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`
  ${C.green}● claudbot night${C.reset} ${C.dim}— idle-process supervisor${C.reset}
  ${C.dim}running: ${PROCS.map((p) => p.name).join(", ") || "(nothing — check --only)"}${C.reset}
  ${C.dim}dashboard: ${noDashboard ? "off" : `http://localhost:${port}`}  ·  Ctrl+C to stop${C.reset}
`);

if (PROCS.length === 0) { console.error("[night] nothing to run."); process.exit(1); }
for (const proc of PROCS) launch(proc);
