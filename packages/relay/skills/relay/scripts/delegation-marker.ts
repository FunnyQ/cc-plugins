/**
 * delegation-marker — WRITE half of the cross-plugin delegation contract.
 *
 * relay already sets `RELAY_DELEGATED=1` on every delegate it spawns, and that
 * is enough everywhere except one path: codex's INTERACTIVE TUI hands its
 * session to a shared `codex app-server daemon` whose environment is captured
 * once at daemon start. A var set on the pane reaches the codex process but
 * never the hook, so monitor's decision-log hooks fire inside a delegate nobody
 * is watching. (`codex exec` is unaffected — it runs the session in-process and
 * does see the var, which is why the headless path needs nothing here.)
 *
 * So the live-codex path drops a file the hook can find. The reader lives in
 * monitor — `packages/monitor/skills/cockpit/scripts/delegation-marker.ts` —
 * and the two plugins version independently, so they share a PATH AND A SHAPE,
 * never code. Change either side and you must change the other:
 *
 *   ~/.local/share/q-lab/delegation/<startedAt>-<rand>.json
 *   { cwd, backend, startedAt, armUntil, expiresAt, sessionIds: [] }
 *
 * `armUntil` is the window in which the reader may match on cwd alone, before
 * it has any session id to key on. `expiresAt` is the whole marker's TTL, which
 * has to outlive the delegate: relay may exit while the pane is still working
 * (a `pending` live result), and a marker deleted then would un-silence a
 * delegate mid-flight.
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

/**
 * How long the reader may match on cwd alone. It has to cover relay's spawn
 * plus the TUI settling — live.ts waits up to SPAWN_IDLE_WAIT_MS (20s) for that
 * alone — with room for a cold pane. Too short and the delegate is never bound;
 * too long and an interactive codex opened in the same repo gets caught.
 */
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

/**
 * Only codex live panes need this. Claude and opencode run their hooks inside
 * the process relay spawned, so RELAY_DELEGATED already reaches them, and a
 * marker there would risk silencing the parent session sharing the repo.
 */
export function needsDelegationMarker(backend: string, live: boolean): boolean {
  return live && backend === "codex";
}

export function buildMarker(opts: {
  cwd: string;
  backend: string;
  now: number;
  waitTimeoutMs: number;
}): DelegationMarker {
  // The live path may reattach for several collect rounds after the first wait
  // expires, so the TTL covers the wait plus those rounds, not just the wait.
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

/** Write a marker and return its path, or null if the store is unwritable. */
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
    // A delegate that cannot be marked just gets nudges it will ignore. Never
    // fail the run over it.
    return null;
  }
}

export function clearDelegationMarker(path: string | null): void {
  if (!path) return;
  try {
    rmSync(path);
  } catch {
    /* already gone, or unwritable — the TTL collects it either way */
  }
}
