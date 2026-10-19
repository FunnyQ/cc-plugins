import type { DaemonInfo } from "./daemon-record";

export type StartupDecision =
  | { action: "reuse"; info: DaemonInfo }
  | {
      action: "supersede";
      info: DaemonInfo;
      reason: "moved-install" | "different-plan" | "port-change";
    }
  | { action: "start" };

export function decideStartup(
  info: Partial<DaemonInfo> | null,
  me: { root: string; plan: string; port: number },
  isAlive: (pid: number) => boolean,
): StartupDecision {
  if (typeof info?.pid !== "number" || !isAlive(info.pid)) {
    return { action: "start" };
  }

  const daemon = info as DaemonInfo;

  if (daemon.root !== me.root) {
    return { action: "supersede", info: daemon, reason: "moved-install" };
  }

  if (daemon.plan !== me.plan) {
    return { action: "supersede", info: daemon, reason: "different-plan" };
  }

  if (daemon.port !== me.port) {
    return { action: "supersede", info: daemon, reason: "port-change" };
  }

  return { action: "reuse", info: daemon };
}
