# Cockpit · Codex provider

Provider value: **`codex`**.

Read this once at Step 0. Then follow the selected mode reference,
`pilot.md` or `scribe.md`, using the three Codex-specific bits below.
Everything else is shared by that mode.

## Plugin root

Resolve `<plugin-root>` from the installed skill root that contains this
skill. In a development checkout of this repository, substitute
`packages/monitor` from the repo root. For example:
`bun packages/monitor/skills/cockpit/scripts/...`.

## Session id (Step 1)

```bash
bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider codex
```

This command reads `~/.codex/state_5.sqlite`. It finds the latest
non-archived thread for this project's cwd and uses its thread id. The
thread row normally exists once the session has written state. If it exits
non-zero, **retry once after a tool call** before falling back to
`crypto.randomUUID()`.

Do not run this resolver inside the fork. The fork can have its own newer
Codex thread, and spawn-edge bookkeeping is not a reliable parent handoff.

For thoughtful auto-logging, the main agent must run this command **before**
it spawns the background fork. The main agent must include the resulting
literal id in the fork prompt. The fork must pass that id as
`--session <parent-session-id>` on every scribe call.

## Wait policy (needs_your_call)

Run `cockpit wait <id>` in the **foreground as a blocking tool call**. Do
not send the final response while it is waiting. The wait's stdout is the
wake-up signal. When the user clicks a dashboard option, the command prints
the answer. This same turn should then continue from that answer.
