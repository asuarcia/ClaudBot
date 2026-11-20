#!/usr/bin/env node
/**
 * tunnel/watchdog.mjs — keep a VS Code Remote Tunnel up, and bring it back if it drops.
 *
 *   node tunnel/watchdog.mjs install     register the heartbeat task (and do a first pass)
 *   node tunnel/watchdog.mjs uninstall   remove it
 *   node tunnel/watchdog.mjs status      tunnel state + task state + recent log
 *   node tunnel/watchdog.mjs run         one heartbeat (what the task runs)
 *
 * ── What "a tunnel is on" means here ────────────────────────────────────────
 *
 * `code tunnel service install` (or "Turn on Remote Tunnel Access → install as
 * a service" in the editor) writes a "Visual Studio Code Tunnel" value under
 * HKCU\...\CurrentVersion\Run. That value is the switch: the CLI's own
 * `service_installed` flag is read from it, and it holds the exact command line
 * the service runs. So the heartbeat is armed by the Run value, not by a name
 * baked in here — install any tunnel, rename it, re-login, and the heartbeat
 * guards whatever is configured. `code tunnel service uninstall` deletes the
 * value, and the heartbeat goes quiet instead of resurrecting a tunnel the user
 * deliberately turned off.
 *
 * ── The heal ladder ──────────────────────────────────────────────────────────
 *
 *   Connected                       → nothing to do
 *   not Connected                   → wait, look again (the CLI reconnects on its own;
 *                                     a heartbeat landing mid-reconnect must not act)
 *   service process missing         → relaunch it from the Run value
 *   process up but still not connected → `code tunnel restart`
 *   still not connected             → `code tunnel kill`, relaunch from the Run value
 *   still not connected             → give up for this tick, log last_fail_reason
 *
 * Auth failures (expired GitHub/Microsoft token) can't be fixed unattended; the
 * log says so and names the command (`code tunnel user login`).
 *
 * Desktop-only, like widgets/autostart.mjs, and uses the same windowless
 * launcher (wscript + a generated .vbs, conhost --headless as fallback) — see
 * the long comment there for why. Runs no model: zero cost to the Claude plan.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { appDir } from "../portable/paths.mjs";

const ROOT     = appDir();
const OUT_DIR  = path.join(ROOT, ".claudbot", "tunnel");
const SELF     = path.join(ROOT, "tunnel", "watchdog.mjs");
const SHIM     = path.join(OUT_DIR, "watchdog.vbs");
const TASK_XML = path.join(OUT_DIR, "watchdog.xml");
const LOG      = path.join(OUT_DIR, "watchdog.log");

const TASK_NAME = "\\Claudbot\\TunnelWatchdog";
const INTERVAL  = "PT30M";

const RUN_KEY   = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "Visual Studio Code Tunnel";

const SYS32    = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const WSCRIPT  = path.join(SYS32, "wscript.exe");
const CONHOST  = path.join(SYS32, "conhost.exe");
const SCHTASKS = path.join(SYS32, "schtasks.exe");
const REG      = path.join(SYS32, "reg.exe");
const POWERSHELL = path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe");

const LOG_CAP = 256 * 1024;
const SETTLE_MS  = 45_000;  // grace before acting on a "not connected" reading
const CONNECT_MS = 90_000;  // how long a heal step gets to reach Connected

// ─── logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > LOG_CAP) {
      const keep = readFileSync(LOG, "utf8").slice(-LOG_CAP / 2);
      writeFileSync(LOG, keep.slice(keep.indexOf("\n") + 1));
    }
    writeFileSync(LOG, line, { flag: "a" });
  } catch { /* still has a job to do */ }
  if (process.stdout.isTTY) console.log(`[tunnel] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── the tunnel ──────────────────────────────────────────────────────────────

/**
 * The service's command line from the Run value, or null when no tunnel service
 * is installed. Parsed into exe + args so we can launch it exactly as Windows
 * would at logon.
 */
function serviceCommand() {
  const r = spawnSync(REG, ["query", RUN_KEY, "/v", RUN_VALUE], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const m = (r.stdout ?? "").match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  if (!m) return null;
  const line = m[1];
  // `"C:\...\code-tunnel.exe" --verbose ... --log-to-file C:\...\x.log` —
  // quoted exe, then whitespace-split args (with "quoted" args honoured).
  const tokens = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((t) => t[1] ?? t[2]);
  const [exe, ...args] = tokens;
  if (!exe || !existsSync(exe)) return { line, exe: null, args };
  return { line, exe, args };
}

/** `code-tunnel tunnel status` parsed, or { error } if the CLI itself misbehaves. */
function tunnelStatus(exe) {
  const r = spawnSync(exe, ["tunnel", "status"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const out = (r.stdout ?? "").trim();
  try {
    const j = JSON.parse(out.slice(out.indexOf("{")));
    return { tunnel: j.tunnel ?? null, serviceInstalled: !!j.service_installed };
  } catch {
    return { error: `status unreadable (exit ${r.status}): ${(out + (r.stderr ?? "")).slice(0, 200)}` };
  }
}

const connected = (s) => s?.tunnel?.tunnel === "Connected";

/** pids of the background service process (`tunnel service internal-run`). */
function servicePids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='code-tunnel.exe'\" | " +
             "Where-Object { $_.CommandLine -match 'service internal-run' } | " +
             "ForEach-Object { $_.ProcessId }";
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return (r.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
}

function launchService(cmd) {
  const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  log(`heal: launched service (pid ${child.pid})`);
}

async function waitConnected(exe, ms = CONNECT_MS) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(5_000);
    const s = tunnelStatus(exe);
    if (connected(s)) return s;
  }
  return tunnelStatus(exe);
}

function describe(s) {
  if (s.error) return s.error;
  if (!s.tunnel) return "no tunnel running";
  const t = s.tunnel;
  return `${t.name ?? "?"}: ${t.tunnel}` + (t.last_fail_reason ? ` (last fail: ${t.last_fail_reason})` : "");
}

const looksLikeAuth = (s) => /auth|token|login|unauthor|401|403/i.test(s?.tunnel?.last_fail_reason ?? "");

// ─── one heartbeat ───────────────────────────────────────────────────────────

async function run() {
  const cmd = serviceCommand();
  if (!cmd) { log("tick: no tunnel service installed — nothing to guard"); return 0; }
  if (!cmd.exe) { log(`tick: Run value points at a missing exe — VS Code moved/uninstalled? (${cmd.line})`); return 1; }
  const exe = cmd.exe;

  let s = tunnelStatus(exe);
  if (connected(s)) { log(`tick: ok — ${describe(s)}`); return 0; }

  log(`tick: not connected — ${describe(s)}; rechecking in ${SETTLE_MS / 1000}s`);
  await sleep(SETTLE_MS);
  s = tunnelStatus(exe);
  if (connected(s)) { log(`tick: recovered on its own — ${describe(s)}`); return 0; }

  // Rung 1: the service process is gone (crashed, killed, never started at logon).
  if (servicePids().length === 0) {
    launchService(cmd);
    s = await waitConnected(exe);
    if (connected(s)) { log(`heal: ok after relaunch — ${describe(s)}`); return 0; }
  }

  // Rung 2: the process is there but wedged — ask the CLI to restart it.
  log(`heal: still down (${describe(s)}) — code tunnel restart`);
  spawnSync(exe, ["tunnel", "restart"], { windowsHide: true, timeout: 60_000 });
  s = await waitConnected(exe);
  if (connected(s)) { log(`heal: ok after restart — ${describe(s)}`); return 0; }

  // Rung 3: hard reset — kill every tunnel, relaunch the service clean.
  log(`heal: still down (${describe(s)}) — kill + relaunch`);
  spawnSync(exe, ["tunnel", "kill"], { windowsHide: true, timeout: 60_000 });
  await sleep(3_000);
  launchService(cmd);
  s = await waitConnected(exe);
  if (connected(s)) { log(`heal: ok after kill + relaunch — ${describe(s)}`); return 0; }

  log(`FAILED: tunnel still down after every rung — ${describe(s)}` +
      (looksLikeAuth(s) ? " — looks like auth: run `code tunnel user login`, then `code tunnel restart`" : "") +
      `. Next try in ${INTERVAL.slice(2)}.`);
  return 1;
}

// ─── the shim + the task (same scheme as widgets/autostart.mjs) ──────────────

function writeShim() {
  const cmdline = `"${process.execPath}" "${SELF}" run`;
  const literal = `"${cmdline.replace(/"/g, '""')}"`;
  const vbs = [
    "' GENERATED by tunnel/watchdog.mjs - do not edit.",
    "' Runs one VS Code tunnel heartbeat with no console window.",
    "' Re-run `claudbot tunnel watchdog install` after moving the checkout.",
    `CreateObject("WScript.Shell").Run ${literal}, 0, False`,
    "",
  ].join("\r\n");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(SHIM, vbs, "ascii");
}

function taskAction() {
  if (existsSync(WSCRIPT)) {
    writeShim();
    return { command: WSCRIPT, args: `"${SHIM}"`, how: "wscript.exe + watchdog.vbs" };
  }
  if (existsSync(CONHOST)) {
    return { command: CONHOST, args: `--headless "${process.execPath}" "${SELF}" run`, how: "conhost.exe --headless" };
  }
  return null;
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function writeTaskXml(action, withResume) {
  const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  // Waking from sleep is the single most common way a tunnel ends up stale, so
  // also beat on resume (Power-Troubleshooter event 1) instead of waiting up to
  // 30 minutes. Optional: if this machine refuses an event trigger for a
  // non-elevated task, install retries without it.
  const resume = withResume ? `
    <EventTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="System"&gt;&lt;Select Path="System"&gt;*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Claudbot</Author>
    <Description>Heartbeat for the VS Code Remote Tunnel: every 30 min (and at logon / wake) checks the tunnel is Connected and restarts it if not. No-op when no tunnel service is installed. Generated by tunnel/watchdog.mjs.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>${INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>${resume}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(action.command)}</Command>
      <Arguments>${xmlEscape(action.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(TASK_XML, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
}

const schtasks = (...args) => spawnSync(SCHTASKS, args, { encoding: "utf8", windowsHide: true });
const taskRegistered = () => schtasks("/Query", "/TN", TASK_NAME).status === 0;

// ─── commands ────────────────────────────────────────────────────────────────

async function install() {
  const action = taskAction();
  if (!action) { console.error("[tunnel] no windowless launcher (wscript/conhost) — aborting"); process.exit(1); }

  let resume = true;
  writeTaskXml(action, resume);
  let r = schtasks("/Create", "/TN", TASK_NAME, "/XML", TASK_XML, "/F");
  if (r.status !== 0) {
    resume = false;
    writeTaskXml(action, resume);
    r = schtasks("/Create", "/TN", TASK_NAME, "/XML", TASK_XML, "/F");
  }
  if (r.status !== 0) {
    console.error(`[tunnel] registering the task failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
    process.exit(1);
  }
  console.log(`[tunnel] registered ${TASK_NAME}`);
  console.log(`[tunnel] triggers: every 30 min, at logon${resume ? ", on wake from sleep" : " (wake trigger refused here)"}`);
  console.log(`[tunnel] launcher: ${action.how}`);
  console.log(`[tunnel] log:      ${LOG}`);
  log(`installed: ${TASK_NAME} via ${action.how}${resume ? " + resume trigger" : ""}`);

  const cmd = serviceCommand();
  console.log(cmd
    ? "[tunnel] tunnel service is installed — the heartbeat is armed. First pass:"
    : "[tunnel] no tunnel service installed yet — the heartbeat will arm itself as soon as one is (`code tunnel service install`).");
  if (cmd) await run();
}

function uninstall() {
  if (taskRegistered()) {
    const r = schtasks("/Delete", "/TN", TASK_NAME, "/F");
    if (r.status !== 0) { console.error(`[tunnel] removing the task failed:\n${r.stdout}${r.stderr}`); process.exit(1); }
    console.log(`[tunnel] removed ${TASK_NAME}`);
  } else console.log(`[tunnel] no ${TASK_NAME} registered`);
  for (const f of [SHIM, TASK_XML]) if (existsSync(f)) { try { unlinkSync(f); } catch { /* leave */ } }
  console.log("[tunnel] the tunnel itself keeps running — `code tunnel service uninstall` turns it off.");
  log("uninstalled");
}

function status() {
  const cmd = serviceCommand();
  const s = cmd?.exe ? tunnelStatus(cmd.exe) : null;
  console.log("");
  console.log(`  service    ${cmd ? "installed (logon Run key)" : "not installed — heartbeat idle"}`);
  if (s) {
    console.log(`  tunnel     ${describe(s)}`);
    if (s.tunnel?.name) console.log(`  link       https://vscode.dev/tunnel/${s.tunnel.name}`);
  }
  const registered = taskRegistered();
  console.log(`  heartbeat  ${registered ? `registered  ${TASK_NAME}` : "not registered — claudbot tunnel watchdog install"}`);
  if (registered) {
    const q = schtasks("/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V");
    const field = (n) => (q.stdout ?? "").match(new RegExp(`^\\s*${n}:\\s*(.+?)\\s*$`, "mi"))?.[1] ?? "?";
    console.log(`  last run   ${field("Last Run Time")}  ·  next ${field("Next Run Time")}`);
  }
  if (existsSync(LOG)) {
    console.log(`\n  ${LOG}`);
    for (const l of readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-5)) console.log(`    ${l}`);
  }
  console.log("");
}

// ─── entry ───────────────────────────────────────────────────────────────────

if (process.platform !== "win32") {
  console.error("[tunnel] Windows only — the tunnel service and Task Scheduler wiring are Windows-specific.");
  process.exit(1);
}

const verb = process.argv[2] ?? "status";
switch (verb) {
  case "install":   await install(); break;
  case "uninstall": uninstall(); break;
  case "status":    status(); break;
  case "run":       process.exitCode = await run(); break;
  default:
    console.error(`[tunnel] Unknown verb "${verb}". Use: install | uninstall | status | run`);
    process.exit(1);
}
