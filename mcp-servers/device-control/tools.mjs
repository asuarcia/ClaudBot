/**
 * device-control MCP — tool implementations.
 *
 * Every function is defensive by design: a missing binary, an unplugged phone or
 * a locked-down iOS device produces a readable explanation, never an unhandled
 * rejection. Claude reads the message and adapts.
 *
 * Destructive verbs are refused in `assertAllowed` below. That check lives here,
 * inside the server, so it holds even if the deny rules in
 * .claudbot/restrictions.yaml are edited or dropped.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── process helpers ─────────────────────────────────────────────────────────

const MAX_OUTPUT = 40_000;

/**
 * Run a binary and always resolve. `encoding: "buffer"` returns raw bytes
 * (needed for screencap PNGs). `killAfterMs` stops long-running streamers like
 * idevicesyslog and keeps whatever they printed.
 */
export function run(bin, args, opts = {}) {
  const {
    timeout = 30_000,
    cwd,
    encoding = "utf8",
    maxBuffer = 16 * 1024 * 1024,
    killAfterMs = 0,
  } = opts;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      return reject(new Error(`could not start ${bin}: ${err.message}`));
    }

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopper);
      resolve(result);
    };

    const collect = () => {
      const stdoutBuf = Buffer.concat(outChunks);
      const stderrBuf = Buffer.concat(errChunks);
      return encoding === "buffer"
        ? { stdout: stdoutBuf, stderr: stderrBuf.toString("utf8") }
        : { stdout: stdoutBuf.toString("utf8"), stderr: stderrBuf.toString("utf8") };
    };

    child.stdout?.on("data", (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) outChunks.push(d);
    });
    child.stderr?.on("data", (d) => errChunks.push(d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopper);
      reject(
        err.code === "ENOENT"
          ? new Error(`ENOENT: ${bin} is not installed or not on PATH`)
          : err,
      );
    });

    child.on("close", (code) => finish({ code, ...collect() }));

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ code: null, timedOut: true, ...collect() });
    }, timeout);

    // Deliberate stop for streaming tools: not an error, just "that's enough".
    const stopper = killAfterMs
      ? setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, killAfterMs)
      : 0;
  });
}

export function adbBin() {
  return process.env.ADB_PATH?.trim() || "adb";
}

export function ideviceBin(name) {
  const dir = process.env.IDEVICE_PATH?.trim();
  return dir ? path.join(dir, name) : name;
}

export function ok(text) {
  return { content: [{ type: "text", text: String(text ?? "").trim() || "(no output)" }] };
}

export function fail(text) {
  throw new Error(text);
}

function truncate(text) {
  const s = String(text ?? "");
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} of ${s.length} characters]`
    : s;
}

function missing(tool, hints) {
  return ok(
    `${tool} is not installed or not on PATH.\n\n${hints}\n\n` +
      `If it is installed somewhere unusual, set ADB_PATH or IDEVICE_PATH in .env.`,
  );
}

const ADB_HINT =
  "Install Android SDK Platform Tools:\n" +
  "  Windows: winget install Google.PlatformTools\n" +
  "  macOS:   brew install android-platform-tools\n" +
  "  Linux:   sudo apt install android-tools-adb";

const IDEVICE_HINT =
  "Install libimobiledevice:\n" +
  "  macOS:   brew install libimobiledevice\n" +
  "  Linux:   sudo apt install libimobiledevice-utils\n" +
  "  Windows: https://github.com/libimobiledevice-win32/imobiledevice-net/releases";

const isMissingBinary = (err) => /ENOENT/.test(err?.message ?? "");

// ─── safety ──────────────────────────────────────────────────────────────────

// Anything here wipes a phone, bricks a bootloader, or silently destroys user
// data. The user confirms these by running them personally — the agent does not.
const BLOCKED = [
  { re: /\bMASTER_CLEAR\b/i, why: "factory reset" },
  { re: /\bfactory\s*reset\b/i, why: "factory reset" },
  { re: /\brecovery\s*--wipe/i, why: "recovery wipe" },
  { re: /--wipe_data\b/i, why: "data wipe" },
  { re: /\bwipe\s+(data|cache|all)\b/i, why: "wipe" },
  { re: /\bpm\s+clear\b/i, why: "clearing all data for an app" },
  { re: /\bfastboot\b/i, why: "fastboot / bootloader flashing" },
  { re: /\bflash(all|_all)?\b/i, why: "flashing" },
  { re: /\boem\s+unlock\b/i, why: "bootloader unlock" },
  { re: /\bflashing\s+unlock\b/i, why: "bootloader unlock" },
  { re: /\breboot\s+(bootloader|recovery|fastboot|edl|download)\b/i, why: "reboot into a flashing mode" },
  { re: /\bdisable-verity\b/i, why: "disabling verified boot" },
  { re: /\brm\s+-rf\s+\/(sdcard|data|system)\b/i, why: "recursive delete of device storage" },
  { re: /\bmke2fs\b|\bmkfs\b|\bdd\s+if=/i, why: "formatting device storage" },
  { re: /\bsu\s+-c\b|^su$/i, why: "root shell" },
  { re: /\bidevicerestore\b/i, why: "iOS restore" },
];

export function assertAllowed(kind, value) {
  const text = String(value ?? "");
  for (const { re, why } of BLOCKED) {
    if (re.test(text)) {
      fail(
        `Refused: this ${kind} looks like ${why}, which is irreversible. ` +
          `Run it yourself if you really mean to — I will not do it for you.`,
      );
    }
  }
}

// ─── argument helpers ────────────────────────────────────────────────────────

const SAFE_SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
// adb input text only reliably handles printable ASCII; anything else needs a
// different mechanism (clipboard or an IME) and silently mangles otherwise.
const SAFE_TEXT = /^[\x20-\x7E]+$/;

function target(serial, ...rest) {
  if (serial === undefined || serial === null || serial === "") return rest;
  if (!SAFE_SERIAL.test(String(serial))) fail(`Invalid device serial: ${serial}`);
  return ["-s", String(serial), ...rest];
}

function wholeNumber(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer (got ${value})`);
  return n;
}

async function adb(args, opts = {}) {
  try {
    return await run(adbBin(), args, opts);
  } catch (err) {
    if (isMissingBinary(err)) {
      const e = new Error("ADB_MISSING");
      e.adbMissing = true;
      throw e;
    }
    throw err;
  }
}

function combine({ stdout, stderr, timedOut }) {
  let out = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  if (stderr?.trim()) out += `\n[stderr]\n${stderr.trim()}`;
  if (timedOut) out += `\n[timed out]`;
  return truncate(out.trim());
}

// ─── 1. list devices ─────────────────────────────────────────────────────────

export async function listDevices(args = {}) {
  const out = ["Android (adb)", "-".repeat(40)];

  try {
    const { stdout } = await adb(["devices", "-l"], { timeout: 15_000 });
    const rows = String(stdout).split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    if (rows.length === 0) {
      out.push("  no devices — check the cable and that USB debugging is on");
    } else {
      for (const row of rows) {
        const [serial, state = "?"] = row.split(/\s+/);
        const model = row.match(/model:(\S+)/)?.[1] ?? "";
        const device = row.match(/device:(\S+)/)?.[1] ?? "";
        out.push(`  ${serial.padEnd(24)} ${state.padEnd(14)} ${model} ${device}`.trimEnd());
        if (state === "unauthorized") {
          out.push("    -> unlock the phone and accept the USB debugging prompt");
        }
      }
    }
  } catch (err) {
    out.push(err.adbMissing ? `  adb not installed.\n${ADB_HINT}` : `  adb error: ${err.message}`);
  }

  if (args.includeIos !== false) {
    out.push("", "iOS (libimobiledevice)", "-".repeat(40));
    try {
      const { stdout } = await run(ideviceBin("idevice_id"), ["-l"], { timeout: 15_000 });
      const udids = String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
      if (udids.length === 0) {
        out.push("  no devices — connect and tap Trust on the phone");
      }
      for (const udid of udids) {
        const key = async (k) => {
          try {
            const { stdout: v } = await run(
              ideviceBin("ideviceinfo"), ["-u", udid, "-k", k], { timeout: 10_000 },
            );
            return String(v).trim();
          } catch {
            return "?";
          }
        };
        const [name, version] = await Promise.all([key("DeviceName"), key("ProductVersion")]);
        out.push(`  ${udid}  ${name}  iOS ${version}`);
      }
    } catch (err) {
      out.push(isMissingBinary(err)
        ? `  libimobiledevice not installed.\n${IDEVICE_HINT}`
        : `  error: ${err.message}`);
    }
  }

  return ok(out.join("\n"));
}

// ─── 2. adb shell ────────────────────────────────────────────────────────────

export async function adbShell(args = {}) {
  const { serial, command } = args;
  if (typeof command !== "string" || !command.trim()) fail("command is required");
  assertAllowed("adb_shell command", command);

  const timeout = Math.min(Math.max(Number(args.timeout) || 30_000, 1_000), 300_000);
  try {
    return ok(combine(await adb(target(serial, "shell", command), { timeout })));
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

// ─── 3. screenshot ───────────────────────────────────────────────────────────

export async function adbScreencap(args = {}) {
  const { serial } = args;
  const dest = args.outPath
    ? path.resolve(args.outPath)
    : path.join(os.tmpdir(), `claudbot-screencap-${Date.now()}.png`);

  let result;
  try {
    // exec-out keeps the stream binary-clean; `adb shell screencap` corrupts PNGs
    // on Windows by translating CRLF.
    result = await adb(target(serial, "exec-out", "screencap", "-p"), {
      encoding: "buffer",
      timeout: 30_000,
    });
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }

  const png = result.stdout;
  if (!png || png.length === 0) {
    fail(`screencap returned no data. ${result.stderr?.trim() || "Is the device unlocked?"}`);
  }
  if (!(png[0] === 0x89 && png[1] === 0x50)) {
    fail("screencap output is not a PNG — the device may be locked or unauthorized.");
  }

  writeFileSync(dest, png);
  return ok(
    `Screenshot saved: ${dest}\n${png.length} bytes\n\n` +
      `Read that path to actually see the screen.`,
  );
}

// ─── 4. input ────────────────────────────────────────────────────────────────

export async function adbInput(args = {}) {
  const { serial, action } = args;

  const send = async (rest, description) => {
    try {
      const r = await adb(target(serial, "shell", "input", ...rest), { timeout: 20_000 });
      const err = r.stderr?.trim();
      return ok(err ? `${description}\n[stderr] ${err}` : description);
    } catch (err) {
      if (err.adbMissing) return missing("adb", ADB_HINT);
      throw err;
    }
  };

  switch (action) {
    case "tap": {
      const x = wholeNumber(args.x, "x");
      const y = wholeNumber(args.y, "y");
      return send(["tap", String(x), String(y)], `Tapped (${x}, ${y})`);
    }
    case "swipe": {
      const x = wholeNumber(args.x, "x");
      const y = wholeNumber(args.y, "y");
      const x2 = wholeNumber(args.x2, "x2");
      const y2 = wholeNumber(args.y2, "y2");
      const rest = ["swipe", String(x), String(y), String(x2), String(y2)];
      if (args.durationMs !== undefined) {
        rest.push(String(wholeNumber(args.durationMs, "durationMs")));
      }
      return send(rest, `Swiped (${x}, ${y}) -> (${x2}, ${y2})`);
    }
    case "text": {
      const text = args.text;
      if (typeof text !== "string" || !text) fail("text is required for action=text");
      if (!SAFE_TEXT.test(text)) {
        fail(
          "text must be printable ASCII. `adb input text` mangles accents, emoji " +
            "and non-Latin scripts; use the clipboard or an IME for those.",
        );
      }
      // `input text` treats %s as a space and is passed as one argv element, so
      // no shell quoting is involved.
      return send(["text", text.replace(/ /g, "%s")], `Typed ${text.length} characters`);
    }
    case "keyevent": {
      const raw = String(args.keycode ?? "").trim();
      if (!/^(\d{1,4}|KEYCODE_[A-Z0-9_]{1,40})$/.test(raw)) {
        fail("keycode must be a number or a KEYCODE_* name, e.g. KEYCODE_HOME");
      }
      return send(["keyevent", raw], `Sent ${raw}`);
    }
    default:
      return fail(`Unknown action "${action}". Use: tap, swipe, text, keyevent.`);
  }
}

// ─── 5. logcat ───────────────────────────────────────────────────────────────

export async function adbLogcat(args = {}) {
  const { serial, filter, clear } = args;
  const lines = Math.min(Math.max(Number(args.lines) || 200, 1), 2000);

  try {
    if (clear) await adb(target(serial, "logcat", "-c"), { timeout: 15_000 });

    const cmd = target(serial, "logcat", "-d", "-t", String(lines));
    if (typeof filter === "string" && filter.trim()) {
      // A tag spec is several argv entries: "ActivityManager:E *:S".
      cmd.push(...filter.trim().split(/\s+/));
    }
    const result = await adb(cmd, { timeout: 30_000 });
    const text = combine(result);
    return ok(text || (clear ? "Buffer cleared; nothing logged yet." : "(logcat empty)"));
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

// ─── 6/7. install + uninstall ────────────────────────────────────────────────

export async function adbInstall(args = {}) {
  const { serial, apkPath, reinstall } = args;
  if (typeof apkPath !== "string" || !apkPath) fail("apkPath is required");
  assertAllowed("apk path", apkPath);

  const resolved = path.resolve(apkPath);
  if (!existsSync(resolved)) fail(`APK not found: ${resolved}`);
  if (!resolved.toLowerCase().endsWith(".apk")) fail("apkPath must point at a .apk file");

  const cmd = target(serial, "install");
  if (reinstall) cmd.push("-r");
  cmd.push(resolved);

  try {
    return ok(combine(await adb(cmd, { timeout: 300_000 })));
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

export async function adbUninstall(args = {}) {
  // `package` is a reserved word under ESM strict mode — read it off the object.
  const pkg = args.package;
  const { serial, keepData } = args;
  if (typeof pkg !== "string" || !PACKAGE_RE.test(pkg)) {
    fail(`Invalid package name: ${pkg}. Expected something like com.example.app`);
  }
  assertAllowed("uninstall target", pkg);

  const cmd = target(serial, "uninstall");
  if (keepData) cmd.push("-k");
  cmd.push(pkg);

  try {
    return ok(combine(await adb(cmd, { timeout: 120_000 })));
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

// ─── 8. push / pull ──────────────────────────────────────────────────────────

export async function adbPush(args = {}) {
  const { serial, localPath, remotePath } = args;
  if (!localPath || !remotePath) fail("localPath and remotePath are both required");
  const resolved = path.resolve(localPath);
  if (!existsSync(resolved)) fail(`Local file not found: ${resolved}`);
  assertAllowed("push destination", remotePath);

  try {
    const r = await adb(target(serial, "push", resolved, String(remotePath)), { timeout: 300_000 });
    return ok(combine(r) || `Pushed ${resolved} -> ${remotePath}`);
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

export async function adbPull(args = {}) {
  const { serial, localPath, remotePath } = args;
  if (!localPath || !remotePath) fail("remotePath and localPath are both required");
  const resolved = path.resolve(localPath);

  try {
    const r = await adb(target(serial, "pull", String(remotePath), resolved), { timeout: 300_000 });
    const text = combine(r);
    if (!existsSync(resolved)) fail(`Pull produced no file. ${text}`);
    return ok(`${text}\n\nSaved: ${resolved}`.trim());
  } catch (err) {
    if (err.adbMissing) return missing("adb", ADB_HINT);
    throw err;
  }
}

// ─── 9. iOS info ─────────────────────────────────────────────────────────────

const IOS_KEYS = [
  "DeviceName", "DeviceClass", "ProductType", "ProductVersion", "BuildVersion",
  "SerialNumber", "UniqueDeviceID", "WiFiAddress", "BatteryCurrentCapacity",
  "TotalDiskCapacity", "PasswordProtected",
];

export async function iosInfo(args = {}) {
  const cmd = args.udid ? ["-u", String(args.udid)] : [];
  let stdout;
  try {
    ({ stdout } = await run(ideviceBin("ideviceinfo"), cmd, { timeout: 20_000 }));
  } catch (err) {
    if (isMissingBinary(err)) return missing("libimobiledevice", IDEVICE_HINT);
    throw err;
  }

  const wanted = new Set(IOS_KEYS);
  const rows = [];
  for (const line of String(stdout).split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (wanted.has(key)) rows.push(`  ${key.padEnd(24)} ${line.slice(idx + 1).trim()}`);
  }

  if (rows.length === 0) {
    return ok(
      "No device info returned. The device may be locked, or you have not tapped " +
        "Trust on it yet. Unlock it, reconnect, and try list_devices.",
    );
  }

  return ok(
    `${rows.join("\n")}\n\n` +
      `Note: iOS is read-mostly here. Apple does not expose UI automation (taps, ` +
      `typing) to a desktop without a paid developer profile and a signed test ` +
      `runner, so there is no iOS equivalent of adb_input. Info, logs and backups ` +
      `are the ceiling.`,
  );
}

// ─── 10. iOS syslog ──────────────────────────────────────────────────────────

export async function iosSyslog(args = {}) {
  const seconds = Math.min(Math.max(Number(args.seconds) || 10, 1), 60);
  const cmd = args.udid ? ["-u", String(args.udid)] : [];

  let result;
  try {
    // idevicesyslog streams forever; stop it deliberately and keep the output.
    result = await run(ideviceBin("idevicesyslog"), cmd, {
      timeout: seconds * 1000 + 15_000,
      killAfterMs: seconds * 1000,
    });
  } catch (err) {
    if (isMissingBinary(err)) return missing("libimobiledevice", IDEVICE_HINT);
    throw err;
  }

  let lines = String(result.stdout).split("\n");
  if (typeof args.filter === "string" && args.filter.trim()) {
    const needle = args.filter.trim().toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }

  const text = lines.join("\n").trim();
  return ok(
    text
      ? truncate(`Captured ${seconds}s of syslog:\n\n${text}`)
      : `Captured ${seconds}s of syslog — nothing matched. ` +
        `${result.stderr?.trim() || "Is the device unlocked and trusted?"}`,
  );
}

// ─── 11. serial / USB ────────────────────────────────────────────────────────

function listDevNodes(prefixes) {
  let entries;
  try {
    entries = readdirSync("/dev");
  } catch {
    return [];
  }
  return entries
    .filter((name) => prefixes.some((p) => name.startsWith(p)))
    .sort()
    .map((name) => `/dev/${name}`);
}

export async function serialPorts() {
  if (process.platform === "win32") {
    const ps =
      "Get-CimInstance Win32_PnPEntity | " +
      "Where-Object { $_.Name -match 'COM\\d+' } | " +
      "Select-Object -Property Name,DeviceID | ConvertTo-Json -Compress";
    let stdout;
    try {
      ({ stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        timeout: 30_000,
      }));
    } catch (err) {
      return ok(`Could not query COM ports: ${err.message}`);
    }

    const raw = String(stdout).trim();
    if (!raw) return ok("No serial (COM) devices found.");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return ok(`COM ports (raw):\n${truncate(raw)}`);
    }
    // ConvertTo-Json emits a bare object when there is exactly one match.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) return ok("No serial (COM) devices found.");
    return ok(
      ["Serial / USB devices:", ...items.map((i) => `  ${i.Name}\n    ${i.DeviceID}`)].join("\n"),
    );
  }

  const prefixes = process.platform === "darwin"
    ? ["cu.", "tty."]
    : ["ttyUSB", "ttyACM", "ttyS", "ttyAMA"];
  const nodes = listDevNodes(prefixes);
  if (nodes.length === 0) {
    return ok(`No serial devices found (looked for ${prefixes.join(", ")} in /dev).`);
  }

  const rows = [];
  for (const node of nodes) {
    const base = path.basename(node);
    let extra = "";
    // On Linux the USB descriptors hang off /sys/class/tty/<dev>/device.
    for (const rel of ["../idVendor", "../idProduct", "../../idVendor", "../../idProduct"]) {
      const file = `/sys/class/tty/${base}/device/${rel}`;
      if (existsSync(file)) {
        try {
          const { readFileSync } = await import("node:fs");
          extra += ` ${rel.includes("Vendor") ? "vid" : "pid"}=${readFileSync(file, "utf8").trim()}`;
        } catch { /* not readable */ }
      }
    }
    rows.push(`  ${node}${extra}`);
  }
  return ok(["Serial / USB devices:", ...rows].join("\n"));
}
