// Pure shaping for the "Live now" panel: turn already-read raw rows (Claude
// session files, Codex thread rows, OpenCode session rows, the cockpit registry)
// into the sorted, stale-filtered, cockpit-tagged LiveSession list. The
// filesystem/SQLite reads stay in live.ts; everything testable without I/O lives
// here.
import { openCodeTimestampMs } from "../../shared/scripts/opencode";

export type LiveSession = {
  provider: "claude" | "codex" | "opencode";
  id: string;
  projectName: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  statusSource:
    | "claude-session-file"
    | "codex-app-server"
    | "codex-sqlite-rollout"
    | "opencode-sqlite-session";
  updatedAt: string;
  ageMs: number;
  isStale: boolean;
  transcriptPath?: string;
  model?: string;
  version?: string;
  // true when this live session is also a registered cockpit session (has a
  // decision trail) — surfaced as a badge so you know it's worth opening there.
  cockpit?: boolean;
};

export type ClaudeSessionInput = {
  sessionId: string;
  cwd: string;
  status: string;
  startedAt: number;
  updatedAt?: number;
  version?: string;
};

export type CodexRowInput = {
  id: string;
  cwd: string;
  rollout_path: string;
  model: string | null;
  updated_at_ms?: number | null;
  updated_at: number;
  created_at_ms?: number | null;
  created_at: number;
};

export type OpenCodeRowInput = {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
};

export const STALE_CUTOFF_MS = 10 * 60 * 1000;
export const CODEX_BUSY_CUTOFF_MS = 60 * 1000;

export function projectNameFor(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

// Sort order for the panel: actively-working first, then waiting, then the
// progressively-staler buckets. Unknown statuses sink to the bottom.
export function statusRank(status: string): number {
  if (status === "busy" || status === "active-inferred") return 0;
  if (status === "waiting") return 1;
  if (status === "recent") return 2;
  if (status === "idle") return 3;
  return 4;
}

// Codex rows store time in several columns of varying availability; prefer the
// most precise present one. Mirrors the SQLite `coalesce(...)` ordering.
export function codexUpdatedAtMs(row: CodexRowInput): number {
  return (
    row.updated_at_ms ||
    (row.updated_at ? row.updated_at * 1000 : 0) ||
    row.created_at_ms ||
    row.created_at * 1000
  );
}

// Parse cockpit's registry.json content into the membership key set
// (`<provider>:<sessionId>`). Tolerant of missing/corrupt input → empty set.
export function parseCockpitKeys(raw: string): Set<string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)) {
      return new Set<string>(
        parsed.sessions
          .filter(
            (s: { sessionId?: unknown }) => typeof s?.sessionId === "string",
          )
          .map((s: { provider?: string; sessionId: string }) => {
            const provider =
              s.provider === "codex" || s.provider === "opencode"
                ? s.provider
                : "claude";
            return `${provider}:${s.sessionId}`;
          }),
      );
    }
  } catch {
    // registry missing or corrupt — no cockpit tags
  }
  return new Set<string>();
}

export function buildClaudeLiveSessions(
  files: ClaudeSessionInput[],
  cockpitKeys: Set<string>,
  transcriptIndex: Map<string, string>,
  now: number,
): LiveSession[] {
  return files
    .map((session) => {
      const updatedAtMs = session.updatedAt ?? session.startedAt;
      const ageMs = Math.max(0, now - updatedAtMs);
      return {
        provider: "claude",
        id: session.sessionId,
        projectName: projectNameFor(session.cwd),
        cwd: session.cwd,
        status: session.status,
        statusSource: "claude-session-file",
        updatedAt: new Date(updatedAtMs).toISOString(),
        ageMs,
        isStale: ageMs > STALE_CUTOFF_MS,
        transcriptPath: transcriptIndex.get(session.sessionId),
        version: session.version,
        cockpit: cockpitKeys.has(`claude:${session.sessionId}`),
      } satisfies LiveSession;
    })
    .filter((session) => !session.isStale);
}

// Codex sessions need their rollout transcript to actually exist on disk; that
// check is injected so this stays pure (live.ts passes existsSync).
export function buildCodexLiveSessions(
  rows: CodexRowInput[],
  cockpitKeys: Set<string>,
  now: number,
  transcriptExists: (path: string) => boolean,
): LiveSession[] {
  return rows
    .map((row) => {
      const updatedAtMs = codexUpdatedAtMs(row);
      const ageMs = Math.max(0, now - updatedAtMs);
      return {
        provider: "codex",
        id: row.id,
        projectName: projectNameFor(row.cwd),
        cwd: row.cwd,
        status: ageMs <= CODEX_BUSY_CUTOFF_MS ? "active-inferred" : "recent",
        statusSource: "codex-sqlite-rollout",
        updatedAt: new Date(updatedAtMs).toISOString(),
        ageMs,
        isStale: ageMs > STALE_CUTOFF_MS,
        transcriptPath: row.rollout_path || undefined,
        model: row.model ?? undefined,
        cockpit: cockpitKeys.has(`codex:${row.id}`),
      } satisfies LiveSession;
    })
    .filter(
      (session) =>
        !session.isStale &&
        !!session.transcriptPath &&
        transcriptExists(session.transcriptPath),
    );
}

export function buildOpenCodeLiveSessions(
  rows: OpenCodeRowInput[],
  cockpitKeys: Set<string>,
  now: number,
): LiveSession[] {
  return rows
    .map((row) => {
      const updatedAtMs =
        openCodeTimestampMs(row.time_updated) ||
        openCodeTimestampMs(row.time_created);
      const ageMs = Math.max(0, now - updatedAtMs);
      return {
        provider: "opencode",
        id: row.id,
        projectName: projectNameFor(row.directory),
        cwd: row.directory,
        status: ageMs <= CODEX_BUSY_CUTOFF_MS ? "active-inferred" : "recent",
        statusSource: "opencode-sqlite-session",
        updatedAt: new Date(updatedAtMs).toISOString(),
        ageMs,
        isStale: ageMs > STALE_CUTOFF_MS,
        cockpit: cockpitKeys.has(`opencode:${row.id}`),
      } satisfies LiveSession;
    })
    .filter((session) => !session.isStale);
}

// Merge + order both providers' sessions: status bucket first, then most
// recently active within a bucket.
export function sortLiveSessions(sessions: LiveSession[]): LiveSession[] {
  return [...sessions].sort((a, b) => {
    const statusDelta = statusRank(a.status) - statusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}
