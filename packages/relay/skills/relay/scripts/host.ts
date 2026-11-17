import { statSync } from "node:fs";
import { basename } from "node:path";

export type Host = "herdr" | "app";

export type HostProbe = {
  socketAlive: (path: string) => boolean;
  ancestors: () => string[];
};

// A herdr-core daemon started from a herdr pane hands HERDR_* to every
// herdr-app terminal, so the env alone cannot say which host this is.
export function hostOf(
  env: Record<string, string | undefined>,
  probe: HostProbe = LIVE,
): Host | null {
  const socket = env.HERDR_SOCKET_PATH;
  const herdr = env.HERDR_ENV === "1" && !!socket && probe.socketAlive(socket);
  const app = !!env.HC_TERMINAL_ID;
  if (herdr && app) {
    for (const exe of probe.ancestors()) {
      const name = basename(exe);
      if (name === "herdr-core") return "app";
      if (name === "herdr") return "herdr";
    }
    return "herdr";
  }
  return herdr ? "herdr" : app ? "app" : null;
}

const LIVE: HostProbe = {
  socketAlive(path) {
    try {
      return statSync(path).isSocket();
    } catch {
      return false;
    }
  },
  ancestors() {
    let out: string;
    try {
      out = Bun.spawnSync([
        "ps",
        "-A",
        "-o",
        "pid=,ppid=,comm=",
      ]).stdout.toString();
    } catch {
      return [];
    }
    const rows = new Map<number, { ppid: number; comm: string }>();
    for (const line of out.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (match) rows.set(+match[1], { ppid: +match[2], comm: match[3] });
    }
    const chain: string[] = [];
    let pid = process.ppid;
    while (pid > 1 && rows.has(pid) && chain.length < 64) {
      const row = rows.get(pid)!;
      chain.push(row.comm);
      pid = row.ppid;
    }
    return chain;
  },
};
