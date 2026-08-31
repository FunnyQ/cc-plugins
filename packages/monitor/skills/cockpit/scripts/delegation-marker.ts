/**
 * delegation-marker — READ half of the cross-plugin delegation contract.
 *
 * Why this exists at all: `RELAY_DELEGATED=1` suppresses the decision-log hooks
 * everywhere except one path. Codex's INTERACTIVE TUI hands its session to a
 * shared `codex app-server daemon` whose environment is captured once at daemon
 * start, so a var set on the pane never reaches the hook. (`codex exec` is
 * unaffected — it runs the session in-process and does see the var. Verified:
 * `RELAY_DELEGATED=1 codex exec` suppresses; a herdr pane spawned with the same
 * var running interactive `codex` does not.) A file on disk is the only signal
 * that survives that daemon boundary.
 *
 * THE CONTRACT — the writer (relay) and this reader ship in separate plugins
 * that version independently, so they share a PATH AND A SHAPE, never code.
 * Change either side and you must change the other:
 *
 *   ~/.local/share/q-lab/delegation/<startedAt>-<rand>.json
 *   { cwd, backend, startedAt, armUntil, expiresAt, sessionIds: [] }
 *
 * Matching is two-phase on purpose. `cwd` alone is too coarse — an interactive
 * codex the user opens in the same repo would be silenced for its whole life.
 * So a marker only matches by cwd during a short arm window right after the
 * spawn; the hook that matches then writes its own `session_id` back, and every
 * later turn matches on that exact id. Fuzzy once, precise forever after.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DelegationMarker = {
  cwd: string;
  backend: string;
  startedAt: number;
  armUntil: number;
  expiresAt: number;
  sessionIds: string[];
};

export type MarkerFile = { name: string; marker: DelegationMarker };

export function delegationHome(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.Q_DELEGATION_HOME ||
    join(homedir(), ".local", "share", "q-lab", "delegation")
  );
}

// ── Pure core (unit-tested) ──────────────────────────────────────────────────

export type Classification = {
  delegated: boolean;
  /** Marker file to append our session id to, or null when nothing to bind. */
  bindTo: string | null;
  /** Marker files past their TTL — the caller prunes them. */
  expired: string[];
};

/**
 * Decide whether this session is a delegate, given every marker on disk.
 *
 * A session already listed in a marker wins outright: that binding was made
 * during the arm window and must outlive it, because a delegate runs for
 * minutes while the window is seconds.
 */
export function classifyMarkers(
  files: MarkerFile[],
  input: { cwd?: string; sessionId?: string; now: number },
): Classification {
  const expired: string[] = [];
  const live: MarkerFile[] = [];
  for (const file of files) {
    if (file.marker.expiresAt <= input.now) expired.push(file.name);
    else live.push(file);
  }

  if (input.sessionId) {
    for (const file of live) {
      if (file.marker.sessionIds.includes(input.sessionId)) {
        return { delegated: true, bindTo: null, expired };
      }
    }
  }

  if (!input.cwd) return { delegated: false, bindTo: null, expired };

  const armed = live.filter(
    (file) =>
      file.marker.cwd === input.cwd && input.now <= file.marker.armUntil,
  );
  if (armed.length === 0) return { delegated: false, bindTo: null, expired };

  // Prefer a marker nobody has claimed yet, so N parallel delegates in one repo
  // pair off 1:1 instead of all binding to the first marker — otherwise the
  // first delegate to finish clears the marker that the others were relying on.
  const unclaimed = armed.find((file) => file.marker.sessionIds.length === 0);
  const target = unclaimed ?? armed[0]!;
  return {
    delegated: true,
    bindTo: input.sessionId ? target.name : null,
    expired,
  };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function readMarkerFiles(dir: string): MarkerFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no directory means no delegation is in flight
  }
  const files: MarkerFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const marker = JSON.parse(
        readFileSync(join(dir, name), "utf8"),
      ) as DelegationMarker;
      // A half-written or hand-edited file must not decide anything.
      if (
        typeof marker?.cwd !== "string" ||
        typeof marker?.expiresAt !== "number" ||
        typeof marker?.armUntil !== "number" ||
        !Array.isArray(marker?.sessionIds)
      ) {
        continue;
      }
      files.push({ name, marker });
    } catch {
      /* unreadable marker — ignore, never throw into a hook */
    }
  }
  return files;
}

/**
 * Is this hook running inside a delegated session? Best-effort: any failure
 * answers "no", because a broken marker store must not silence a real session.
 */
export function isDelegatedSession(
  env: Record<string, string | undefined>,
  cwd: string | undefined,
  sessionId: string | undefined,
  now: number,
): boolean {
  const dir = delegationHome(env);
  const files = readMarkerFiles(dir);
  if (files.length === 0) return false;

  const verdict = classifyMarkers(files, { cwd, sessionId, now });

  for (const name of verdict.expired) {
    try {
      rmSync(join(dir, name));
    } catch {
      /* best-effort prune */
    }
  }

  if (verdict.bindTo && sessionId) {
    const target = files.find((file) => file.name === verdict.bindTo);
    if (target) {
      target.marker.sessionIds.push(sessionId);
      try {
        writeFileSync(join(dir, target.name), JSON.stringify(target.marker));
      } catch {
        /* the binding is an optimization; the arm window still covers us */
      }
    }
  }

  return verdict.delegated;
}
