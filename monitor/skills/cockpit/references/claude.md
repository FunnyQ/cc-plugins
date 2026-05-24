# Cockpit · Claude Code provider

Provider value: **`claude`**.

Read this once at Step 0, then follow the shared `SKILL.md` procedure using the
three Claude-specific bits below. Everything else is shared.

## Plugin root

Use `${CLAUDE_PLUGIN_ROOT}` when installed as a plugin. In a development checkout
of this repository, `${CLAUDE_PLUGIN_ROOT}` is empty (and is also empty in an
ad-hoc shell), so substitute `monitor` from the repo root instead, for example
`bun monitor/skills/cockpit/scripts/...`.

## Session id (Step 1)

```bash
bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider claude
```

Returns the live session id from `CLAUDE_CODE_SESSION_ID` (authoritative —
set by the running session). Only when that env var is absent does it fall back
to the most-recently-touched transcript under `~/.claude/projects/**/<id>.jsonl`
for this project's cwd. If it exits non-zero (no session found), generate one
with `crypto.randomUUID()` and note which id you used.

## Wait policy (needs_your_call)

Run `cockpit wait <id>` as a **background task** (`run_in_background: true`).
Claude Code surfaces completed background-task output back into the conversation,
so the session can stay parked until the user answers in the dashboard, after which you
are re-invoked with the answer. Never block the foreground on it.
