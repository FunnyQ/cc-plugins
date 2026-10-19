/**
 * relay already sets `RELAY_DELEGATED=1` on every delegate it spawns, and that
 * is enough everywhere except one path: codex's INTERACTIVE TUI hands its
 * session to a shared `codex app-server daemon` whose environment is captured
 * once at daemon start. A var set on the pane reaches the codex process but
 * never the hook, so monitor's decision-log hooks fire inside a delegate nobody
 * is watching. (`codex exec` is unaffected — it runs the session in-process and
 * does see the var, which is why the headless path needs nothing here.)
 *
 * So the live-codex path drops a file monitor's hook can find. The two plugins
 * version independently, so they share no code, only a fixture.
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type DelegationMarker = {
  cwd: string;
  backend: string;
  startedAt: number;
  armUntil: number;
  expiresAt: number;
  sessionIds: string[];
};

// Too long and an interactive codex opened in the same repo gets caught.
export const ARM_WINDOW_MS = 90_000;

const MIN_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 2 * 60 * 60_000;

export function delegationHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.Q_DELEGATION_HOME ||
    join(homedir(), ".local", "share", "q-lab", "delegation")
  );
}

// Only codex live panes need this. Claude and opencode run their hooks inside
// the process relay spawned, so RELAY_DELEGATED already reaches them, and a
// marker there would risk silencing the parent session sharing the repo.
export function needsDelegationMarker(backend: string, live: boolean): boolean {
  return live && backend === "codex";
}

export function buildMarker(opts: {
  cwd: string;
  backend: string;
  now: number;
  waitTimeoutMs: number;
}): DelegationMarker {
  const ttl = Math.min(
    MAX_TTL_MS,
    Math.max(MIN_TTL_MS, opts.waitTimeoutMs * 4),
  );
  return {
    cwd: opts.cwd,
    backend: opts.backend,
    startedAt: opts.now,
    armUntil: opts.now + ARM_WINDOW_MS,
    expiresAt: opts.now + ttl,
    sessionIds: [],
  };
}

export function writeDelegationMarker(
  marker: DelegationMarker,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dir = delegationHome(env);
  const name = `${marker.startedAt}-${Math.random().toString(36).slice(2, 10)}.json`;
  const path = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(marker));
    return path;
  } catch {
    return null;
  }
}

export function clearDelegationMarker(path: string | null): void {
  if (!path) return;
  try {
    rmSync(path);
  } catch {}
}
