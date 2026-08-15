# /cockpit restart

Bounce the cockpit dashboard daemon onto **this install's code**. Use it
after a plugin update, a `/monitor:install`, or a working-tree edit to any
cockpit script. The running daemon keeps serving the code it booted with. A
plain re-run of `cockpit-server.ts` from the same install reuses the running
daemon and changes nothing.

## Step 1 — Restart

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts restart
```

Optional flags: `--port <n>` sets the port, for when the daemon runs off
5858. `--no-open` skips the browser, for when the user only wants the daemon
refreshed.

Run it in the **foreground**. Do not background it. It kills the live
daemon and rebinds from the install you invoked it from. It verifies that
our root won the port before it returns.

A Claude session with the cockpit channel keeps respawning the daemon
whenever the daemon dies. `restart` supersedes that respawn and retries past
the race. It does not lose the port to a stale install.

## Step 2 — Report

- Exit `0`: tell the user the daemon now runs this install's code. Give the
  URL it printed, default `http://localhost:5858`.
- Exit non-zero: it could not confirm a fresh daemon from this install.
  Another install is contending for the port. Retry once. If it still fails,
  tell the user to restart the Claude session so its channel MCP loads the
  updated plugin.

## Caveat — the channel MCP is a separate process

`restart` refreshes the **daemon**: the dashboard, the transcript stream,
and the wait/send broker. It does **not** refresh the cockpit **channel MCP
server** of an already running Claude session. That process was spawned
from whatever plugin cache the session started with.

If the fix the user is chasing lives in `cockpit-channel.ts`, the daemon
restart is not enough. The user needs to restart the session itself. Say so
plainly. Do not imply that the update fully landed.

## Notes

- `<plugin-root>` is an **absolute filesystem path** resolved per your provider
  reference (Step 0). Never type `${CLAUDE_PLUGIN_ROOT}` into a Bash command.
- Restart from the install whose code you want to serve. The repo's
  `cockpit.ts` serves the repo. The plugin cache's `cockpit.ts` serves the
  cache.

**Under OpenCode** (skip this paragraph otherwise): skills are installed at
`~/.config/opencode/skills/cockpit/` (symlinked by `opencode/install.ts`).
Resolve scripts from there: `bun ~/.config/opencode/skills/cockpit/scripts/…`.
`CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it, and OpenCode
prints no "Base directory for this skill" banner to read one from.
