#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const STALE_CUTOFF_MS = 10 * 60 * 1000;

type ClaudeSessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  startedAt: number;
  updatedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
};

export type LiveSession = {
  provider: "claude" | "codex";
  id: string;
  projectName: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  statusSource:
    | "claude-session-file"
    | "codex-app-server"
    | "codex-sqlite-rollout";
  updatedAt: string;
  ageMs: number;
  isStale: boolean;
  transcriptPath?: string;
  model?: string;
  version?: string;
};

function readSessionFiles(): ClaudeSessionFile[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: ClaudeSessionFile[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      if (
        data &&
        typeof data.sessionId === "string" &&
        typeof data.cwd === "string" &&
        typeof data.startedAt === "number"
      ) {
        out.push(data);
      }
    } catch {
      // skip malformed / partially-written file
    }
  }
  return out;
}

function projectNameFor(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

function transcriptPathFor(id: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  const glob = new Glob(`**/${id}.jsonl`);
  for (const rel of glob.scanSync({ cwd: PROJECTS_DIR, onlyFiles: true })) {
    return join(PROJECTS_DIR, rel);
  }
  return undefined;
}

function statusRank(status: string): number {
  if (status === "waiting") return 0;
  if (status === "busy") return 1;
  if (status === "idle") return 2;
  return 3;
}

export function getLiveSessions(): LiveSession[] {
  const now = Date.now();
  return readSessionFiles()
    .map((session) => {
      const updatedAtMs = session.updatedAt ?? session.startedAt;
      const ageMs = now - updatedAtMs;
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
        transcriptPath: transcriptPathFor(session.sessionId),
        version: session.version,
      } satisfies LiveSession;
    })
    .filter((session) => !session.isStale)
    .sort((a, b) => {
      const statusDelta = statusRank(a.status) - statusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}

if (import.meta.main) {
  process.stdout.write(
    JSON.stringify({ sessions: getLiveSessions() }, null, 2),
  );
}
