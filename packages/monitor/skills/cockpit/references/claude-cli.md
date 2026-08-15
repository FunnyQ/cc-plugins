# Cockpit · Claude Code provider

Provider value: **`claude`**.

Read this once at Step 0. Then follow the selected mode reference, `pilot.md`
or `scribe.md`, using the three Claude-specific bits below. Everything else
is shared by that mode.

## Plugin root

`<plugin-root>` is the plugin's install directory. Use it as an **absolute
filesystem path** in every command. When this skill loads, Claude Code
prints:

```text
Base directory for this skill: <abs>/skills/cockpit
```

`<plugin-root>` is that printed path with the trailing `/skills/cockpit`
removed. Substitute the absolute `<abs>` literally into each command.

Do **not** write `${CLAUDE_PLUGIN_ROOT}` into a Bash command. The harness
substitutes that variable only inside the SKILL.md body it injects at load.
It never substitutes inside this reference file, which you read with the
Read tool. It never substitutes in the shell, where the variable is empty.
A bare `${CLAUDE_PLUGIN_ROOT}/skills/...` in the shell collapses to a broken
`/skills/...`. In a development checkout of this repository, use
`packages/monitor` from the repo root instead.

**Under OpenCode** (skip this paragraph otherwise): skills are installed at
`~/.config/opencode/skills/cockpit/` (symlinked by `opencode/install.ts`).
Resolve scripts from there: `bun ~/.config/opencode/skills/cockpit/scripts/…`.
`CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it, and OpenCode
prints no "Base directory for this skill" banner to read one from.

## Session id (Step 1)

```bash
bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider claude
```

This command returns the live session id from `CLAUDE_CODE_SESSION_ID`. This
env var is authoritative: the running session sets it. Only when the env var
is absent does the command fall back to the most-recently-touched transcript
under `~/.claude/projects/**/<id>.jsonl` for this project's cwd. If it exits
non-zero because no session was found, generate one with
`crypto.randomUUID()`. Note which id you used.

## Wait policy (needs_your_call)

Run `cockpit wait <id>` as a **background task**, with
`run_in_background: true`. Claude Code surfaces completed background-task
output back into the conversation. The session can stay parked until the user answers in the
dashboard. You are then re-invoked with the answer. Never block the
foreground on it.

The background task's exit code carries the outcome. On exit `4` nobody is
watching the cockpit — ask the same question with `AskUserQuestion`, then
record the answer with `cockpit send`. See "Nobody is watching" in `pilot.md`.

**Under OpenCode** (skip this line otherwise): a send goes over the TUI HTTP
path — `scripts/opencode-send.ts`, served at `/api/send-opencode-message` —
rather than the cockpit channel MCP server, which OpenCode never registers.
