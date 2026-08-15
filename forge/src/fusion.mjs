/**
 * forge/src/fusion.mjs — driving the Fusion 360 desktop app.
 *
 * The other backends make a file and show you a picture of it. This one puts
 * real parametric geometry into the running Fusion — a feature tree with a
 * timeline you can scrub, dimensions you can retype, and Fusion's own assistant
 * sitting right there to take it further. That is a different kind of output,
 * and it is the right one when the answer is "not quite, move that".
 *
 * How it gets there: Fusion has no meaningful command line and its API is only
 * reachable from inside the process, so Forge cannot call it directly. Instead
 * an add-in (forge/fusion/ForgeBridge) runs inside Fusion and watches a folder.
 * Forge writes a job there and waits for the result file to appear. Crude, and
 * exactly right — it needs no ports, no auth, survives Fusion restarting, and
 * a job written while Fusion is closed simply runs when it next opens.
 *
 * The generated code is Fusion API Python, not build123d. That is the whole
 * point: build123d would give a solid to import, which lands in the timeline as
 * one dead lump. Fusion API calls produce sketches and extrudes and fillets as
 * separate, editable features.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  rmSync, cpSync, statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const WIN = process.platform === "win32";

/**
 * Fusion's per-user API folder — where add-ins have to live to be found.
 *
 * Not configurable, because Fusion does not make it configurable. The Windows
 * path is under Roaming; on macOS it is inside the sandboxed container, which
 * is why the two look nothing alike.
 */
export function apiDir() {
  if (process.env.FORGE_FUSION_API) return process.env.FORGE_FUSION_API;
  return WIN
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Autodesk", "Autodesk Fusion 360", "API")
    : path.join(os.homedir(), "Library", "Containers", "com.autodesk.mas.fusion360",
        "Data", "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API");
}

export const addInsDir = () => path.join(apiDir(), "AddIns");
export const installedAt = () => path.join(addInsDir(), "ForgeBridge");

/** Where jobs are exchanged. Desktop-only, like the widgets — see docs/forge.md. */
export function jobsDir() {
  if (process.env.FORGE_FUSION_JOBS) return process.env.FORGE_FUSION_JOBS;
  const base = WIN
    ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "Claudbot", "fusion-jobs");
}

/** Is Fusion 360 installed at all? */
export function installed() {
  return existsSync(apiDir());
}

/**
 * Is Fusion actually running?
 *
 * By process name, which is the only signal available without talking to it.
 * The main process is Fusion360.exe on Windows and "Autodesk Fusion 360" on
 * macOS — the launcher (NLauncher.exe) is a different process and being told
 * *that* is running would be a lie, because it exits once the app is up.
 */
export function running() {
  try {
    if (WIN) {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Fusion360.exe", "/NH"],
        { encoding: "utf8", windowsHide: true });
      return /Fusion360\.exe/i.test(r.stdout ?? "");
    }
    const r = spawnSync("pgrep", ["-f", "Autodesk Fusion 360"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Has the add-in reported for duty since Fusion last started?
 *
 * The bridge drops `.bridge-alive` on startup. Its presence means it was
 * installed and enabled at some point; its mtime tells you when. Both matter —
 * an add-in copied into place but never enabled looks identical on disk to one
 * that is working.
 */
export function bridgeStatus() {
  const marker = path.join(jobsDir(), ".bridge-alive");
  if (!existsSync(marker)) return { installed: existsSync(installedAt()), everRan: false };
  try {
    return {
      installed: existsSync(installedAt()),
      everRan: true,
      lastStart: statSync(marker).mtime,
      ...JSON.parse(readFileSync(marker, "utf8")),
    };
  } catch {
    return { installed: existsSync(installedAt()), everRan: true };
  }
}

/**
 * Copy the add-in into Fusion's AddIns folder and point it at the job dir.
 *
 * Copied rather than symlinked: Fusion reads the folder at startup and a
 * symlink needs developer mode on Windows. The config file is written at
 * install time so neither side hardcodes the other's paths — the same rule the
 * rest of Claudbot follows.
 */
export function install() {
  if (!installed()) {
    throw new Error(
      `Fusion 360 does not appear to be installed — no API folder at ${apiDir()}.`,
    );
  }

  const src = path.join(import.meta.dirname, "..", "fusion", "ForgeBridge");
  if (!existsSync(src)) throw new Error(`The add-in source is missing from ${src}.`);

  const dest = installedAt();
  mkdirSync(addInsDir(), { recursive: true });
  // Removed first: cpSync over an existing tree leaves stale files behind, and
  // a stale .py next to a new one is the kind of thing that takes an hour.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  const jobs = jobsDir();
  mkdirSync(jobs, { recursive: true });
  writeFileSync(
    path.join(dest, "forge-bridge.json"),
    JSON.stringify({ jobs, installedAt: new Date().toISOString() }, null, 2),
  );

  return { dest, jobs };
}

export function uninstall() {
  rmSync(installedAt(), { recursive: true, force: true });
  return installedAt();
}

/**
 * Send a job and wait for the bridge to answer.
 *
 * Polls for a result file rather than holding anything open. `timeoutMs` is
 * generous because the answer is gated on Fusion being *idle* — a custom event
 * is queued, not interrupting, so a job fired while the user is dragging a
 * sketch waits until they let go. That is the correct behaviour and it means a
 * short timeout would report failure for work that is merely queued.
 */
export async function send(job, { timeoutMs = 120_000 } = {}) {
  const dir = jobsDir();
  mkdirSync(dir, { recursive: true });

  const id = job.id ?? randomUUID();
  const payload = { ...job, id };

  // Written to a temp name and renamed: the watcher polls this folder, and a
  // partially written job would parse as corrupt and be thrown away.
  const file = path.join(dir, `${id}.job.json`);
  const tmp = `${file}.writing`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  const { renameSync } = await import("node:fs");
  renameSync(tmp, file);

  const result = path.join(dir, `${id}.result.json`);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (existsSync(result)) {
      const data = JSON.parse(readFileSync(result, "utf8"));
      cleanup(dir, id);
      return data;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  cleanup(dir, id);
  throw new Error(
    running()
      ? "Fusion did not answer. The ForgeBridge add-in may not be running — " +
        "check Utilities ▸ Add-Ins in Fusion, or run `claudbot forge fusion doctor`."
      : "Fusion 360 is not running, so the job is queued. It will build when you next open Fusion.",
  );
}

/** Leave the folder as we found it; a job dir that only grows is a bug report. */
function cleanup(dir, id) {
  for (const f of readdirSync(dir)) {
    if (f.startsWith(id)) rmSync(path.join(dir, f), { force: true });
  }
}

/** Round-trip the bridge. The one call that proves the whole path works. */
export const ping = () => send({ kind: "ping" }, { timeoutMs: 15_000 });

/**
 * Start Fusion if it is not already up.
 *
 * Through the registered `fusion360://` protocol rather than by finding an
 * executable: the install lives under a content-hashed webdeploy directory that
 * changes with every update, so any path found today is wrong after the next
 * one. The protocol handler is what Autodesk maintains.
 */
export function launch() {
  if (running()) return false;
  try {
    const [cmd, args] = WIN
      ? ["explorer.exe", ["fusion360://"]]
      : ["open", ["-a", "Autodesk Fusion 360"]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Everything `claudbot forge fusion doctor` needs to say. */
export function status() {
  return {
    installed: installed(),
    apiDir: apiDir(),
    addIn: installedAt(),
    addInPresent: existsSync(installedAt()),
    jobs: jobsDir(),
    running: running(),
    bridge: bridgeStatus(),
  };
}
