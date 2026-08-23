// Where Claude Code keeps its per-session state. The env overrides exist so
// tests (and a fixture-pointed dev daemon) can redirect the whole tree.
//
// One home for both resolvers: while each consumer built its own copy,
// find-session.ts hardcoded the projects path and honoured no override, so a
// fixture-pointed run read the real $HOME and reported "no session found"
// instead of failing loudly. Counterpart to codex-db.ts's codexDir().
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeProjectsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR ||
    join(homedir(), ".claude", "projects")
  );
}

export function claudeSessionsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR ||
    join(homedir(), ".claude", "sessions")
  );
}
