# LAUNCH-04: Registration + launcher

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: launch/02
> **Status**: in-progress

## Goal

Q can opt a session into the cockpit channel with one short command, and the
setup (the `~/.claude.json` entry) is documented and easy to apply.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/monitor-up.ts` (new) — a tiny launcher that execs `claude` with the channel flag.
- `packages/monitor/skills/cockpit/README.md` or `packages/monitor/skills/usage-dashboard/SKILL.md` (modify) — document the `~/.claude.json` entry + the launcher + the constraint.

## Implementation notes

### `~/.claude.json` registration (documentation, not auto-edit)

The channel is registered user-level so it's available in every project. Document
this snippet for Q to add under `mcpServers` (do **not** silently rewrite his
`~/.claude.json` from a task — show it and let him apply it, or have `monitor-up`
print it if missing):

```json
{
  "mcpServers": {
    "cockpit-channel": {
      "command": "bun",
      "args": ["/ABSOLUTE/PATH/TO/cc-plugins/packages/monitor/skills/cockpit/scripts/cockpit-channel.ts"]
    }
  }
}
```

Note: a plain `claude` does **not** load it — only `--dangerously-load-development-channels server:cockpit-channel` does. So registering it everywhere is safe; it's opt-in per launch.

### `monitor-up.ts` launcher

A thin wrapper so Q types `bun .../monitor-up.ts` (or an alias) instead of the long flag:

```ts
// exec: claude --dangerously-load-development-channels server:cockpit-channel  <passthrough args>
// Pass through any extra argv so `monitor-up --resume` etc. still work.
// Auto-start of the daemons is handled by the channel server itself — this
// script only assembles the claude invocation; it does not start servers.
```

Use `Bun.spawn`/`execvp`-style replacement so the user keeps an interactive
claude session in the foreground (inherit stdio). Keep it ~20 lines.

### README note

Document, concisely:
- The one-liner / alias (`alias cc='bun .../monitor-up.ts'`).
- That it requires Claude Code ≥ 2.1.80 and is a research-preview flag.
- The hard constraint: **the channel only attaches to sessions launched with it — you can't retro-attach to an already-running session.**
- That Codex sessions have no channel (observe-only).

## Acceptance criteria

- [ ] `monitor-up.ts` launches an interactive `claude` with `--dangerously-load-development-channels server:cockpit-channel`, inheriting stdio, passing through extra argv.
- [ ] The `~/.claude.json` `mcpServers` snippet is documented with an absolute path (or `monitor-up` prints it when the entry is missing).
- [ ] README documents the version requirement, the launch flag, the no-retro-attach constraint, and the Codex caveat.
- [ ] No task step silently edits the user's `~/.claude.json`.

## Verification

- [ ] Manual: after adding the `~/.claude.json` entry, `bun .../monitor-up.ts` opens a claude session; `/mcp` inside it lists `cockpit-channel` as connected.
- [ ] Manual: `alias cc='bun .../monitor-up.ts'` then `cc` works the same.

## Out of scope

- Auto-starting the daemons — the channel server does it; this launcher only assembles the `claude` command.
- Packaging the channel into `plugin.json` / the marketplace — deferred. Reason: `plugin.json` has no `mcpServers` field and channels aren't on the allowlist yet.
