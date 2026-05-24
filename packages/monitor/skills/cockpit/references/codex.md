# Cockpit · Codex provider

Provider value: **`codex`**.

Read this once at Step 0, then follow the shared `SKILL.md` procedure using the
three Codex-specific bits below. Everything else is shared.

## Plugin root

Resolve `<plugin-root>` from the installed skill root that contains this skill.
In a development checkout of this repository, substitute `packages/monitor` from
the repo root, for example `bun packages/monitor/skills/cockpit/scripts/...`.

## Session id (Step 1)

```bash
bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider codex
```

Reads `~/.codex/state_5.sqlite`, finds the latest non-archived thread for this
project's cwd, and uses its thread id. The thread row normally exists once the
session has written state, so if it exits non-zero, **retry once after a tool
call** before falling back to `crypto.randomUUID()`.

## Wait policy (needs_your_call)

Run `cockpit wait <id>` in the **foreground as a blocking tool call**, and do not
send the final response while it is waiting. The wait's stdout is the wake-up
signal: when the user clicks a dashboard option, the command prints the answer and this
same turn should continue from that answer.
