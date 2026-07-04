#!/usr/bin/env node
// night-sync.mjs — pull the NUC night VM's dream log + news digest to the PC.
//
// The VM appends to its own dream-log.md around the clock and serves it raw at
// GET {CLAUDBOT_NIGHT_URL}/api/dream-log; it also serves the news it scavenged
// overnight as JSON at GET {CLAUDBOT_NIGHT_URL}/api/briefing. This script
// (spawned detached by the claudbot launcher, silent by default) appends only
// the new remote dream content to the local .claudbot/dream-log.md, and mirrors
// the latest briefing to .claudbot/briefing.nuc.json — so PC + VM dreams live in
// one file and Claudbot can see the news the VM found.
//
// Written by the `coder` sub-agent; integrated by Claudbot.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOCAL_LOG = join(ROOT, ".claudbot", "dream-log.md");
const STATE_FILE = join(ROOT, ".claudbot", ".night-sync.json");
const MIRROR = join(ROOT, ".claudbot", "dream-log.nuc.md");
const BRIEFING_MIRROR = join(ROOT, ".claudbot", "briefing.nuc.json");
const VERBOSE = process.argv.includes("--verbose");

// Load .env from ROOT (don't override existing env)
try {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in process.env) continue;
      process.env[key] = trimmed.slice(eqIdx + 1).trim();
    }
  }
} catch { /* ignore env load errors */ }

const baseUrl = process.env.CLAUDBOT_NIGHT_URL;
if (!baseUrl) {
  if (VERBOSE) console.log("no CLAUDBOT_NIGHT_URL set");
  process.exit(0);
}

try {
  await main();
} catch { /* sync is best-effort — always exit clean */ }
process.exit(0);

async function main() {
  const url = `${baseUrl.replace(/\/$/, "")}/api/dream-log`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch {
    if (VERBOSE) console.log("fetch failed (VM may be off)");
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    if (VERBOSE) console.log(`non-200 status: ${res.status}`);
    return;
  }

  const remote = await res.text();
  if (remote.length === 0) {
    if (VERBOSE) console.log("remote empty");
    return;
  }

  // Load state ({syncedLen, tail} of what's already been merged)
  let state = { syncedLen: 0, tail: "" };
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch { /* corrupt → reset */ }

  mkdirSync(join(ROOT, ".claudbot"), { recursive: true });

  const sepHeader = `\n<!-- synced from NUC ${new Date().toISOString()} -->\n`;
  let resultMsg = "";

  if (state.syncedLen === 0) {
    // First sync — bring over everything the VM has dreamed so far
    appendFileSync(LOCAL_LOG, sepHeader + remote, "utf8");
    resultMsg = `synced ${remote.length} new chars (first sync)`;
  } else if (
    remote.length >= state.syncedLen &&
    remote.slice(Math.max(0, state.syncedLen - state.tail.length), state.syncedLen) === state.tail
  ) {
    // Remote grew where we left off — append just the delta
    const delta = remote.slice(state.syncedLen);
    if (delta.trim()) {
      appendFileSync(LOCAL_LOG, sepHeader + delta, "utf8");
      resultMsg = `synced ${delta.length} new chars`;
    } else {
      resultMsg = "up to date";
    }
  } else {
    // Remote was rewritten/rotated — mirror it whole instead of duplicating
    writeFileSync(MIRROR, remote, "utf8");
    resultMsg = "mirror updated (remote log rewritten)";
  }

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ syncedLen: remote.length, tail: remote.slice(-64) }, null, 2),
    "utf8",
  );

  if (VERBOSE) console.log(resultMsg);

  // Also pull the news the VM scavenged overnight (best-effort, independent).
  await syncBriefing();
}

// Mirror the VM's news digest to .claudbot/briefing.nuc.json, write-if-changed.
async function syncBriefing() {
  const url = `${baseUrl.replace(/\/$/, "")}/api/briefing`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch {
    if (VERBOSE) console.log("briefing fetch failed (VM may be off)");
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    if (VERBOSE) console.log(`briefing non-200 status: ${res.status}`);
    return;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    if (VERBOSE) console.log("briefing not valid JSON — skipping");
    return;
  }

  const pretty = JSON.stringify(json, null, 2);
  let existing = null;
  try {
    if (existsSync(BRIEFING_MIRROR)) existing = readFileSync(BRIEFING_MIRROR, "utf8");
  } catch { /* unreadable → overwrite */ }

  if (existing === pretty) {
    if (VERBOSE) console.log("briefing up to date");
    return;
  }

  mkdirSync(join(ROOT, ".claudbot"), { recursive: true });
  writeFileSync(BRIEFING_MIRROR, pretty, "utf8");
  if (VERBOSE) console.log(`briefing mirrored (${pretty.length} chars)`);
}
