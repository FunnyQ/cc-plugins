import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openCodeDb } from "../../shared/scripts/opencode";

export const HOME = homedir();
export const CLAUDE_DIR = join(HOME, ".claude");
export const CODEX_DIR = join(HOME, ".codex");
export const OPENCODE_DB = openCodeDb();
export const OPENCODE_DIR = dirname(OPENCODE_DB);
export const OPENCODE_STORAGE_DIR = join(OPENCODE_DIR, "storage");
export const OPENCODE_PROJECT_DIR = join(OPENCODE_DIR, "project");
export const CODEX_STATE_DB = join(CODEX_DIR, "state_5.sqlite");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
export const CODEX_AUTH = join(CODEX_DIR, "auth.json");
export const STATS_CACHE = join(CLAUDE_DIR, "stats-cache.json");
export const HISTORY = join(CLAUDE_DIR, "history.jsonl");
export const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
export const PROJECTS_DIR =
  process.env.TOKEN_ATLAS_PROJECTS_DIR || join(CLAUDE_DIR, "projects");
