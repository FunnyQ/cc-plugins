# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What This Is

`q-lab-marketplace` — a plugin marketplace for Claude Code, Codex, and OpenCode. It holds five plugins. Each plugin ships to Claude Code and Codex and versions independently; OpenCode is a third runtime layered on top of the same skills (see `opencode/` below), versioned with none of them.

| Plugin | Purpose | Skills |
| --- | --- | --- |
| **monitor** | Usage analytics + live session cockpit | `usage-dashboard`, `cockpit`, `install` |
| **dispatch** | Interview-driven planning and execution | `preflight`, `flightplan`, `autopilot`, `waypoints` |
| **relay** | Delegate a task to another harness CLI | `relay` |
| **chronicle** | ADR curation, commit, PR/MR, and release automation | `adr`, `commit`, `pr`, `release`, `install` |
| **herdr** | Reference + agent orchestration for the Herdr terminal | `herdr`, `herdr-browser`, `herdr-protocol-upgrade` |

Read the plugin's own `skills/*/SKILL.md` for its contract. This file documents only what no `SKILL.md` covers: the repo layout, monitor's dashboard internals, and the release rules.

### Plugin summaries

**dispatch** — four tiers of planning. `preflight` writes a lightweight spec in conversation. `flightplan` writes `docs/<slug>/PLAN.md` plus a `tasks/` tree to disk for later sub-agents. `autopilot` executes that tree through the Workflow tool: a per-task dev→verify→judge→score loop gated on each task's `## Eval rubric`, then a closing `Final review` task. It leaves a self-gitignored `docs/<slug>/.flightlog/` audit trail. `waypoints` sits above flightplan: it writes `docs/<proj>/WAYPOINTS.md` and a `waypoints.ts` CLI (`active` / `leg-scaffold` / `advance`), so each leg gets its flightplan just-in-time after the previous leg lands.

**relay** — `/relay <codex|opencode|claude> <delegate|review|image>`. A backend-agnostic mode layer sits over a per-harness strategy layer. The capability matrix makes `image` codex-only.

**chronicle** — `adr`, `commit`, and `pr` share one topology: thin `SKILL.md` → nested no-Bash orchestrator → cheap child agents. `adr` triages the cockpit decision trail and promotes decisions into Architecture Decision Records. `commit` and `release` put a deterministic engine under that topology, so the orchestrator keeps only the judgment a script cannot make. `commit` is `scripts/commit.ts` — `propose` validates the watcher's groups and settles simple-vs-atomic, `apply` stages, commits, and verifies off one plan file, re-reading how much already landed from the log so an interrupted run resumes. Both agent hand-offs are files, never replies: the watcher writes its groups to a proposal path the Lawspeaker dictates, so a child answering in prose costs nothing. The Lawspeaker owns the flow: the watcher is the only party that reads the diff and proposes groups already in commit order, the Lawspeaker checks that order and writes the plan file's prose from `contextBrief`, and the runesmith runs `apply`. `release` is a script, `scripts/release.ts`, driving an ordered list of stages that each detect whether they have already happened, so a run resumes wherever the last one stopped. Its agents are the skirnir, which runs the scripts so their output stays out of the conversation, and the annalist, which writes the CHANGELOG entry. It stays config-first — the whole-repo versus per-component shape lives in a committed `.chronicle/release.json`.

**monitor** — `usage-dashboard` is the rear-view: a local web dashboard for sessions, tokens, cost, model mix, and project activity. `cockpit` is the windshield: a live decision trail, transcript, and a `needs_your_call` wait/send bridge for running sessions. `install` owns every prerequisite check and config write for the whole plugin.

The dashboard and the cockpit run independent servers on separate ports with separate `dist/` SPAs. Only the plugin packaging is shared.

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # Claude registry (all five plugins; no version field)
├── .agents/plugins/marketplace.json  # Codex registry (all five plugins; no version field)
├── .chronicle/release.json           # release shape: per-component versions + version-file patterns
├── CHANGELOG.md                      # Keep a Changelog format, per-plugin headings
├── packages/
│   ├── monitor/
│   │   ├── .claude-plugin/plugin.json    # manifest + SessionStart hooks + cockpit channel
│   │   ├── .codex-plugin/{plugin,hooks}.json  # mirrors the Claude hooks
│   │   ├── commands/                     # thoughtful.md, nudge.md
│   │   └── skills/
│   │       ├── usage-dashboard/
│   │       │   ├── PRODUCT.md            # design direction — Sunrise Atlas
│   │       │   ├── scripts/
│   │       │   │   ├── api.ts            # data engine → buildStats()
│   │       │   │   ├── rollup-db.ts      # bun:sqlite schema + accessors
│   │       │   │   ├── rollup-update.ts  # incremental transcript ingest
│   │       │   │   ├── live.ts           # active sessions, both providers
│   │       │   │   ├── atlas-server.ts   # Bun HTTP server, port 5938
│   │       │   │   └── statusline-collector.ts
│   │       │   ├── dashboard/dist/       # committed SPA, no build step
│   │       │   └── references/pricing-defaults.json
│   │       ├── cockpit/
│   │       │   ├── SKILL.md              # router only
│   │       │   ├── PRODUCT.md / DESIGN.md  # brand + Night Flight design system
│   │       │   ├── references/           # pilot / scribe / restart / claude-cli / codex
│   │       │   ├── scripts/
│   │       │   │   ├── cockpit-server.ts # Bun daemon, port 5858
│   │       │   │   ├── cockpit.ts        # CLI: log / scribe / prep / wait / send / config / nudge / restart
│   │       │   │   ├── cockpit-channel.ts    # channel MCP server (stdio)
│   │       │   │   ├── codex-control-probe.ts
│   │       │   │   ├── log-root.ts       # per-repo trail anchoring
│   │       │   │   └── config.ts
│   │       │   └── dashboard/dist/
│   │       ├── install/scripts/
│   │       │   ├── setup.ts              # plugin-wide check + wire (--check/--dry-run/--apply/--session-check)
│   │       │   ├── install.ts            # dashboard precheck
│   │       │   ├── setup-statusline.ts
│   │       │   └── statusline-decision.ts    # pure decision, unit-tested
│   │       └── shared/scripts/           # imported by BOTH dashboards — extend, never duplicate
│   │           ├── opencode.ts           # OpenCode DB reader
│   │           ├── path-inside.ts
│   │           └── static-server.ts
│   ├── dispatch/
│   │   ├── hooks/flightplan-lint.sh      # PostToolUse, path + content gated
│   │   └── skills/{preflight,flightplan,autopilot,waypoints}/
│   │       # flightplan/scripts/ also hosts autopilot's shared tools:
│   │       # next-ready / score-task (--log) / flightlog
│   ├── chronicle/
│   │   ├── shared/scripts/               # code imported by more than one skill
│   │   ├── agents/                       # lawspeaker+watcher+runesmith (commit) / storykeeper+skald+messenger /
│   │   │                                 # lorekeeper+gleaner+reckoner+codifier+barrowkeeper / skirnir+annalist (release)
│   │   ├── agents-codex/                 # Codex agent definitions (TOML format)
│   │   ├── hooks/check-branch.sh         # PreToolUse, guards commits on main/master
│   │   └── skills/{adr,commit,pr,release,install}/
│   ├── relay/
│   │   ├── commands/                     # backend-fixed aliases: codex / opencode / claude-cli
│   │   └── skills/relay/
│   │       ├── references/backends.md
│   │       └── scripts/
│   │           ├── relay.ts              # entry: relay <backend> <mode> [flags]
│   │           ├── relay-prompt.ts       # pure formatPrompt + file-contract helpers
│   │           ├── live.ts               # herdr live-pane layer (dynamic import)
│   │           ├── context-collector.ts / shared.ts / types.ts
│   │           └── backends/             # gate.ts (pure) + index.ts + codex/opencode/claude
│   └── herdr/skills/
│       ├── herdr/
│       │   ├── references/               # config / cli / plugin-development / agent-orchestration
│       │   └── scripts/herd.ts           # typed Bun wrapper: spawn/send/keys/wait/read/list/close
│       ├── herdr-browser/scripts/browser.ts  # browser pane + CDP driver: open/text/snapshot/watch/endpoint
│       └── herdr-protocol-upgrade/       # raises a plugin's minimum-protocol constant
└── opencode/                          # OpenCode runtime layer — repo infra, outside packages/, owns no version
    ├── plugin.ts                          # the OpenCode plugin module (single file, no repo imports)
    ├── plugin.test.ts
    ├── install.ts                         # --check | --dry-run | --apply | --unlink
    ├── install.test.ts
    ├── agents/                            # 13 chronicle agents in OpenCode frontmatter (committed)
    ├── commands/                          # nudge.md + thoughtful.md in OpenCode format (committed)
    └── references/opencode-runtime.md     # the runtime spike log, written by hand before the tree ran
```

Every `packages/<plugin>/` holds both a `.claude-plugin/plugin.json` and a `.codex-plugin/plugin.json`.

## Monitor: dashboard internals

### Data flow

1. `api.ts` reads three providers: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, and `~/.claude/projects/**/*.jsonl`; `~/.codex/state_5.sqlite` and `~/.codex/sessions/`; and `~/.local/share/opencode/opencode.db` through `skills/shared/scripts/opencode.ts`.
2. Pricing resolves in order: bundled defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`.
3. `atlas-server.ts` serves `dashboard/dist/` and exposes `GET /api/stats` and `GET /api/live`. It binds `127.0.0.1`.
4. The frontend fetches `/api/stats` on load and renders with petite-vue and Chart.js.

### Usage rollup DB

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The rollup DB makes token history outlive that deletion.

- `parseTranscriptUsage()` calls `updateRollup()` then `readRollupAggregates()`. The four aggregate maps and `projectTokens` come from the rollup. The `ledger` and file count stay on the live walk. If the DB is unavailable, the live-walk maps take over.
- `rollup-update.ts` tail-parses each transcript from `ingested_files.bytes_parsed` at UTF-8-safe newline boundaries, dedups billing across runs through `seen_requests`, and upserts additively into `usage_hourly(hour_ms, project, model)`.
- The rollup stores **tokens only**. Cost stays a downstream computation, so price corrections apply retroactively.
- `hour_ms` is the local hour start. It matches `hourStartMs`, so daily and heatmap reconstruction is byte-identical.
- Triggers: the dashboard load (primary) and a detached, 5-minute-throttled `nudgeRollup()` from `statusline-collector.ts` (secondary). There is no daemon.
- A file shrinking below `bytes_parsed` forces a full rebuild. Deleted files are pruned from `ingested_files` and `seen_requests`; `usage_hourly` keeps its tokens. A `meta.schema_version` bump triggers a destructive rebuild, which is always safe because the rollup is fully derived.
- The DB lives at `~/.local/share/q-lab/token-atlas/rollup.db`, outside dotfile sync.

### Live sessions panel

`GET /api/live` returns active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy` / `idle` / `waiting`, stale-filtered at 10 minutes) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred` / `recent`). The panel polls every 3 seconds and pauses while the tab is hidden.

Clicking a row calls `openInCockpit(session)`. The port comes from `/api/live`'s `cockpitPort`, read from `~/.local/share/q-lab/cockpit/daemon.json`, falling back to `5858`. Rows stay inert while `cockpitUp` is false. usage-dashboard renders no transcript — cockpit's `transcript-stream.ts` and `modules/transcript.js` are the single source.

### Key design decisions

- **No build step.** `dashboard/dist/` is committed as-is, vendor libs included.
- **Bun-only runtime.** Uses `bun:sqlite`, `Bun.serve`, `Bun.file`.
- **Namespaced model keys** — `provider:model`, e.g. `claude:claude-opus-4-7`.
- **Billing dedup** by `requestId:messageId`. The shared key lives in `dedup.ts`; the rollup ingest reuses it.
- **Theme** — light and dark through `[data-theme]` on `<html>`. Tokens are defined twice in `style.css`. The toggle cross-fades with the View Transitions API.
- **Sunrise Bloom** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` / `.live-panel` carry a radial-gradient bloom. `installBloomTracker()` lerps `--bloom-x/--bloom-y` toward the cursor each frame. Register a new panel class in **both** the CSS selector list and the JS `SELECTOR` constant.
- **Hero wave** — `.hero-band` masks with a 200%-wide SVG holding two identical wave cycles. `hero-wave-drift` slides `mask-position-x` one wavelength for a seamless loop.

## Cockpit constraints

These rules are not obvious from the code. Break one and the failure is silent.

**Anchor the decision trail per repo, never per cwd.** `log-root.ts` walks up from cwd for an existing `.cockpit/`, bounded by the git root, then falls back to the git root, then to cwd outside a repo. An agent that cd'd into `frontend/` still logs to the root trail. A hand-made `packages/x/.cockpit` keeps its own. **The walk-up must never cross the git root** — `~/.cockpit` is a real leftover of the pre-XDG cockpit home, and an unbounded walk would collapse every repo under `$HOME` into one trail.

**Resolve sessions by raw cwd.** `find-session` looks sessions up by cwd. For a tracked session, the registry entry's absolute `logPath` is authoritative in `log-stream.ts`, `project-info.ts`, and `design-system.ts` — not the request's `project` param.

**Keep cockpit config global.** It lives at `~/.config/q-lab/cockpit/config.json`: the decision-log language and the scribe-nudge preferences. Per-project nudge opinions live keyed by project root inside that one file. Never write a repo dotfile.

**Gate `needs_your_call` on presence.** The TUI is the default asking surface. `cockpit wait` passes `require_watcher=1`, and `/api/wait` refuses with `{not_watching:true, reason}` (CLI exit `4`) unless two factors hold:

1. **Intent** — the user's explicit `answer_here` switch. Global, default off, in the XDG config. Set it from the dashboard toggle, `cockpit config --answer-here on|off`, or `GET/POST /api/answer-here`.
2. **Liveness** — `hasVisibleSubscriber()` in `permission.ts` sees a live permission-stream subscriber for that session.

Place the gate **after** the stash drain and the superseded check, so a fast answer still lands and a moot call still reports `superseded`.

Do not infer intent from visibility. `document.hidden` stays false when another app covers the browser — verified: a minimized window still reports the tab visible. Liveness alone is also not enough: with the switch on and no tab connected, a park hangs forever.

**Leave the permission relay ungated.** Its protocol is notification-based and the terminal prompt stays live beside the cockpit card, so it already defaults to the TUI.

**Route sends by provider.** Claude sends use the cockpit channel MCP server. Codex sends use the managed Codex remote-control app-server socket, with direct app-server as fallback. OpenCode sends use the TUI HTTP bridge (`opencode-send.ts`): the running TUI is discovered from `OPENCODE_TUI_SERVER_URL` or a `ps` scan for `opencode --port <n>` (a `serve` process is excluded from that scan), then delivered through `/tui/append-prompt` followed by `/tui/submit-prompt`. The channel is UI→agent only; the agent's answers ride the transcript.

## Harness constraints

**Chronicle needs nested subagent spawning.** Claude Code 2.1.217 disabled it by default. Without `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (chronicle needs `2`), every orchestrator fails with `Agent exists but is not enabled in this context`. The `chronicle:install` skill owns this: a `SessionStart` hook runs `setup-spawn-depth.ts --session-check`, writes the value into `~/.claude/settings.json` when missing or too low (it only ever raises), and asks the user to restart. The env var is read at session start, so the writing session still runs without it. OpenCode carries the identical requirement under a different name: `subagent_depth` in `~/.config/opencode/opencode.json`, also needing at least `2` — it ships defaulting to `1`, which blocks nesting outright. There is no session hook to write it; `opencode/install.ts --apply` raises it instead, same raise-only rule, same silent-stop failure mode if it's skipped.

**opencode runtime layer.** All OpenCode-facing code lives in `opencode/` at the repo root, deliberately outside `packages/`, so the two-manifests-per-package invariant and the release config stay untouched — `opencode/` versions nothing and ships in no plugin. Install is symlinks, not copies: `opencode/install.ts --apply` links the 16 skills, the plugin module, the 13 chronicle agents, and the 2 monitor commands into `~/.config/opencode/`, with the checkout as the single source of truth — an edit lands live, no reinstall — plus the one `subagent_depth` config edit above.

Hook parity — which Claude hooks port to which OpenCode events:

| Plugin | Hook | Command | Ported to OpenCode? |
|---|---|---|---|
| monitor | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup.ts --session-check` | **No** — dead code outside Claude Code: it returns immediately without `CLAUDE_PLUGIN_DATA`, and its actual work (statusline-path migration, reaping orphaned Claude processes) is Claude-only |
| monitor | `SessionStart` (same matcher) | `skills/cockpit/scripts/decision-log-start.ts` | Yes → `session.created` |
| monitor | `Stop` | `skills/cockpit/scripts/scribe-nudge.ts` | Yes → `session.idle` |
| chronicle | `SessionStart` (`startup\|resume\|clear\|compact`) | `skills/install/scripts/setup-spawn-depth.ts --session-check` | **Moved** — becomes the installer's `subagent_depth` write |
| chronicle | `PreToolUse` (matcher `Bash`) | `hooks/check-branch.sh` | Yes → `tool.execute.before` |
| dispatch | `PostToolUse` (matcher `Edit\|Write`) | `hooks/flightplan-lint.sh` | Yes → `tool.execute.after` |

OpenCode has no hook-level "ask" — a plugin's `tool.execute.before` handler can only let a call through or throw. The branch guard degrades accordingly: instead of returning an `ask` permission decision, it throws `check-branch.sh`'s own `systemMessage` verbatim, turning what is a prompt on Claude Code into a hard block on OpenCode.

The module itself carries four constraints, each a trap if broken: it is a single file; it imports nothing from anywhere else in this repo, even a helper worth sharing stays module-local; it derives the repo root from `dirname(import.meta.dir)`, never a config file; and it never reads a harness environment variable — Claude's and Codex's own vars must stay meaningless to it.

**Version policy.** `opencode/` is repo infrastructure, not a release component. This work bumps no `plugin.json`, cuts no `<plugin>-vX.Y.Z` tag, and adds no `CHANGELOG.md` entry — it belongs to no plugin, so none of them owns a version bump for it.

**Codex freezes hook environments.** Codex runs plugin hooks under a long-lived `codex app-server daemon` whose environment is fixed at daemon start. A delegation env var such as relay's `RELAY_DELEGATED=1` reaches the Codex frontend but not the hook, if the daemon predates it. Restart the app-server to refresh the environment. The same suppression works cleanly on Claude Code.

**The statusline wiring drifts by version.** monitor's `SessionStart` hook repairs under a marker gate on `$CLAUDE_PLUGIN_DATA/.wired-version`. Once per version it re-points a version-drifted statusline path and removes any stale channel entry. The cache path encodes the version (`.../monitor/3.1.0/...`) and old directories linger, so "wired" means the exact current path, not mere existence. The hook never fresh-wires — initial opt-in stays manual.

**Drift inside a version is noticed, never fixed.** The same hook then runs a read-only drift watch on every session, because the marker gate is blind to a hand-edited `settings.json`, a restored backup, or a reinstall under another cache root. It reports a foreign collector path, a stale hand-wired channel, missing `permissions.allow` patterns, and an unparseable `settings.json`, then tells the user to run `/monitor:install`. Two rules make it work: the notice ships as a `systemMessage` inside **one** JSON object on stdout — bare stdout reaches only the model, so nothing else in `--session-check` may print and `migrate()`'s output is captured — and repetition is keyed on which pieces are off, stored in `$CLAUDE_PLUGIN_DATA/.drift-notice`, so one complaint is made once but a drift that returns is reported again.

## Commands

```bash
# Dashboard (port 5938, auto-opens browser)
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts   # [--port N] [--no-open]

# Data as JSON (CLI mode)
bun packages/monitor/skills/usage-dashboard/scripts/api.ts
bun packages/monitor/skills/usage-dashboard/scripts/live.ts

# Rollup DB (--rebuild re-ingests from scratch)
bun packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts  # [--rebuild]

# monitor:install engine — checks both skills, wires the statusline
bun packages/monitor/skills/install/scripts/setup.ts                  # --check | --dry-run | --apply
bun packages/monitor/skills/install/scripts/install.ts                # dashboard precheck only

# Cockpit daemon (port 5858)
bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts

# Restart the daemon onto THIS install's code. Supersedes any concurrent MCP
# respawn, then verifies our root won the port. Run it from the updated cache.
bun packages/monitor/skills/cockpit/scripts/cockpit.ts restart        # [--port N] [--no-open]

# Cockpit config (global, XDG)
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config get-language
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --log-language zh-TW
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --answer-here on
bun packages/monitor/skills/cockpit/scripts/cockpit.ts nudge status   # on|off|toggle|clear|status
                                                                     # [--scope session|project|user]

# Cockpit dev: isolate from the cached daemon entirely
COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999

# OpenCode installer — symlinks skills/plugin/agents/commands into ~/.config/opencode/, raises subagent_depth
bun opencode/install.ts                                                # --check | --dry-run | --apply | --unlink

# Tests
bun test packages/monitor/skills/cockpit/scripts/
bun test packages/monitor/skills/install/scripts/
bun test packages/monitor/skills/usage-dashboard/scripts/rollup-update.test.ts
bun test opencode/

# Typecheck. Run it before calling a refactor done — `bun build` bundles
# without typechecking, and `bun test` only reaches the paths a test drives.
bunx --bun tsc --noEmit                              # whole repo
bunx --bun tsc --noEmit | grep <path-you-touched>    # must print nothing
```

**Typecheck against the root `tsconfig.json`, never against a file list.** Naming
files on the command line drops the config, so `strict` runs without
`types: ["bun"]` and every `Bun`, `process`, and `Buffer` reports as an undefined
name. Real errors then hide among a dozen fake ones — this is how a `Target`
literal missing a required field once shipped and failed at runtime on every
command.

The repo-wide run is **not** green: 86 pre-existing errors sit outside herdr, so
a change is clean when `grep <path-you-touched>` prints nothing, not when the
count is zero.

## Code Conventions

- Runtime is Bun with TypeScript. There is no transpile step.
- Use `type` over `interface`.
- Frontend uses petite-vue, not full Vue. Charts use Chart.js.
- Take no external npm dependencies at runtime. Vendor libraries are committed in `dashboard/dist/vendor/`. `devDependencies` may carry types-only packages — `@types/bun` is there so the typecheck above resolves Bun's globals.
- Vendor mermaid as the UMD bundle (`mermaid.min.js`, ~3.3MB, sets `globalThis.mermaid`). The ESM build is code-split and cannot ship as one file. `modules/diagram.js` lazy-loads it on the first diagram render, themes it with concrete hex (mermaid's khroma engine cannot parse `oklch()`), and sanitizes the SVG through DOMPurify's SVG profile.
- Price per 1M tokens in USD.

## Releasing

**Versions live only in each plugin's two `plugin.json` files.** The marketplace registries carry no `version` field — do not add one. The published version is the git tag plus the `plugin.json` values.

Print the current versions rather than trusting a doc:

```bash
git tag --sort=-creatordate | head -5
```

**Every plugin versions independently** under a plugin-scoped tag `<plugin>-vX.Y.Z`, for example `chronicle-v0.1.0`. There is no repo-wide version.

**Bump only the plugin you touched.** Its two files move together:

- `packages/<plugin>/.claude-plugin/plugin.json` → `version`
- `packages/<plugin>/.codex-plugin/plugin.json` → `version`

**This repo runs GitHub Flow.** `main` is the only long-lived branch; there is no `develop`. Both `.chronicle/release.json` and `.chronicle/pr.json` record `"workflow": "github-flow"`, so `/chronicle:release` commits the bump on `main`, cuts every tag on that bump commit, and merges nothing.

**Prefer `/chronicle:release`.** This repo dogfoods its own release skill. Its `.chronicle/release.json` records each plugin as an independently-versioned component with its two `plugin.json` files as version-file patterns. Pick the touched components at the version gate. Coordinated multi-component releases are native: name several components and the finisher cuts N scoped tags on one bump commit.

To cut a release by hand: bump the two `plugin.json` files, add a `CHANGELOG.md` entry headed per plugin (`## [chronicle 0.1.0]`), commit on `main`, cut an annotated `<plugin>-vX.Y.Z` tag on that commit, then push `main` and the tag.
