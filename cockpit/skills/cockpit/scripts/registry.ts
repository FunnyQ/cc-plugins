// cockpit registry — reads ~/.cockpit/registry.json, derives active/ended
// status per session, and builds the /api/sessions + /api/projects payloads.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type RegistryEntry = {
  project: string;
  sessionId: string;
  logPath: string;
  lastHeartbeat: string;
};

export type SessionStatus = "active" | "ended";

export type SessionView = {
  project: string;
  sessionId: string;
  logPath: string;
  status: SessionStatus;
  lastHeartbeat: string;
  sessionGoal: string;
  projectGoal: string;
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
      return raw.sessions.filter(
        (s: any) => s && typeof s.sessionId === "string",
      ) as RegistryEntry[];
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

// ---------- goal readers ----------

export function readSessionGoal(logPath: string): string {
  try {
    const first = readFileSync(logPath, "utf8")
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
  return readRegistry()
    .map(
      (e): SessionView => ({
        project: e.project,
        sessionId: e.sessionId,
        logPath: e.logPath,
        status: statusOf(e, now),
        lastHeartbeat: e.lastHeartbeat,
        sessionGoal: readSessionGoal(e.logPath),
        projectGoal: readProjectGoal(e.project),
      }),
    )
    .sort(activeFirst);
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
      projectGoal: readProjectGoal(project),
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
