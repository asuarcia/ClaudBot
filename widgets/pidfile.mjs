/**
 * widgets/pidfile.mjs — "is the feed already running?", answered honestly.
 *
 * Three different things can start widgets/bridge.mjs --watch: `claudbot
 * widgets` in a terminal, `claudbot night` as one of its supervised children,
 * and the logon task from widgets/autostart.mjs. Two of them running at once
 * isn't corrupting — every write is atomic — but it doubles the Finnhub calls
 * against a free-tier key and makes "why is this stale" impossible to reason
 * about. So the bridge claims a pid file on start, and everyone checks it.
 *
 * The check is deliberately stricter than "does this pid exist". Windows
 * recycles pids, so a pid file left behind by a hard kill will eventually name
 * a live, unrelated process — and a supervisor that trusts it would never start
 * the feed again. Matching the image name as well makes that a non-issue.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** The pid recorded in `file` if that process is still this program, else 0. */
export function livePid(file) {
  if (!existsSync(file)) return 0;

  let rec;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch { return 0; }
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  if (pid === process.pid) return 0; // our own claim from a previous line of this run

  if (process.platform === "win32") {
    // tasklist rather than a WMI query: `wmic` is gone from current Windows and
    // a CIM lookup means paying for a PowerShell start-up on every check.
    const image = path.basename(process.execPath);
    const r = spawnSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
      ["/NH", "/FO", "CSV", "/FI", `PID eq ${pid}`, "/FI", `IMAGENAME eq ${image}`],
      { encoding: "utf8", windowsHide: true },
    );
    // tasklist exits 0 with a "no tasks match" line when the filter matches
    // nothing, so the pid has to actually appear in the output.
    return r.stdout?.includes(`"${pid}"`) ? pid : 0;
  }

  // POSIX: signal 0 tests for existence. EPERM means it exists and belongs to
  // someone else, which still counts as running.
  try { process.kill(pid, 0); return pid; } catch (err) { return err.code === "EPERM" ? pid : 0; }
}

/** Claim `file` for this process, and release it on the way out. */
export function claimPidFile(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));

  const release = () => { try { unlinkSync(file); } catch { /* already gone */ } };
  process.on("exit", release);
  // 'exit' doesn't fire for a signal that isn't handled, and node's default for
  // SIGINT/SIGTERM is to die immediately — so release explicitly, then re-raise.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(sig, () => { release(); process.exit(0); });
  }
}
