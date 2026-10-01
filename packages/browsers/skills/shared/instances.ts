// Every headless instance is its own process, throwaway profile, and port, recorded
// as one JSON file under `<stateDir>/instances/`. Shared by the firefox and chrome
// skills; Safari has a single machine-wide session and keeps its own record.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Instance = {
  id: string;
  pid: number;
  port: number;
  profile: string;
  browser: string;
  headless: boolean;
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pickInstance(live: Instance[], id: string | null): Instance {
  if (id !== null) {
    const found = live.find((instance) => instance.id === id);
    if (!found)
      throw new Error(
        `no open instance ${id}; open: ${live.map((i) => i.id).join(", ") || "none"}`,
      );
    return found;
  }
  if (live.length === 0)
    throw new Error("no instance is open — run `open <url>` first");
  if (live.length > 1) {
    throw new Error(
      `${live.length} instances are open — pass --id: ${live.map((i) => i.id).join(", ")}`,
    );
  }
  return live[0]!;
}

export function resolveBinary(
  name: string,
  candidates: string[],
  exists: (path: string) => boolean = existsSync,
): string {
  const found = candidates.find(exists);
  if (!found)
    throw new Error(`no ${name} found; looked for ${candidates.join(", ")}`);
  return found;
}

/** Live instances; a record whose process died is pruned with its profile. */
export function liveInstances(stateDir: string): Instance[] {
  const dir = join(stateDir, "instances");
  if (!existsSync(dir)) return [];
  const live: Instance[] = [];
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    const instance = JSON.parse(readFileSync(path, "utf8")) as Instance;
    if (isAlive(instance.pid)) live.push(instance);
    else {
      rmSync(instance.profile, { recursive: true, force: true });
      rmSync(path, { force: true });
    }
  }
  return live;
}

/** A fresh profile directory; its random suffix doubles as the instance id. */
export function newProfile(stateDir: string): { id: string; profile: string } {
  mkdirSync(join(stateDir, "instances"), { recursive: true });
  const profile = mkdtempSync(join(stateDir, "profile-"));
  return { id: profile.slice(profile.lastIndexOf("-") + 1), profile };
}

export function recordInstance(stateDir: string, instance: Instance): void {
  writeFileSync(
    join(stateDir, "instances", `${instance.id}.json`),
    JSON.stringify(instance),
  );
}

export async function shutdown(
  stateDir: string,
  instance: Instance,
): Promise<void> {
  if (isAlive(instance.pid)) process.kill(instance.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (isAlive(instance.pid) && Date.now() < deadline) await Bun.sleep(20);
  rmSync(instance.profile, { recursive: true, force: true });
  rmSync(join(stateDir, "instances", `${instance.id}.json`), { force: true });
}

export async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}
