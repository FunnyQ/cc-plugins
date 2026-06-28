/**
 * nudge-toggle — multi-scope kill switch for scribe Stop-hook nudges.
 *
 * Three scopes, each holding an explicit `on` / `off` or no opinion (unset).
 * The most-specific *defined* scope wins; if none is defined, nudges stay on:
 *
 *   session  →  project  →  user  →  (default: enabled)
 *
 * So a broad `off` (e.g. user-level) can be re-enabled at a narrower scope
 * (`cockpit nudge on` for this session), and `clear` drops a scope's opinion so
 * it defers again.
 *
 * Storage:
 *   - session — a TTL-pruned file here in COCKPIT_HOME (ephemeral, one session).
 *   - project / user — the persistent global config (config.ts), respecting the
 *     "no per-project metadata file" rule: project opinions are keyed by project
 *     root inside the one global config, never a repo dotfile.
 *
 * The Stop hook reads its session id + cwd from stdin; the `cockpit nudge`
 * command resolves the same id (CLAUDE_CODE_SESSION_ID via find-session) and the
 * same project root (projectKey) — so writes and lookups share one key.
 */

import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cockpitHome } from "./cockpit-home";
import {
  getProjectNudge,
  getUserNudge,
  setProjectNudge,
  setUserNudge,
  type NudgeState,
} from "./config";

export const NUDGE_TOGGLE_TTL_MS = 7 * 24 * 60 * 60_000; // a week idle

export type ToggleAction = "on" | "off" | "toggle" | "clear";
export type NudgeScope = "session" | "project" | "user";

// ── Pure core (unit-tested) ──────────────────────────────────────────────────

/**
 * Resolve whether nudges are enabled from the three scopes. The first *defined*
 * scope (session, then project, then user) decides; all-unset → enabled.
 */
export function resolveNudgeEnabled(
  session: NudgeState | undefined,
  project: NudgeState | undefined,
  user: NudgeState | undefined,
): boolean {
  const decided = session ?? project ?? user;
  return decided !== "off";
}

/** The next state for a scope after an action (toggle/clear are 3-state aware). */
export function applyAction(
  action: ToggleAction,
  current: NudgeState | undefined,
): NudgeState | undefined {
  switch (action) {
    case "on":
      return "on";
    case "off":
      return "off";
    case "clear":
      return undefined;
    case "toggle":
      return current === "off" ? "on" : "off";
  }
}

/** Drop entries older than the TTL so the session file never grows unbounded. */
export function pruneSessions(store: SessionStore, now: number): SessionStore {
  const out: SessionStore = {};
  for (const [id, e] of Object.entries(store)) {
    if (now - e.ts < NUDGE_TOGGLE_TTL_MS) out[id] = e;
  }
  return out;
}

// ── Session store (I/O) ──────────────────────────────────────────────────────

type SessionEntry = { state: NudgeState; ts: number };
export type SessionStore = Record<string, SessionEntry>;

function sessionPath(): string {
  return join(cockpitHome(), "scribe-nudge-toggle.json");
}

function readSessions(now: number): SessionStore {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sessionPath(), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const store: SessionStore = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === "object" &&
      ((v as SessionEntry).state === "on" ||
        (v as SessionEntry).state === "off") &&
      typeof (v as SessionEntry).ts === "number"
    ) {
      store[id] = {
        state: (v as SessionEntry).state,
        ts: (v as SessionEntry).ts,
      };
    }
  }
  return pruneSessions(store, now);
}

function writeSessions(store: SessionStore): void {
  try {
    const p = sessionPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store));
  } catch {
    /* best-effort — never break the caller over a write failure */
  }
}

export function getSessionNudge(
  sessionId: string | null | undefined,
  now: number,
): NudgeState | undefined {
  if (!sessionId) return undefined;
  return readSessions(now)[sessionId]?.state;
}

function setSessionNudge(
  sessionId: string,
  state: NudgeState | undefined,
  now: number,
): void {
  const store = readSessions(now);
  if (state === undefined) delete store[sessionId];
  else store[sessionId] = { state, ts: now };
  writeSessions(store);
}

// ── Project key ──────────────────────────────────────────────────────────────

/** A stable project key = git root of cwd (so subdirs share one opinion), else cwd. */
export function projectKey(cwd: string): string {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    if (r.status === 0) {
      const top = (r.stdout ?? "").trim();
      if (top) return top;
    }
  } catch {
    /* not a git repo / git missing — fall back to cwd */
  }
  return cwd;
}

// ── Combined accessors (used by the hook + command) ──────────────────────────

/** Effective enabled-state for a (session, cwd) pair across all three scopes. */
export function nudgeEnabledFor(
  sessionId: string | null | undefined,
  cwd: string,
  now: number,
): boolean {
  return resolveNudgeEnabled(
    getSessionNudge(sessionId, now),
    getProjectNudge(projectKey(cwd)),
    getUserNudge(),
  );
}

/** Read every scope's raw opinion — for the command's status/report output. */
export function readScopes(
  sessionId: string | null | undefined,
  cwd: string,
  now: number,
): Record<NudgeScope, NudgeState | undefined> {
  return {
    session: getSessionNudge(sessionId, now),
    project: getProjectNudge(projectKey(cwd)),
    user: getUserNudge(),
  };
}

/** Apply an action at one scope; returns that scope's new state. */
export function setScope(
  scope: NudgeScope,
  action: ToggleAction,
  ctx: { sessionId: string; cwd: string; now: number },
): NudgeState | undefined {
  if (scope === "session") {
    const next = applyAction(action, getSessionNudge(ctx.sessionId, ctx.now));
    setSessionNudge(ctx.sessionId, next, ctx.now);
    return next;
  }
  if (scope === "project") {
    const key = projectKey(ctx.cwd);
    const next = applyAction(action, getProjectNudge(key));
    setProjectNudge(key, next ?? null);
    return next;
  }
  const next = applyAction(action, getUserNudge());
  setUserNudge(next ?? null);
  return next;
}
