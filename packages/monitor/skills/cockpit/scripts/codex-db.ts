import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export function codexDir(): string {
  return process.env.COCKPIT_CODEX_DIR || join(homedir(), ".codex");
}

export function codexStateDb(): string {
  return (
    process.env.COCKPIT_CODEX_STATE_DB || join(codexDir(), "state_5.sqlite")
  );
}

export function resolveCodexPath(path: string): string {
  return isAbsolute(path) ? path : resolve(codexDir(), path);
}

export function hasCodexSpawnEdges(db: Database): boolean {
  const row = db
    .query(
      `select 1 as ok
       from sqlite_master
       where type = 'table' and name = 'thread_spawn_edges'
       limit 1`,
    )
    .get() as { ok: number } | null;
  return row !== null;
}

export function excludeCodexSpawnedChildrenSql(db: Database): string {
  return hasCodexSpawnEdges(db)
    ? `and not exists (
         select 1
         from thread_spawn_edges e
         where e.child_thread_id = threads.id
       )`
    : "";
}
