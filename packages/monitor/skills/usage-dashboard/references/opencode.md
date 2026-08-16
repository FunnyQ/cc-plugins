# Usage dashboard under the OpenCode harness

## Script root

`<plugin-root>/skills/usage-dashboard` is
`~/.config/opencode/skills/usage-dashboard`. `CLAUDE_PLUGIN_ROOT` is empty and
there is no skill base-directory banner, so state the path literally:
`bun ~/.config/opencode/skills/usage-dashboard/scripts/…`.

## OpenCode usage data needs no integration

The dashboard already reads OpenCode **natively**, from
`${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db` through the shared
reader at `packages/monitor/skills/shared/scripts/opencode.ts`. Nothing has to
be installed for OpenCode sessions, tokens, and cost to show up. If they are
missing, the cause is the database, not a missing integration.

## Background launch

OpenCode's bash tool has no background-run parameter — none exists to pass.
Detach at the shell instead:

```bash
bun ~/.config/opencode/skills/usage-dashboard/scripts/atlas-server.ts … &
```

This is the same `… &` fallback the "Run" section of `SKILL.md` already gives
for any harness with no background flag; OpenCode is that harness. A foreground
call blocks the session for as long as the server runs.
