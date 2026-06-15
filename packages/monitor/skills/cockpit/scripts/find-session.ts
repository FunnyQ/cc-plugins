#!/usr/bin/env bun
// Find the current Claude Code, Codex, or OpenCode session id for a project.
//
// Claude Code: the running session exposes its id in CLAUDE_CODE_SESSION_ID —
// that env var is authoritative, so we trust it first. Only when it's absent
// (e.g. an older CLI, or invoked outside a session) do we fall back to the
// most-recently-modified transcript under
//   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// (path encoded by replacing "/" and "." with "-"). The mtime guess is
// fragile — a concurrent session or sub-agent writing its own transcript can be
// newer than ours — which is exactly why the env var is preferred.
//
// Prints the uuid to stdout (exit 0), or a message to stderr (exit 1) when no
// session is found — in which case the caller should generate a fresh uuid.
//
// Usage: bun find-session.ts [--provider claude|codex|opencode] [projectPath]
// Defaults: provider=claude, projectPath=cwd.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { codexStateDb, excludeCodexSpawnedChildrenSql } from "./codex-db";

type Provider = "claude" | "codex" | "opencode";

type CodexThreadRow = {
  id: string;
};

type OpenCodeSessionRow = {
  id: string;
};

const UUID_RE = /^[0-9a-f-]{36}$/;

function parseArgs(argv: string[]): { provider: Provider; project: string } {
  let provider: Provider = "claude";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--provider") {
      const value = argv[++i];
      if (value === "claude" || value === "codex" || value === "opencode") {
        provider = value;
      } else {
        console.error(`find-session: invalid provider "${value}"`);
        process.exit(1);
      }
    } else {
      positionals.push(tok);
    }
  }
  return { provider, project: positionals[0] || process.cwd() };
}

function openCodeDb(): string {
  return (
    process.env.COCKPIT_OPENCODE_DB ||
    join(
      process.env.OPENCODE_DATA_DIR ||
        join(homedir(), ".local", "share", "opencode"),
      "opencode.db",
    )
  );
}

function findClaude(project: string): string | null {
  // Authoritative: the live session sets this. No mtime guessing needed.
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (fromEnv && UUID_RE.test(fromEnv)) return fromEnv;

  const encoded = project.replace(/[/.]/g, "-");
  const dir = join(homedir(), ".claude", "projects", encoded);

  if (!existsSync(dir)) {
    console.error(
      `find-session: no transcript dir for ${project}\n  (looked in ${dir})`,
    );
    return null;
  }

  let newest: { id: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const mtime = statSync(join(dir, name)).mtimeMs;
    const id = name.slice(0, -".jsonl".length);
    if (!newest || mtime > newest.mtime) newest = { id, mtime };
  }

  if (!newest) {
    console.error(`find-session: no .jsonl transcripts in ${dir}`);
    return null;
  }
  return newest.id;
}

function findCodex(project: string): string | null {
  const dbPath = codexStateDb();
  if (!existsSync(dbPath)) {
    console.error(`find-session: no Codex state database at ${dbPath}`);
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const excludeSpawnedChildren = excludeCodexSpawnedChildrenSql(db);
      const row = db
        .query(
          `select id
           from threads
           where cwd = ? and archived = 0 and rollout_path != ''
             ${excludeSpawnedChildren}
           order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
           limit 1`,
        )
        .get(project) as CodexThreadRow | null;
      if (!row?.id) {
        console.error(`find-session: no Codex thread for ${project}`);
        return null;
      }
      return row.id;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(
      `find-session: could not read Codex state (${(err as Error).message})`,
    );
    return null;
  }
}

function findOpenCode(project: string): string | null {
  const fromEnv =
    process.env.OPENCODE_SESSION_ID?.trim() ||
    process.env.OPENCODE_SESSION?.trim();
  if (fromEnv) return fromEnv;

  const dbPath = openCodeDb();
  if (!existsSync(dbPath)) {
    console.error(`find-session: no OpenCode database at ${dbPath}`);
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          `select id
           from session
           where directory = ? and time_archived is null
           order by time_updated desc
           limit 1`,
        )
        .get(project) as OpenCodeSessionRow | null;
      if (!row?.id) {
        console.error(`find-session: no OpenCode session for ${project}`);
        return null;
      }
      return row.id;
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(
      `find-session: could not read OpenCode database (${(err as Error).message})`,
    );
    return null;
  }
}

// Reusable resolver: returns the current session id, or null when none is found.
export function findSession(
  provider: Provider,
  project: string,
): string | null {
  if (provider === "codex") return findCodex(project);
  if (provider === "opencode") return findOpenCode(project);
  return findClaude(project);
}

// CLI entry — only runs when executed directly, so importers can reuse
// findSession() without triggering arg parsing or a process.exit.
if (import.meta.main) {
  const { provider, project } = parseArgs(process.argv.slice(2));
  const id = findSession(provider, project);
  if (!id) {
    process.exit(1);
  }
  console.log(id);
}
