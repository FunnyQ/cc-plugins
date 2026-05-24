// Startup decision for the singleton cockpit daemon.
//
// The reuse check used to ask only "is a daemon alive?" — never "is it the same
// install I'm launching from?". So moving the plugin dir (dev) or `claude plugin
// update` (new cache path) left a stale daemon serving dead file paths while the
// fresh launcher politely deferred to it. We now stamp the launcher's root into
// daemon.json and supersede a daemon whose root no longer matches.
//
// Pure + injectable `isAlive` so it's unit-testable; cockpit-server.ts runs side
// effects on import and can't be exercised directly.

export type DaemonInfo = {
  pid: number;
  port: number;
  token: string;
  // Absolute path identifying the install this daemon was launched from (the
  // scripts dir). Distinguishes "same install" from a moved/updated one.
  root: string;
};

export type StartupDecision =
  | { action: "reuse"; info: DaemonInfo }
  | { action: "supersede"; info: DaemonInfo }
  | { action: "start" };

// - no record / dead pid          → start fresh
// - alive & same root             → reuse (a real singleton already serves us)
// - alive & different/absent root → supersede: the running daemon belongs to a
//   moved or out-of-date install (stale served paths), so take over.
export function decideStartup(
  info: Partial<DaemonInfo> | null,
  myRoot: string,
  isAlive: (pid: number) => boolean,
): StartupDecision {
  if (!info || typeof info.pid !== "number" || !isAlive(info.pid)) {
    return { action: "start" };
  }
  const full = info as DaemonInfo;
  if (info.root === myRoot) return { action: "reuse", info: full };
  return { action: "supersede", info: full };
}
