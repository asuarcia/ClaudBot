#!/usr/bin/env node
/**
 * Claudbot bootstrap — run once after cloning onto a new device.
 *
 * Checks the toolchain (node, npm, git, Claude Code CLI), tells the user what
 * is missing BEFORE touching anything, installs it on confirmation, then runs
 * `npm run setup` for the project's own dependencies.
 *
 * Dependency-free on purpose: node_modules does not exist yet on a fresh clone.
 *
 *   node scripts/bootstrap.mjs          ask before installing
 *   node scripts/bootstrap.mjs --yes    install without asking
 *   node scripts/bootstrap.mjs --check  report only, change nothing
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const YES   = process.argv.includes("--yes");
const CHECK = process.argv.includes("--check");
const WIN   = process.platform === "win32";
const MIN_NODE = 22;

function run(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: WIN, ...opts });
}

function version(cmd) {
  const r = run(cmd, ["--version"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function have(cmd) {
  return run(WIN ? "where" : "which", [cmd]).status === 0;
}

/** First available system package manager, as an install-command builder. */
function packageManager() {
  if (WIN && have("winget")) return (id) => ["winget", ["install", "-e", "--id", id, "--accept-source-agreements", "--accept-package-agreements"]];
  if (process.platform === "darwin" && have("brew")) return (_id, brew) => ["brew", ["install", brew]];
  if (have("apt-get")) return (_id, _brew, apt) => ["sudo", ["apt-get", "install", "-y", apt]];
  return null;
}

// ─── the checklist ───────────────────────────────────────────────────────────

const nodeVersion = version("node");
const nodeOk = nodeVersion && Number(nodeVersion.replace(/^v/, "").split(".")[0]) >= MIN_NODE;
const pm = packageManager();

const items = [
  {
    name: `Node.js >= ${MIN_NODE}`,
    ok: nodeOk,
    found: nodeVersion,
    install: pm && (() => pm("OpenJS.NodeJS", "node", "nodejs")),
    manual: "https://nodejs.org",
  },
  {
    name: "npm",
    ok: !!version("npm"),
    found: version("npm"),
    install: null, // ships with Node — reinstalling Node fixes it
    manual: "comes with Node.js",
  },
  {
    name: "git",
    ok: !!version("git"),
    found: version("git"),
    install: pm && (() => pm("Git.Git", "git", "git")),
    manual: "https://git-scm.com",
  },
  {
    name: "Claude Code CLI",
    ok: !!version("claude"),
    found: version("claude"),
    install: () => ["npm", ["install", "-g", "@anthropic-ai/claude-code"]],
    manual: "npm install -g @anthropic-ai/claude-code",
  },
];

console.log("\n[claudbot bootstrap]\n");
for (const i of items) console.log(`  ${i.ok ? "ok     " : "MISSING"}  ${i.name}${i.found ? `  (${i.found})` : ""}`);

const missing = items.filter((i) => !i.ok);
const depsMissing = !existsSync(path.join(ROOT, "node_modules"));

if (!missing.length && !depsMissing) {
  console.log("\nEverything is installed. Next: claudbot onboard\n");
  process.exit(0);
}

// ─── alert first ─────────────────────────────────────────────────────────────

console.log("\nThis device needs:");
for (const i of missing) console.log(`  - ${i.name}${i.install ? "" : `  (install manually: ${i.manual})`}`);
if (depsMissing) console.log("  - Claudbot's npm dependencies (npm run setup)");

if (CHECK) process.exit(1);

if (!YES) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nInstall the above now? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Nothing changed.");
    process.exit(1);
  }
}

// ─── install ─────────────────────────────────────────────────────────────────

let needRestart = false;
for (const i of missing) {
  if (!i.install) { console.log(`\nSkipping ${i.name}: install it manually (${i.manual}).`); continue; }
  // Node/git first (npm-based installs need node); Claude Code is last in the list.
  if (i.name === "Claude Code CLI" && needRestart) {
    console.log("\nNode was just installed — open a new terminal and re-run this script to finish Claude Code.");
    continue;
  }
  const [cmd, args] = i.install();
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const r = run(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) console.log(`Failed to install ${i.name} (exit ${r.status}). Manual: ${i.manual}`);
  else if (i.name !== "Claude Code CLI") needRestart = true; // PATH changes need a fresh shell
}

if (depsMissing && !needRestart) {
  console.log("\n> npm run setup");
  run("npm", ["run", "setup"], { cwd: ROOT, stdio: "inherit" });
}

console.log(needRestart
  ? "\nDone for now. Open a NEW terminal (so PATH refreshes) and run: node scripts/bootstrap.mjs\n"
  : "\nDone. Next: claudbot onboard   (then: claudbot doctor)\n");
