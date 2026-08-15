#!/usr/bin/env node
/**
 * widgets/autostart.mjs — make the desktop widgets survive a reboot.
 *
 * Two separate things have to be alive for the widgets to be "there":
 *
 *   Rainmeter.exe          draws them. Without it the desktop is bare.
 *   widgets/bridge.mjs     feeds them. Without it the skins render, but every
 *                          header says "bridge not running" and the numbers are
 *                          whatever they were when the feed last stopped.
 *
 * Neither survives a reboot on its own, so this registers ONE Scheduled Task
 * that runs the supervisor below at logon (and every 15 minutes after), which
 * starts whichever of the two isn't already up. It's a supervisor rather than
 * two "launch this exe" entries so that a crashed bridge or a Rainmeter the
 * user accidentally exited comes back by itself.
 *
 *   node widgets/autostart.mjs install     register the logon task
 *   node widgets/autostart.mjs uninstall   remove it
 *   node widgets/autostart.mjs status      what's registered and what's running
 *   node widgets/autostart.mjs run         one supervisor pass (what the task runs)
 *
 * ── Why a VBScript shim sits between the task and Node ──────────────────────
 *
 * A Scheduled Task action that runs node.exe directly puts a console window on
 * the user's desktop at every logon — measured on Windows 11 26200, and the
 * task's `Hidden` setting does not change it (that flag hides the task in the
 * Task Scheduler UI, not the window). Routing through
 * `powershell -WindowStyle Hidden` is no better: the PowerShell window itself
 * flashes.
 *
 * Two things do work, both verified here: `wscript.exe` running a one-line
 * .vbs, and `conhost.exe --headless`. wscript is the primary because it is
 * documented and ancient, so it behaves the same on every Windows this could
 * land on; conhost's `--headless` is undocumented. The fallback exists because
 * VBScript is on Microsoft's deprecation path — it is a Feature on Demand as of
 * Windows 11 24H2, still installed by default, so a future machine may not have
 * wscript.exe at all.
 *
 * Desktop-only, like widgets/install.mjs. Rainmeter is a host-installed
 * application and Task Scheduler is a Windows service; neither travels on the
 * portable drive. Every path still resolves through portable/paths.mjs.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, openSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { appDir } from "../portable/paths.mjs";
import { livePid } from "./pidfile.mjs";

const ROOT       = appDir();
const OUT_DIR    = path.join(ROOT, ".claudbot", "widgets");
const BRIDGE     = path.join(ROOT, "widgets", "bridge.mjs");
const SELF       = path.join(ROOT, "widgets", "autostart.mjs");
const SKINS_SRC  = path.join(ROOT, "widgets", "skins", "Claudbot");

const PIDFILE    = path.join(OUT_DIR, "bridge.pid");
const SHIM       = path.join(OUT_DIR, "autostart.vbs");
const TASK_XML   = path.join(OUT_DIR, "autostart.xml");
const LOG        = path.join(OUT_DIR, "autostart.log");
const BRIDGE_LOG = path.join(OUT_DIR, "bridge.log");

// Task Scheduler's root folder rejects a non-elevated create ("Access is
// denied"), but a subfolder accepts one, so everything lives under \Claudbot\.
const TASK_NAME = "\\Claudbot\\Widgets";

const SYS32    = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const WSCRIPT  = path.join(SYS32, "wscript.exe");
const CONHOST  = path.join(SYS32, "conhost.exe");
const SCHTASKS = path.join(SYS32, "schtasks.exe");
const TASKLIST = path.join(SYS32, "tasklist.exe");

const LOG_CAP = 256 * 1024; // trim the log in half past this; it's a breadcrumb trail, not an archive

// ─── logging ─────────────────────────────────────────────────────────────────

/**
 * The supervisor runs with no console attached — that's the entire point of the
 * shim — so anything it has to say has to go to a file or it goes nowhere.
 * "The widgets didn't come back after a reboot" is the failure this feature
 * exists to prevent, and it's unfixable without a record of what happened.
 */
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > LOG_CAP) {
      const keep = readFileSync(LOG, "utf8").slice(-LOG_CAP / 2);
      writeFileSync(LOG, keep.slice(keep.indexOf("\n") + 1));
    }
    writeFileSync(LOG, line, { flag: "a" });
  } catch { /* a supervisor that can't log still has a job to do */ }
}

// Console output is for the human running install/uninstall/status by hand;
// the log is for the unattended `run`. Both, when both make sense.
const say = (msg) => { console.log(`[autostart] ${msg}`); };

// ─── process inspection ──────────────────────────────────────────────────────

function tasklist(...filters) {
  const args = ["/NH", "/FO", "CSV"];
  for (const f of filters) args.push("/FI", f);
  const r = spawnSync(TASKLIST, args, { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

function rainmeterRunning() {
  return /^"Rainmeter\.exe"/mi.test(tasklist('IMAGENAME eq Rainmeter.exe'));
}

/** The running bridge's pid, or 0. Shares its pid-file rules with the bridge itself. */
const bridgeRunning = () => livePid(PIDFILE);

// ─── Rainmeter ───────────────────────────────────────────────────────────────

/**
 * Rainmeter.exe's location. RAINMETER_EXE wins, then the two install roots.
 * The installer is 64-bit by default but offers a 32-bit build, and a portable
 * Rainmeter can sit anywhere — hence the override.
 */
function rainmeterExe() {
  if (process.env.RAINMETER_EXE) return process.env.RAINMETER_EXE;
  const roots = [
    process.env.ProgramFiles ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
  for (const r of roots) {
    const exe = path.join(r, "Rainmeter", "Rainmeter.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** The skins folder Rainmeter is actually configured to read. */
function skinsRoot() {
  if (process.env.RAINMETER_SKINS) return process.env.RAINMETER_SKINS;
  const ini = path.join(process.env.APPDATA ?? "", "Rainmeter", "Rainmeter.ini");
  if (!existsSync(ini)) return null;
  try {
    // Rainmeter writes Rainmeter.ini as UTF-16LE.
    const m = readFileSync(ini, "utf16le").match(/^\s*SkinPath\s*=\s*(.+?)\s*$/mi);
    if (m?.[1]) return m[1].replace(/[\\/]+$/, "");
  } catch { /* fall through */ }
  return null;
}

/**
 * Which Claudbot skins Rainmeter will load on its own.
 *
 * Rainmeter remembers Active=1 per skin in Rainmeter.ini and restores them at
 * launch, so the supervisor only ever has to start the process — it must not
 * force skins back on, or closing one would be impossible.
 */
function activeSkins() {
  const ini = path.join(process.env.APPDATA ?? "", "Rainmeter", "Rainmeter.ini");
  if (!existsSync(ini)) return [];
  let text = "";
  try { text = readFileSync(ini, "utf16le"); } catch { return []; }
  const active = [];
  for (const m of text.matchAll(/^\[Claudbot\\([^\]]+)\]([\s\S]*?)(?=^\[|\z)/gmi)) {
    if (/^\s*Active\s*=\s*1\s*$/mi.test(m[2])) active.push(m[1]);
  }
  return active;
}

// ─── the supervisor ──────────────────────────────────────────────────────────

function startRainmeter() {
  const exe = rainmeterExe();
  if (!exe) { log("rainmeter: not installed — nothing to start"); return false; }
  // Detached so it outlives this short-lived supervisor process, and hidden
  // because Rainmeter briefly owns a console when launched from one.
  const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  log(`rainmeter: started (${exe})`);
  return true;
}

function startBridge() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Hand the child a real file descriptor rather than "ignore": the bridge
  // reports its Finnhub/Notion configuration and every fetch failure on stdout,
  // and that is the first thing worth reading when the widgets go stale.
  if (existsSync(BRIDGE_LOG) && statSync(BRIDGE_LOG).size > LOG_CAP) {
    try {
      const keep = readFileSync(BRIDGE_LOG, "utf8").slice(-LOG_CAP / 2);
      writeFileSync(BRIDGE_LOG, keep.slice(keep.indexOf("\n") + 1));
    } catch { /* keep going; a big log is better than no bridge */ }
  }
  const fd = openSync(BRIDGE_LOG, "a");

  const child = spawn(process.execPath, [BRIDGE, "--watch"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  log(`bridge: started (pid ${child.pid})`);
  return true;
}

/** One pass: start whatever isn't up. Idempotent by design — it runs every 15 minutes. */
function run() {
  const started = [];

  if (rainmeterRunning()) {
    log("rainmeter: already running");
  } else if (startRainmeter()) {
    started.push("rainmeter");
  }

  const pid = bridgeRunning();
  if (pid) {
    log(`bridge: already running (pid ${pid})`);
  } else if (startBridge()) {
    started.push("bridge");
  }

  log(started.length ? `tick: started ${started.join(" + ")}` : "tick: nothing to do");
}

// ─── the shim + the task ─────────────────────────────────────────────────────

/**
 * A one-line .vbs that launches the supervisor with window style 0.
 *
 * WScript.Shell.Run's second argument is the window style and the third is
 * "wait for it to finish" — 0 and False mean "start it invisibly and don't
 * block". VBScript escapes a quote inside a string literal by doubling it.
 */
function writeShim() {
  const cmdline = `"${process.execPath}" "${SELF}" run`;
  const literal = `"${cmdline.replace(/"/g, '""')}"`;
  const vbs = [
    "' GENERATED by widgets/autostart.mjs — do not edit.",
    "' Launches the Claudbot widget supervisor with no console window.",
    "' Re-run `claudbot widgets autostart install` after moving the checkout.",
    `CreateObject("WScript.Shell").Run ${literal}, 0, False`,
    "",
  ].join("\r\n");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(SHIM, vbs, "ascii");
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The task action: wscript + the shim, or conhost --headless if this machine no
 * longer ships the scripting host. Both were measured to leave no window.
 */
function taskAction() {
  if (existsSync(WSCRIPT)) {
    writeShim();
    return { command: WSCRIPT, args: `"${SHIM}"`, how: "wscript.exe + autostart.vbs" };
  }
  if (existsSync(CONHOST)) {
    return {
      command: CONHOST,
      args: `--headless "${process.execPath}" "${SELF}" run`,
      how: "conhost.exe --headless (wscript.exe not present)",
    };
  }
  return null;
}

/**
 * Registered from XML rather than `schtasks /Create /SC ONLOGON` because the
 * repetition interval and the logon delay have no command-line equivalent.
 * schtasks requires the XML file in UTF-16.
 */
function writeTaskXml(action) {
  const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Claudbot</Author>
    <Description>Starts Rainmeter and the Claudbot widget data feed at logon, and restarts either one if it stops. Generated by widgets/autostart.mjs.</Description>
  </RegistrationInfo>
  <Triggers>
    <!-- The one that matters: bring the widgets back after a reboot. The delay
         lets the desktop finish coming up first — Rainmeter draws onto the
         shell, and starting it while explorer is still settling is asking for a
         skin to land in the wrong place. -->
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
    <!-- The keep-alive, as a separate trigger rather than a Repetition on the
         logon one. Repetition only starts counting once its trigger fires, so
         hanging it off the logon trigger would leave the session in which the
         task was installed with no keep-alive at all — "next run: N/A" until
         the next reboot. A time trigger with a start boundary in the past is
         armed the moment it's registered. -->
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT15M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
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
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
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

function schtasks(...args) {
  return spawnSync(SCHTASKS, args, { encoding: "utf8", windowsHide: true });
}

function taskRegistered() {
  return schtasks("/Query", "/TN", TASK_NAME).status === 0;
}

// ─── commands ────────────────────────────────────────────────────────────────

function install() {
  const action = taskAction();
  if (!action) {
    console.error("[autostart] Neither wscript.exe nor conhost.exe is present — no way to start");
    console.error("[autostart] the feed without putting a console window on your desktop. Aborting.");
    process.exit(1);
  }

  writeTaskXml(action);
  const r = schtasks("/Create", "/TN", TASK_NAME, "/XML", TASK_XML, "/F");
  if (r.status !== 0) {
    console.error(`[autostart] registering the task failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
    process.exit(1);
  }

  say(`registered scheduled task ${TASK_NAME}`);
  say(`launcher:  ${action.how}`);
  say("trigger:   at logon (30s delay), then every 15 min as a keep-alive");
  say(`log:       ${LOG}`);
  log(`installed: task ${TASK_NAME} via ${action.how}`);

  // Report the two things that make the task useless if they're missing,
  // rather than letting the user discover it after the next reboot.
  console.log("");
  const exe = rainmeterExe();
  if (exe) say(`rainmeter: ${exe}`);
  else say("rainmeter: NOT INSTALLED — winget install --id Rainmeter.Rainmeter -e");

  const root = skinsRoot();
  const installed = root && existsSync(path.join(root, "Claudbot"));
  if (installed) {
    const active = activeSkins();
    say(active.length
      ? `skins:     ${active.join(", ")} will load with Rainmeter`
      : "skins:     installed, but none are active — load them from the Rainmeter tray icon");
  } else if (existsSync(SKINS_SRC)) {
    say("skins:     NOT INSTALLED — run: claudbot widgets install");
  }

  // Do the first pass now so the widgets appear without waiting for a reboot.
  console.log("");
  say("starting them now…");
  run();
  const up = [rainmeterRunning() ? "rainmeter" : null, bridgeRunning() ? "bridge" : null].filter(Boolean);
  say(up.length === 2 ? "both running." : `running: ${up.join(", ") || "nothing yet — check the log"}`);
}

function uninstall() {
  if (taskRegistered()) {
    const r = schtasks("/Delete", "/TN", TASK_NAME, "/F");
    if (r.status !== 0) {
      console.error(`[autostart] removing the task failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
      process.exit(1);
    }
    say(`removed scheduled task ${TASK_NAME}`);
  } else {
    say(`no scheduled task ${TASK_NAME} registered`);
  }

  for (const f of [SHIM, TASK_XML]) {
    if (existsSync(f)) { try { unlinkSync(f); } catch { /* leave it */ } }
  }
  // Task Scheduler leaves the folder behind; drop it if we emptied it.
  const empty = schtasks("/Query", "/TN", "\\Claudbot\\", "/FO", "LIST");
  if (empty.status !== 0) spawnSync(SCHTASKS, ["/Delete", "/TN", "\\Claudbot", "/F"], { windowsHide: true });

  say("Rainmeter and the feed keep running until you stop them or reboot.");
  log("uninstalled");
}

function status() {
  const registered = taskRegistered();
  console.log("");
  console.log(`  task       ${registered ? `registered  ${TASK_NAME}` : "not registered — claudbot widgets autostart"}`);

  if (registered) {
    const q = schtasks("/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V");
    const field = (name) => (q.stdout ?? "").match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "mi"))?.[1] ?? "?";
    // schtasks reports "30-Nov-99" for never-run and raw HRESULTs for the
    // result, neither of which means anything at a glance.
    const never  = (v) => (/^30-Nov-99|^N\/A$/i.test(v) ? "never" : v);
    const result = (v) => ({
      "0": "ok", "267011": "not yet run", "267009": "running", "267014": "stopped by user",
    }[v] ?? v);
    console.log(`  state      ${field("Scheduled Task State")}  ·  last run ${never(field("Last Run Time"))}  ·  last result ${result(field("Last Result"))}`);
    console.log(`  next run   ${never(field("Next Run Time"))}`);
  }

  const exe = rainmeterExe();
  console.log(`  rainmeter  ${!exe ? "not installed" : rainmeterRunning() ? "running" : "installed, not running"}`);

  const root = skinsRoot();
  const active = activeSkins();
  console.log(`  skins      ${root && existsSync(path.join(root, "Claudbot"))
    ? (active.length ? `${active.join(", ")}` : "installed, none active")
    : "not installed — claudbot widgets install"}`);

  const pid = bridgeRunning();
  console.log(`  bridge     ${pid ? `running (pid ${pid})` : "not running"}`);

  // The freshest widget file is the honest answer to "is the feed actually
  // working", independent of whether some process is holding the pid.
  const statusTxt = path.join(OUT_DIR, "status.txt");
  if (existsSync(statusTxt)) {
    const age = Math.round((Date.now() - statSync(statusTxt).mtimeMs) / 1000);
    console.log(`  last write ${age < 90 ? `${age}s ago` : `${Math.round(age / 60)} min ago  ← stale`}`);
  }

  if (existsSync(LOG)) {
    const lines = readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-4);
    console.log(`\n  ${LOG}`);
    for (const l of lines) console.log(`    ${l}`);
  }
  console.log("");
}

// ─── entry ───────────────────────────────────────────────────────────────────

if (process.platform !== "win32") {
  console.error("[autostart] Windows only — Rainmeter and Task Scheduler are both Windows-specific.");
  process.exit(1);
}

const verb = process.argv[2] ?? "install";
switch (verb) {
  case "install":   install();   break;
  case "uninstall": uninstall(); break;
  case "status":    status();    break;
  case "run":       run();       break;
  default:
    console.error(`[autostart] Unknown verb "${verb}". Use: install | uninstall | status | run`);
    process.exit(1);
}
