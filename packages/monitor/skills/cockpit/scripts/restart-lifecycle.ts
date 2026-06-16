// Pure decision core for `cockpit restart`.
//
// Restart is racy by nature: a channel-flagged Claude session runs an MCP
// reconnect loop that respawns the daemon (from ITS install root) whenever the
// daemon it polls goes down. So killing the daemon and binding a fresh one can
// collide with that respawn. The orchestration in cockpit.ts handles the race by
// re-checking who owns the port after each spawn and superseding a foreign-root
// daemon until our install's daemon is the one serving. This module isolates the
// one classification that drives that loop so it can be unit-tested (cockpit.ts
// itself runs main() on import and can't be exercised directly).

export type DaemonProbe = { pid?: number; root?: string } | null;

// - no record / dead pid     → "absent": nothing is serving; spawn and wait.
// - alive & root === myRoot  → "ours": our install won the port (the caller still
//   confirms the HTTP port answers before declaring success).
// - alive & different root   → "foreign": an out-of-date/other install (e.g. an
//   MCP respawn from the old plugin cache) grabbed the port; supersede it and retry.
export function classifyDaemon(
  info: DaemonProbe,
  myRoot: string,
  isAlive: (pid: number) => boolean,
): "ours" | "foreign" | "absent" {
  if (!info || typeof info.pid !== "number" || !isAlive(info.pid)) {
    return "absent";
  }
  return info.root === myRoot ? "ours" : "foreign";
}
