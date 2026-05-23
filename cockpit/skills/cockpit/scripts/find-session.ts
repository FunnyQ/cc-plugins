#!/usr/bin/env bun
// Find the current Claude Code or Codex session id for a project.
//
// Claude Code stores each session's transcript at
//   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// where the project path is encoded by replacing "/" and "." with "-".
// The *current* session is the most-recently-modified transcript in that dir —
// and because invoking this script writes a tool-use line into the live
// transcript, that file is reliably the newest at the moment we look.
//
// Prints the uuid to stdout (exit 0), or a message to stderr (exit 1) when no
// transcript is found — in which case the caller should generate a fresh uuid.
//
// Usage: bun find-session.ts [--provider claude|codex] [projectPath]
// Defaults: provider=claude, projectPath=cwd.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

type Provider = "claude" | "codex";

type CodexThreadRow = {
  id: string;
};

function parseArgs(argv: string[]): { provider: Provider; project: string } {
  let provider: Provider = "claude";
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--provider") {
      const value = argv[++i];
      if (value === "claude" || value === "codex") provider = value;
      else {
        console.error(`find-session: invalid provider "${value}"`);
        process.exit(1);
      }
    } else {
      positionals.push(tok);
    }
  }
  return { provider, project: positionals[0] || process.cwd() };
}

function findClaude(project: string): string | null {
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

function codexDir(): string {
  return process.env.COCKPIT_CODEX_DIR || join(homedir(), ".codex");
}

function codexStateDb(): string {
  return (
    process.env.COCKPIT_CODEX_STATE_DB || join(codexDir(), "state_5.sqlite")
  );
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
      const row = db
        .query(
          `select id
           from threads
           where cwd = ? and archived = 0 and rollout_path != ''
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

const { provider, project } = parseArgs(process.argv.slice(2));
const id = provider === "codex" ? findCodex(project) : findClaude(project);
if (!id) {
  process.exit(1);
}
console.log(id);
