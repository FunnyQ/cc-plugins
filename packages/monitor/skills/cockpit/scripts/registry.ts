// cockpit registry — reads ~/.cockpit/registry.json, derives active/ended
// status per session, and builds the /api/sessions + /api/projects payloads.
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getLiveSessions } from "./live-sessions";
import { latestOpenCallId } from "./call-log";
import { subagentCountFor } from "./subagents";

export type RegistryEntry = {
  provider: Provider;
  project: string;
  sessionId: string;
  logPath: string;
  lastHeartbeat: string;
};

export type Provider = "claude" | "codex";

export type SessionStatus = "active" | "ended";

// The fine-grained status the rail's LED + label render. `status` (active/ended)
// still drives sort/counts/expand; this is purely the display vocabulary,
// derived from the live harness status with two cockpit-native overlays:
// `your-call` (parked on an unanswered needs_your_call) wins over any working
// state, and a stale session always reads `ended`.
export type LiveStatus =
  | "working"
  | "waiting"
  | "your-call"
  | "idle"
  | "shell"
  | "ended";

export type SessionView = {
  provider: Provider;
  project: string;
  sessionId: string;
  logPath: string;
  status: SessionStatus;
  liveStatus: LiveStatus;
  // In-flight Agent/Task delegations (Claude only) — drives the "⊕ N agents"
  // badge. 0 for ended sessions, Codex, or when the transcript can't be read.
  subagents: number;
  lastHeartbeat: string;
  sessionGoal: string;
  projectGoal: string;
  // false for a session that's running but was never /cockpit-start'd: it shows
  // in the manifest (transcript streams by id) but has no goal/decision trail.
  tracked: boolean;
};

export type ProjectView = {
  project: string;
  name: string;
  projectGoal: string;
  activeCount: number;
  sessionCount: number;
  lastHeartbeat: string;
};

export const STALE_MS = 10 * 60 * 1000; // 10 min — matches token-atlas live filtering

// ---------- central dir (overridable for tests) ----------

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function registryPath(): string {
  return join(cockpitHome(), "registry.json");
}

// ---------- read ----------

export function readRegistry(): RegistryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (raw && Array.isArray(raw.sessions)) {
      return raw.sessions
        .filter((s: any) => s && typeof s.sessionId === "string")
        .map((s: any) => ({
          ...s,
          provider: s.provider === "codex" ? "codex" : "claude",
        })) as RegistryEntry[];
    }
  } catch {
    // missing or corrupt → empty
  }
  return [];
}

// ---------- status ----------

function logMtime(logPath: string): number {
  try {
    return statSync(logPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function statusOf(e: RegistryEntry, now = Date.now()): SessionStatus {
  const hb = Date.parse(e.lastHeartbeat);
  const lastSignal = Math.max(Number.isNaN(hb) ? 0 : hb, logMtime(e.logPath));
  return now - lastSignal < STALE_MS ? "active" : "ended";
}

// Map a session to its display status. Priority is deliberate:
//   1. not active → `ended` (process gone; a stale "your turn" would mislead)
//   2. parked on an open needs_your_call → `your-call` (the cockpit's own
//      handoff outranks whatever the harness is nominally doing)
//   3. otherwise the live harness status, normalised to the vocabulary
// `harnessStatus` is undefined when a session reads active by heartbeat but has
// no live session file (the brief gap after the file goes but before staleness)
// — treat that as `idle` rather than inventing activity.
export function deriveLiveStatus(opts: {
  active: boolean;
  openCall: boolean;
  harnessStatus?: string;
}): LiveStatus {
  if (!opts.active) return "ended";
  if (opts.openCall) return "your-call";
  switch (opts.harnessStatus) {
    case "busy":
      return "working";
    case "waiting":
      return "waiting";
    case "shell":
      return "shell";
    default:
      return "idle";
  }
}

// True when the session's log ends on an unanswered needs_your_call. Reused from
// the broker's seam so the rail agrees with the wait/send loop on "your turn".
// Best-effort: an unreadable log is simply "no open call".
function hasOpenCall(logPath: string): boolean {
  if (!logPath) return false;
  try {
    return latestOpenCallId(readFileSync(logPath, "utf8").split("\n")) !== null;
  } catch {
    return false;
  }
}

// In-flight delegation count. Skipping ended sessions avoids a needless
// transcript/DB read every poll; provider-specific details live in subagents.ts.
function subagentsFor(
  active: boolean,
  provider: Provider,
  sessionId: string,
  now: number,
): number {
  if (!active) return 0;
  return subagentCountFor(provider, sessionId, now);
}

// ---------- goal readers ----------

// The goal record is line 1 of the log, so we only need the file's head — not
// the whole (ever-growing) JSONL, which /api/sessions would otherwise re-read in
// full every poll. Read a bounded prefix and scan it for the first non-empty
// line; a goal record is far shorter than HEAD_BYTES, so it's always complete.
const HEAD_BYTES = 64 * 1024;

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf-8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function readSessionGoal(logPath: string): string {
  try {
    const first = readHead(logPath)
      .split("\n")
      .find((l) => l.trim());
    if (!first) return "";
    const rec = JSON.parse(first);
    return rec?.type === "goal" && typeof rec.session_goal === "string"
      ? rec.session_goal
      : "";
  } catch {
    return "";
  }
}

export function readProjectGoal(project: string): string {
  const metaPath = join(project, ".cockpit", "project-meta.md");
  if (!existsSync(metaPath)) return "";
  try {
    const m = readFileSync(metaPath, "utf8").match(
      /^project_goal:\s*(.*)\s*$/m,
    );
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// ---------- views ----------

function activeFirst<
  T extends { status?: SessionStatus; lastHeartbeat: string },
>(a: T, b: T): number {
  const aActive = a.status === "active" ? 1 : 0;
  const bActive = b.status === "active" ? 1 : 0;
  if (aActive !== bActive) return bActive - aActive;
  // newer activity first within a status bucket
  return Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat);
}

export function buildSessions(now = Date.now()): SessionView[] {
  // Sessions sharing a project read the same project-meta.md; cache per build
  // pass so it's read once per project, not once per session.
  const goalCache = new Map<string, string>();
  const projectGoal = (project: string): string => {
    let g = goalCache.get(project);
    if (g === undefined) {
      g = readProjectGoal(project);
      goalCache.set(project, g);
    }
    return g;
  };
  // Sessions actually running right now (across all projects, tracked or not),
  // keyed provider:id. A registered session that's live is forced "active"; a
  // live session with no registry entry is appended so the manifest mirrors
  // what's live — not just what was /cockpit-start'd.
  const liveByKey = new Map(
    getLiveSessions(now).map((l) => [`${l.provider}:${l.id}`, l]),
  );
  const seen = new Set<string>();

  const tracked = readRegistry().map((e): SessionView => {
    const key = `${e.provider}:${e.sessionId}`;
    seen.add(key);
    const live = liveByKey.get(key);
    const active = !!live || statusOf(e, now) === "active";
    return {
      provider: e.provider,
      project: e.project,
      sessionId: e.sessionId,
      logPath: e.logPath,
      status: active ? "active" : "ended",
      liveStatus: deriveLiveStatus({
        active,
        // Only an active session can be parked on a live "your turn"; skip the
        // log read entirely for ended ones.
        openCall: active && hasOpenCall(e.logPath),
        harnessStatus: live?.status,
      }),
      subagents: subagentsFor(active, e.provider, e.sessionId, now),
      lastHeartbeat: e.lastHeartbeat,
      sessionGoal: readSessionGoal(e.logPath),
      projectGoal: projectGoal(e.project),
      tracked: true,
    };
  });

  const untracked: SessionView[] = [];
  for (const l of liveByKey.values()) {
    const key = `${l.provider}:${l.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    untracked.push({
      provider: l.provider,
      project: l.cwd,
      sessionId: l.id,
      logPath: "",
      status: "active",
      // No cockpit log, so no needs_your_call to be parked on — just the harness
      // status. (`l` is in liveByKey, so it's live by definition.)
      liveStatus: deriveLiveStatus({
        active: true,
        openCall: false,
        harnessStatus: l.status,
      }),
      subagents: subagentsFor(true, l.provider, l.id, now),
      lastHeartbeat: new Date(l.updatedAtMs).toISOString(),
      sessionGoal: "",
      projectGoal: projectGoal(l.cwd),
      tracked: false,
    });
  }

  return [...tracked, ...untracked].sort(activeFirst);
}

export function buildProjects(now = Date.now()): ProjectView[] {
  const sessions = buildSessions(now);
  const byProject = new Map<string, SessionView[]>();
  for (const s of sessions) {
    (
      byProject.get(s.project) ?? byProject.set(s.project, []).get(s.project)!
    ).push(s);
  }
  const projects: ProjectView[] = [];
  for (const [project, group] of byProject) {
    const activeCount = group.filter((s) => s.status === "active").length;
    const lastHeartbeat =
      group
        .map((s) => s.lastHeartbeat)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? "";
    projects.push({
      project,
      name: basename(project),
      // every session in the group carries the same project goal (already read
      // in buildSessions) — reuse it rather than re-reading project-meta.md.
      projectGoal: group[0]?.projectGoal ?? "",
      activeCount,
      sessionCount: group.length,
      lastHeartbeat,
    });
  }
  return projects.sort((a, b) => {
    const aActive = a.activeCount > 0 ? 1 : 0;
    const bActive = b.activeCount > 0 ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return Date.parse(b.lastHeartbeat) - Date.parse(a.lastHeartbeat);
  });
}

// ---------- API handlers ----------

export function sessionsPayload(): { sessions: SessionView[] } {
  return { sessions: buildSessions() };
}

export function projectsPayload(): { projects: ProjectView[] } {
  return { projects: buildProjects() };
}
