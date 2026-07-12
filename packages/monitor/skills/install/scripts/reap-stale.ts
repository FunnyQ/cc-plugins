// Reap monitor daemons left behind by PREVIOUS plugin versions.
//
// Until 3.19.0 the cockpit channel had no exit path: the MCP SDK's stdio transport
// listens only for stdin 'data'/'error', so when Claude Code closed the pipe the
// channel was reparented to PID 1 and kept long-polling the daemon forever. Every
// release spawns channels from a new versioned cache root, so the orphans piled up one
// generation at a time — machines were found running channels from six versions at once,
// several of them ping-ponging on a shared session id and burning most of two cores.
//
// 3.19.0 stops NEW orphans. It cannot retire the ones already on disk, so this sweep
// does — once, on the first session after the upgrade.
//
// The selection is deliberately narrow on TWO axes.
//
// WHICH PROCESSES — only the cockpit channel and its daemon. A stale cockpit daemon is
// safe to signal because it self-heals: any live channel's next poll fails and calls
// `ensureCockpitDaemon()`, which respawns it.
//
// `atlas-server` is deliberately NOT in scope, even though it orphans to PID 1 the same
// way. It IS the usage dashboard — the thing the user has open in a browser tab — and
// unlike the cockpit daemon, **nothing re-ensures it**: the channel never touches it, and
// usage-dashboard's SKILL.md says the skill owns its lifecycle. Reaping it after an
// upgrade would kill a dashboard the user is actively looking at, permanently. It was
// never part of the leak (no polling loop, so it burns nothing); it is merely idle.
//
// WHICH OF THOSE — a foreign version root is NOT evidence of orphanhood: a user can have
// an older session still open when a newer one starts, and that session's channel is
// alive, correctly parented, and doing its job. Only PPID == 1 proves the parent is gone.

import { execFileSync } from "node:child_process";

export type ProcRow = {
  pid: number;
  ppid: number;
  uid: number;
  command: string;
};

const MONITOR_SCRIPT =
  /[/\\]monitor[/\\](\d+\.\d+\.\d+)[/\\]skills[/\\]cockpit[/\\]scripts[/\\](?:cockpit-channel|cockpit-server)\.ts\b/;

export function parsePsRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      command: m[4]!,
    });
  }
  return rows;
}

export function selectStaleMonitorPids(
  rows: ProcRow[],
  opts: { version: string; uid: number; selfPid: number },
): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(opts.version)) return [];
  return rows
    .filter((r) => {
      if (r.pid <= 1 || r.pid === opts.selfPid) return false;
      if (r.ppid !== 1) return false; // parent alive → not an orphan → hands off
      if (r.uid !== opts.uid) return false;
      const version = r.command.match(MONITOR_SCRIPT)?.[1];
      return !!version && version !== opts.version;
    })
    .map((r) => r.pid);
}

// Best-effort: a SessionStart hook must never break a session, so every failure here is
// swallowed. Returns how many processes were signalled.
export function reapStaleMonitorProcesses(
  version: string,
  run: () => string = () =>
    execFileSync("ps", ["-Ao", "pid=,ppid=,uid=,command="], {
      encoding: "utf-8",
    }),
  kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): number {
  let reaped = 0;
  try {
    const pids = selectStaleMonitorPids(parsePsRows(run()), {
      version,
      uid: process.getuid?.() ?? -1,
      selfPid: process.pid,
    });
    for (const pid of pids) {
      try {
        kill(pid);
        reaped++;
      } catch {
        // Already gone, or not ours to signal. Either way, nothing to do.
      }
    }
  } catch {
    // ps unavailable / unparseable — skip the sweep entirely.
  }
  return reaped;
}
