# Repo state — verified inventory

> Every fact here was checked against the working tree on 2026-08-15. Trust this file over memory or inference. If you find it contradicts the code, stop and report the contradiction rather than working around it.

## The 15 skills

Enumerated by the presence of a `SKILL.md`:

| Plugin | Skills |
|---|---|
| monitor | `usage-dashboard`, `cockpit`, `install` |
| dispatch | `preflight`, `flightplan`, `autopilot`, `waypoints` |
| relay | `relay` |
| chronicle | `adr`, `commit`, `pr`, `release`, `install` |
| herdr | `herdr`, `herdr-protocol-upgrade` |

`packages/monitor/skills/shared/` sits inside `skills/` but carries **no `SKILL.md` and is not a skill**. A `packages/*/skills/*` glob returns 16 entries and is wrong. Filter on `SKILL.md`.

## Cross-directory imports — load-bearing

Skills import out of their own directory:

```
packages/monitor/skills/cockpit/scripts/live-sessions.ts:12    → ../../shared/scripts/opencode
packages/monitor/skills/cockpit/scripts/find-session.ts:23     → ../../shared/scripts/opencode
packages/monitor/skills/usage-dashboard/scripts/api.ts:19      → ../../shared/scripts/opencode
packages/chronicle/skills/adr/scripts/archive-logs.ts:4        → ../../../shared/scripts/cockpit-trail
packages/chronicle/skills/pr/scripts/analyze-branch.ts:11      → ../../../shared/scripts/cockpit-trail
```

The symlink-per-skill install model only works if the runtime resolves an entry symlink to its realpath. This is recorded as a runtime fact, not an assumption — check it before relying on it.

## The six Claude hook blocks

Across three `.claude-plugin/plugin.json` files. `packages/monitor/.codex-plugin/hooks.json` mirrors the monitor pair for Codex and needs no separate port.

| Plugin | Hook | Command | Ported to OpenCode? |
|---|---|---|---|
| monitor | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup.ts --session-check` | **No** — see below |
| monitor | `SessionStart` (same matcher) | `skills/cockpit/scripts/decision-log-start.ts` | Yes → `session.created` |
| monitor | `Stop` | `skills/cockpit/scripts/scribe-nudge.ts` | Yes → `session.idle` |
| chronicle | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup-spawn-depth.ts --session-check` | **Moved** — becomes the installer's `subagent_depth` write |
| chronicle | `PreToolUse` (matcher `Bash`) | `hooks/check-branch.sh` | Yes → `tool.execute.before` |
| dispatch | `PostToolUse` (matcher `Edit\|Write`) | `hooks/flightplan-lint.sh` | Yes → `tool.execute.after` |

**`setup.ts --session-check` is dead code under OpenCode.** `packages/monitor/skills/install/scripts/setup.ts:357-358` returns immediately when `CLAUDE_PLUGIN_DATA` is unset, which it always is outside Claude Code. Even past that gate its work is statusline-path migration and reaping orphaned Claude processes (`setup.ts:370-408`) — both Claude-only, and the statusline is an explicit non-goal. Do not port it.

## The two shell hooks — invocation contract

Both read a JSON payload on **stdin** and are directly callable:

- `packages/chronicle/hooks/check-branch.sh` — reads `.tool_input.command` (line 10). On a violation it prints `{"hookSpecificOutput":{"permissionDecision":"ask"},"systemMessage":"…"}` and exits 0. On no violation it prints nothing and exits 0. Fails open when `jq` is missing or the payload is unparseable. It runs its own `git branch --show-current` and reads `.chronicle/pr.json` itself.
- `packages/dispatch/hooks/flightplan-lint.sh` — reads `.tool_input.file_path` (line 21). Silent exit 0 when the path or the `Required reading` header does not match. On violations it writes to **stderr** and exits **2**. It resolves `lint-task.ts` relative to itself when `CLAUDE_PLUGIN_ROOT` is empty (lines 44-47), so it works when invoked directly.

## `scribe-nudge.ts` output shape

`packages/monitor/skills/cockpit/scripts/scribe-nudge.ts:226` switches its output on `process.env.PLUGIN_ROOT` (the Codex marker):

```ts
JSON.stringify(buildHookOutput(reminder, Boolean(process.env.PLUGIN_ROOT)))
```

Under OpenCode neither harness variable is set, so it emits the Claude hook-JSON shape. A caller that assumes plain text will surface raw JSON to the user.

## The 13 chronicle agents

In `packages/chronicle/agents/*.md`, Claude frontmatter format:

```yaml
---
name: lawspeaker
description: "Chronicle's Lawspeaker. Owns the commit flow — …"
model: sonnet          # sonnet | haiku
effort: medium         # optional: low | medium | high
tools: ["Agent", "Read", "Write"]
maxTurns: 15           # present on the three orchestrators only
---
```

| Agent | model | effort | tools | maxTurns |
|---|---|---|---|---|
| `lawspeaker` | sonnet | medium | Agent, Read, Write | 15 |
| `lorekeeper` | sonnet | medium | Agent, Read | 15 |
| `storykeeper` | sonnet | medium | Agent, Read | 15 |
| `watcher` | haiku | low | Bash, Read, Write | — |
| `runesmith` | haiku | low | Bash, Read | — |
| `skald` | sonnet | — | Bash, Read | — |
| `messenger` | haiku | low | Bash, Read | — |
| `gleaner` | haiku | low | Bash, Read | — |
| `reckoner` | sonnet | high | Bash, Read | — |
| `codifier` | sonnet | high | Bash, Read | — |
| `barrowkeeper` | haiku | low | Bash, Read, Write | — |
| `skirnir` | haiku | low | Bash, Read | — |
| `annalist` | sonnet | — | Bash, Read, Edit, Write | — |

Which skill spawns which:

- commit → `lawspeaker` → `watcher`, `runesmith`
- pr → `storykeeper` → `skald`, `messenger`
- adr → `lorekeeper` → `gleaner`, `reckoner`, `codifier`, `barrowkeeper`
- release → `skirnir`, `annalist` (spawned by the skill directly)

The deepest chain is skill → orchestrator → child, which is why `subagent_depth ≥ 2` is required.

## The two monitor commands

`packages/monitor/commands/{nudge,thoughtful}.md`. They are Claude-bound in **different** ways:

- `nudge.md:11` interpolates `${CLAUDE_PLUGIN_ROOT}` in its bash block. Frontmatter carries `description` and `argument-hint`.
- `thoughtful.md` never mentions `CLAUDE_PLUGIN_ROOT`. Its Claude dependency is the Agent tool's `subagent_type: "fork"` (lines 19-26), and it already carries a separate Codex section using `fork_context: true` plus `--provider codex`. Frontmatter carries `description` only.

## OpenCode support that already exists — do not rebuild

| Surface | State |
|---|---|
| usage-dashboard | reads `~/.local/share/opencode/opencode.db` via `packages/monitor/skills/shared/scripts/opencode.ts` |
| cockpit reads | `packages/monitor/skills/cockpit/scripts/transcript-stream.ts` has an `opencode` provider |
| cockpit **sends** | `packages/monitor/skills/cockpit/scripts/opencode-send.ts`, wired at `cockpit-server.ts:227` as `/api/send-opencode-message`. Discovers the TUI server from `OPENCODE_TUI_SERVER_URL` / `OPENCODE_SERVER_URL` or a `ps` scan for `opencode --port <n>`; health-checks `/global/health`; verifies `/session/<id>`; delivers via `/tui/append-prompt` then `/tui/submit-prompt`. **Precondition: the TUI must have been started with a port.** |
| relay | complete OpenCode backend at `packages/relay/skills/relay/scripts/backends/opencode.ts` — `delegate` and `review` supported, `image` gated off |
| herdr | `packages/herdr/skills/herdr/scripts/herd.ts` detects and spawns OpenCode panes. Note the agent kind is typed as plain `string` at lines 63 and 77; `claude|codex|opencode` appears only in comments and is validated nowhere. |

## Legacy install path that collides

`README.md:261` currently instructs:

```bash
ln -s "$(pwd)/packages/relay/skills/relay" ~/.claude/skills/relay
```

OpenCode scans `~/.claude/skills/` as well as `~/.config/opencode/skills/`, so a user who followed that line ends up with two skills named `relay` after installing. The installer's `--check` must warn about it, and the README must mark that line legacy.

## Workflow config

- `.chronicle/pr.json` → `{"workflow": "github-flow", "base": "main"}`. This is what `check-branch.sh` reads.
- `.chronicle/release.json` — untouched by this build.
