# /cockpit restart

Bounce the cockpit dashboard daemon onto **this install's code**. Use it after a
plugin update, a `/monitor:install`, or a working-tree edit to any cockpit
script — the running daemon keeps serving the code it booted with, so a plain
re-run of `cockpit-server.ts` from the same install just reuses it and changes
nothing.

## Step 1 — Restart

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts restart
```

Optional flags: `--port <n>` (when the daemon runs off 5858), `--no-open` (skip
the browser, e.g. when the user only wants the daemon refreshed).

Run it in the **foreground** — it kills the live daemon, rebinds from the install
you invoked it from, and verifies our root won the port before returning, so it
must not be backgrounded. A Claude session with the cockpit channel keeps
respawning the daemon whenever it dies; `restart` supersedes and retries past
that race rather than losing the port to a stale install.

## Step 2 — Report

- Exit `0` → tell the user the daemon is now on this install's code and give the
  URL it printed (default `http://localhost:5858`).
- Exit non-zero → it could not confirm a fresh daemon from this install; another
  install is contending for the port. Retry once. If it still fails, tell the
  user to restart the Claude session so its channel MCP loads the updated plugin.

## Caveat — the channel MCP is a separate process

`restart` refreshes the **daemon** (dashboard, transcript stream, wait/send
broker). It does **not** refresh the cockpit **channel MCP server** of an already
running Claude session — that process was spawned from whatever plugin cache the
session started with. If the fix the user is chasing lives in
`cockpit-channel.ts`, the daemon restart is not enough: they need to restart the
session itself. Say so plainly rather than implying the update fully landed.

## Notes

- `<plugin-root>` is an **absolute filesystem path** resolved per your provider
  reference (Step 0). Never type `${CLAUDE_PLUGIN_ROOT}` into a Bash command.
- Restart from the install whose code you want to serve. Running the repo's
  `cockpit.ts` serves the repo; running the plugin cache's serves the cache.
