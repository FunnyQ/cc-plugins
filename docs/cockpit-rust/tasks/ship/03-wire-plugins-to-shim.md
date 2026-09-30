# SHIP-03: Wire plugins to the shim

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: ship/01, channel/02, server/03, server/05, server/06, server/07, server/08, cli/02, hooks/02
> **Blocks**: ship/04
> **Status**: done

## Goal

Every runtime launch of cockpit goes through `skills/cockpit/bin/cockpit`, never `bun …/cockpit/scripts/*.ts`. This covers Claude Code's MCP channel and hooks, Codex hooks, OpenCode hooks, the orphan reaper, and the install checks, so the Rust binary is what actually runs.

## Files to create / modify

- `packages/monitor/.claude-plugin/plugin.json` (modify) — mcpServers and the cockpit hooks point at the shim.
- `packages/monitor/.codex-plugin/hooks.json` (modify) — the cockpit hooks point at the shim.
- `opencode/plugin.ts` (modify) — the hook spawns run the shim.
- `opencode/plugin.test.ts` (modify) — assertions follow the new commands.
- `packages/monitor/skills/install/scripts/reap-stale.ts` (modify) — recognize Rust orphans.
- `packages/monitor/skills/install/scripts/reap-stale.test.ts` (modify) — cases for the new command lines.
- `packages/monitor/skills/install/scripts/setup.ts` (modify) — existence check plus a permission allow pattern for the shim.
- `packages/monitor/skills/install/scripts/setup.test.ts` (modify) — follow the setup.ts changes.

## Implementation notes

`<shim>` below means `<plugin root>/skills/cockpit/bin/cockpit`. It is a POSIX sh script: with `COCKPIT_BIN` set it execs that, otherwise it execs or downloads the release binary. A `hook` argument with no binary available exits 0 silently. It exports `COCKPIT_PLUGIN_ROOT` itself, so callers never set it.

### Claude `plugin.json`

Current:

```json
"mcpServers": { "cockpit-channel": { "type": "stdio", "command": "bun",
  "args": ["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit-channel.ts"] } }
```

Target:

```json
"mcpServers": { "cockpit-channel": { "type": "stdio",
  "command": "${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit", "args": ["channel"] } }
```

- Keep the server name `cockpit-channel` and the `channels` array unchanged. `monitor-up.ts` launches `claude --dangerously-load-development-channels plugin:monitor@q-lab-marketplace` by plugin coordinates and needs no edit. Confirm this by reading it and leave it untouched.
- Hooks:
  - SessionStart `bun "${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/decision-log-start.ts"` → `"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit" hook session-start`, timeout 5.
  - Stop `…/scribe-nudge.ts` → `"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit" hook stop`, timeout 10.
- **Leave the `setup.ts --session-check` hook on bun.** It belongs to install and is not part of cockpit.
- Do not touch `version`. The release bumps it.

### Codex `hooks.json`

Make the same two replacements with `${PLUGIN_ROOT}`. Keep the `setup.ts` line.

### `opencode/plugin.ts`

- Today: `DECISION_LOG_START` and `SCRIBE_NUDGE` constants hold repo-relative paths to the TS scripts, spawned as `["bun", join(root, …)]`.
- Target:
  - One constant `COCKPIT_SHIM = "packages/monitor/skills/cockpit/bin/cockpit"`.
  - Spawns `[join(root, COCKPIT_SHIM), "hook", "session-start"]` and `[join(root, COCKPIT_SHIM), "hook", "stop"]`.
  - The same stdin payloads as today: `{ session_id, cwd, provider: "opencode" }`.
- Keep the module's four rules:
  - single file
  - no import from anywhere else in the repo
  - root derived from `dirname(import.meta.dir)`
  - never reads a harness env var

  Passing no extra env is the right call: the shim derives `COCKPIT_PLUGIN_ROOT` from its own path.
- The shim path is a string literal. Do not add a copy of the shim's logic.
- `COMMENT_GUARD` and the guard spawn are unrelated. Leave them alone.
- Update `plugin.test.ts` wherever it asserts the spawned argv or the script constant. Any test that actually spawns the hook must set `COCKPIT_BIN` to a built or stub binary, so the test never downloads.

### `reap-stale.ts`

It finds orphaned channels and daemons by matching `ps` command lines. Two regexes matter:

- `monitorCacheRoot(installRoot)` matches `…/monitor/<x.y.z>/skills/(install|cockpit)/scripts(/|$)`. The install root passed in is still a scripts dir, so it is unchanged. Verify with a test rather than assuming.
- `monitorScriptVersion(command, cacheRoot)` extracts the version from `<cacheRoot>/<ver>/skills/cockpit/scripts/(cockpit-channel|cockpit-server).ts`. Extend it to also match the Rust processes. There are two command-line forms:
  - launched via the shim: `sh <cacheRoot>/<ver>/skills/cockpit/bin/cockpit channel|server`. The shim `exec`s, so this form lives only for the download window.
  - after exec: `<data home>/q-lab/cockpit/bin/<ver>/cockpit channel|server`, plus `server --no-open` / `--port N`. That path lies outside `cacheRoot`, so add a second pattern, `[/\\]q-lab[/\\]cockpit[/\\]bin[/\\](\d+\.\d+\.\d+)[/\\]cockpit\s+(?:channel|server)\b`, and return its version.
- Keep the old `.ts` pattern. Machines upgrading from 5.x still have Bun orphans on their first session.
- Add test rows for each form: old `.ts` channel, old `.ts` server, shim channel, exec'd `cockpit channel`, exec'd `cockpit server --no-open`. Add one negative: `cockpit log` must not match, because a CLI call is never reaped.

### `setup.ts`

- `CHANNEL_SCRIPT` points at `cockpit/scripts/cockpit-channel.ts` and is used as an existence check. It also backs a paste-able absolute path used in stale-entry cleanup. Replace the existence check with the shim path `cockpit/bin/cockpit`, and check `existsSync` plus the executable bit (`accessSync(p, constants.X_OK)`). Keep the stale `~/.claude.json` channel-entry cleanup, which removes old entries, and have it recognize both old and new command shapes.
- `SCRIPT_PERMISSIONS` pre-approves `Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)` and `… *)`. Skills will now run `<shim> log …` from Bash, and an un-allowlisted call deadlocks a nested sub-agent. Add:
  - `Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)`
  - `Bash(~/.config/opencode/skills/cockpit/bin/cockpit *)` — only if setup.ts already writes OpenCode-path patterns; otherwise skip it and note why.
  Keep the existing bun patterns, because other skills still use them. The drift watch reports missing `permissions.allow` patterns, so the new pattern must also be in whatever list the drift check compares against. Find that list by grepping `SCRIPT_PERMISSIONS` usages.
- Update `setup.test.ts` fixtures and expectations for both changes.

### Guardrails

- Do not delete any TS script in this change. Deletion is a separate, later step that greps importers first.
- Do not edit skill docs, commands, or CLAUDE.md here. The documentation sweep is a separate step.
- All new JSON stays 2-space indented and valid.

## Acceptance criteria

- [x] Claude `plugin.json` launches `cockpit-channel` as `${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit` with args `["channel"]`, and its SessionStart and Stop cockpit hooks run `… bin/cockpit" hook session-start` and `… hook stop` with timeouts 5 and 10.
- [x] Codex `hooks.json` carries the same two hook commands with `${PLUGIN_ROOT}`. The `setup.ts --session-check` hook is unchanged in both manifests.
- [x] `opencode/plugin.ts` spawns the shim with `hook session-start` and `hook stop`, still imports nothing from the repo, and reads no harness env var.
- [x] `reap-stale.ts` extracts the version from the old `.ts`, the shim, and the exec'd binary command lines for channel and server, and never matches a `cockpit log` CLI call.
- [x] `setup.ts` checks that the shim exists and is executable, and pre-approves the shim in `permissions.allow`, including the drift check's expected set.
- [x] No runtime launch of a cockpit TS script remains in the manifests, the OpenCode plugin, or the install scripts.

## Verification

- [x] `bun -e 'for (const f of ["packages/monitor/.claude-plugin/plugin.json","packages/monitor/.codex-plugin/hooks.json"]) JSON.parse(require("fs").readFileSync(f,"utf8")); console.log("json ok")'`
- [x] `! rg -n 'bun .*cockpit/scripts/(cockpit|cockpit-server|cockpit-channel|decision-log-start|scribe-nudge|find-session)\.ts' packages/monitor/.claude-plugin packages/monitor/.codex-plugin opencode/plugin.ts packages/monitor/skills/install/scripts --glob '!*.test.ts'`
- [x] `rg -n '"args": \[\s*"channel"' packages/monitor/.claude-plugin/plugin.json` finds the channel args, or an equivalent `bun -e` JSON assertion on `mcpServers["cockpit-channel"]`.
- [x] `bun test opencode/`
- [x] `bun test packages/monitor/skills/install/scripts/`
- [x] `bunx --bun tsc --noEmit | grep -E 'opencode/plugin|skills/install/scripts'` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A manifest still launches TS, JSON is invalid, or the install hook got moved | Manifests right, but reap-stale misses the exec'd binary or the permission pattern is absent from the drift set | Every launch goes through the shim; reaper covers old and new forms; setup check plus allow pattern consistent |
| Test coverage | ×2 | Tests not updated or failing | Manifests checked, reap-stale rows missing | Reap-stale rows for all 5 forms plus the negative, setup and opencode tests updated, no test downloads |
| Interface & readability | ×1 | Shim logic duplicated into plugin.ts | Constants left dangling | One shim constant, and the module rules of plugin.ts intact |
| Assumptions & docs | ×1 | Silent removal of the `.ts` patterns | Kept, but unexplained | One-line why for keeping `.ts` patterns (5.x orphans) and for the allow pattern (nested sub-agents) |

## Out of scope

- Deleting the TS scripts. Deferred to the cleanup step, which greps importers before each deletion.
- Rewriting skill docs, `commands/nudge.md`, and CLAUDE.md. Deferred to the documentation sweep that runs with the cleanup.
- Porting `setup.ts --session-check` itself. It belongs to install, not cockpit, and stays Bun.
