#!/usr/bin/env node
/**
 * Cost-routing guard.
 *
 * One rule: anything that runs while the user is not typing runs on NIM, never
 * on the Claude plan. That rule is easy to state and easy to break six months
 * later by adding one convenient `spawn("claude", ...)` to a background script.
 *
 * This script fails loudly when that happens. Run it in CI, or:
 *   node scripts/check-cost-routing.mjs
 *
 * See docs/cost-routing.md for the routing table this enforces.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Runs unattended. Must never invoke the claude binary.
const BACKGROUND = [
  "dream.mjs",
  "briefing.mjs",
  "night.mjs",
  "night-sync.mjs",
  "memory.mjs",
  "screen.mjs",
  "organizer.mjs",
  "dashboard.mjs",
  "channel-server.mjs",
];

// Runs because the user is right there. Claude is correct here.
const FOREGROUND = [
  "claudbot.mjs",           // the interactive session itself
  "scripts/onboard.mjs",    // interactive setup wizard
  "voice/brain.py",         // user is speaking to it
];

// Matches an attempt to run the CLI, not the word "claude" in prose or a path.
const CLAUDE_INVOCATION =
  /(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(["'`])claude\2|CLAUDE_BIN|["'`]claude["'`]\s*,\s*\[/;

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", bold: "\x1b[1m" };

let failures = 0;

console.log(`\n${C.bold}Cost-routing check${C.reset}\n`);

for (const rel of BACKGROUND) {
  let source;
  try {
    source = readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    console.log(`  ${C.dim}skip  ${rel} (not present)${C.reset}`);
    continue;
  }

  const offenders = source
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => CLAUDE_INVOCATION.test(line) && !line.startsWith("//") && !line.startsWith("*"));

  if (offenders.length === 0) {
    console.log(`  ${C.green}ok${C.reset}    ${rel} ${C.dim}— NIM only${C.reset}`);
  } else {
    failures += offenders.length;
    console.log(`  ${C.red}FAIL${C.reset}  ${rel} spawns the claude binary:`);
    for (const o of offenders) console.log(`          ${C.dim}${rel}:${o.n}${C.reset} ${o.line.slice(0, 100)}`);
  }
}

console.log(`\n${C.dim}Foreground paths (Claude is correct here, not checked):${C.reset}`);
for (const rel of FOREGROUND) console.log(`  ${C.dim}- ${rel}${C.reset}`);

if (failures > 0) {
  console.error(
    `\n${C.red}${C.bold}${failures} background path(s) would bill the Claude plan.${C.reset}\n` +
    `Route them through providers/agents.mjs runAgent() instead. ` +
    `See docs/cost-routing.md.\n`,
  );
  process.exit(1);
}

console.log(`\n${C.green}${C.bold}All background paths run on NIM.${C.reset}\n`);
