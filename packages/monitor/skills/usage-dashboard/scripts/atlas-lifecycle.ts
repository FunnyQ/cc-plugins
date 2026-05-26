// Startup decision for the singleton usage-dashboard server.
//
// The atlas server writes ~/.cockpit/atlas.json with the running pid/port/root.
// A second launch from the same install reuses it; a moved or updated install
// supersedes the stale process so it can serve the current dashboard files.

export type AtlasInfo = {
  pid: number;
  port: number;
  root: string;
};

export type StartupDecision =
  | { action: "reuse"; info: AtlasInfo }
  | { action: "supersede"; info: AtlasInfo }
  | { action: "start" };

export function decideStartup(
  info: Partial<AtlasInfo> | null,
  myRoot: string,
  isAlive: (pid: number) => boolean,
): StartupDecision {
  if (
    !info ||
    typeof info.pid !== "number" ||
    typeof info.root !== "string" ||
    !isAlive(info.pid)
  ) {
    return { action: "start" };
  }
  const full = info as AtlasInfo;
  if (info.root === myRoot) return { action: "reuse", info: full };
  return { action: "supersede", info: full };
}
