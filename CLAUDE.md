# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code (and Codex) plugin marketplace (`q-lab-marketplace`) containing five local plugins:

- **monitor** — usage dashboard + per-project cockpit (documented in depth below).
- **dispatch** — interview-driven planning + execution: `preflight` (lightweight in-conversation spec) + `flightplan` (multi-file blueprint written to disk for sub-agents) + `autopilot` (executes a flightplan tree via the Workflow tool: per-task dev→verify→judge→score loop gated on each task's `## Eval rubric`, then the closing `Final review` task, leaving a self-gitignored `docs/<slug>/.flightlog/` audit trail) + `waypoints` (a rolling-wave milestone-roadmap tier *above* flightplan: writes only `docs/<proj>/WAYPOINTS.md` and a `waypoints.ts` CLI — `active` / `leg-scaffold` / `advance` — so each leg's flightplan is generated just-in-time after the previous leg lands; flightplan gains a narrow "waypoint mode" to plan one leg into `docs/<proj>/legs/NN-slug/`). See `packages/dispatch/skills/*/SKILL.md`; the only repo-level wiring is its two entries in the marketplace registries and a PostToolUse `flightplan-lint.sh` hook in `packages/dispatch/.claude-plugin/plugin.json`.
- **relay** — cross-harness delegation via `/relay <codex|opencode|claude> <delegate|review|image>`, with a backend-agnostic mode layer plus per-harness strategy layer and a capability matrix where `image` is codex-only.
- **chronicle** — commit + PR/MR authoring + release automation: reshapes odin-git's simple/atomic commit ideas into one decision tree with no odin-git dependency, and treats cockpit's decision trail as a soft enrichment for PR context. Its third skill `release` is config-first release automation — it auto-detects whole-repo vs per-component monorepo layouts, persists the shape to a committed `.chronicle/release.json`, and bumps versions / writes the CHANGELOG entry / (in auto mode) commits, merges, tags, and pushes. All three skills use a thin-SKILL → nested no-Bash orchestrator → cheap child-agent topology (agents live in `packages/chronicle/agents/`). A PreToolUse `check-branch.sh` hook in `packages/chronicle/.claude-plugin/plugin.json` (ported from odin-git) blocks/asks-confirmation on `git commit` while on `main`/`master` in a git-flow repo.
- **herdr** — reference + in-session agent orchestration for the [Herdr](https://herdr.dev) terminal workspace manager. A knowledge skill (config, CLI, plugin development, live pane/agent recipes) plus a typed Bun wrapper `scripts/herd.ts` that collapses herdr's raw CLI into seven verbs (spawn/send/keys/wait/read/list/close) for driving agents in sibling panes or their own tabs (`spawn --new-tab`) when running inside herdr (`HERDR_ENV=1`). See `packages/herdr/skills/herdr/SKILL.md`.

**monitor** bundles three sibling skills:

- **usage-dashboard** — the rear-view mirror: a local web dashboard that visualizes Claude Code and Codex usage (sessions, tokens, cost, model mix, project activity).
- **cockpit** — the windshield: one skill with a thin `SKILL.md` router. Plain `/cockpit` routes through the provider reference (`references/claude-cli.md` or `references/codex.md`) into `references/pilot.md`; `/cockpit scribe` routes into `references/scribe.md` for auto-distilling work into typed decision-trail entries. The cockpit provides a distilled decision trail, live transcript, a `needs_your_call` wait/send bridge, and a send box for running sessions. Its dashboard daemon owns the live transcript view that usage-dashboard's "Live now" rows link into. Claude Code sends use the cockpit channel MCP server; Codex sends use the managed Codex remote-control app-server socket, with direct app-server as fallback. The channel is UI→agent only: the agent's answers ride the transcript (the single source of truth — no separate reply tool).
- **install** — one-stop setup (command-triggered): the canonical home for all prerequisite checks and config wiring for the whole plugin. `setup.ts` checks both skills and wires the one config a non-dev user can't easily edit by hand — the statusline collector in `~/.claude/settings.json`. (The **cockpit channel** is now packaged in the plugin manifest — `mcpServers` + `channels` in `.claude-plugin/plugin.json` — so it no longer needs a hand-written `~/.claude.json` entry; setup.ts only *cleans up* a stale entry left by older versions, which would otherwise double-register the channel.) The dashboard precheck (`install.ts`) and statusline wiring (`setup-statusline.ts` + pure `statusline-decision.ts`) live here; usage-dashboard imports them rather than owning copies. The Claude manifest has two **`SessionStart` hooks**: one runs `setup.ts --session-check` — marker-gated via `$CLAUDE_PLUGIN_DATA/.wired-version`, so once per version it silently re-points a version-drifted statusline path (the cache encodes the version, e.g. `.../monitor/3.1.0/...`, and old dirs linger so "wired" means *exact current path*, not mere existence) and removes any stale channel entry, or, on a fresh install, prints one write-free nudge to run `/monitor:install`; the other injects thoughtful auto-logging guidance for Claude sessions. It never fresh-wires the statusline — initial opt-in stays manual. Codex has no SessionStart hooks, so auto-logging is enabled manually with `/thoughtful`.

Cockpit has no per-project metadata file or local planning state. Cockpit config is global, at `~/.config/q-lab/cockpit/config.json`: the decision-log language (`cockpit config --log-language` / `get-language`) and the project/user-scope scribe-nudge preferences (`cockpit nudge ... --scope project|user`, see below). Per-project nudge opinions live keyed by project root inside this one global file — never a repo dotfile.

This file documents usage-dashboard in depth; cockpit carries its own `SKILL.md`, `PRODUCT.md`, and `DESIGN.md` under `packages/monitor/skills/cockpit/`. The dashboard and cockpit run **independent** web servers (separate ports, separate `dist/` SPAs) — only the plugin packaging is merged.

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # Claude marketplace registry (plugins: monitor, dispatch, relay, chronicle)
├── .agents/plugins/marketplace.json  # Codex marketplace registry (plugins: monitor, dispatch, relay, chronicle)
├── CHANGELOG.md                      # release notes (Keep a Changelog format)
├── packages/dispatch/                # plugin: interview-driven planning + execution (preflight + flightplan + autopilot + waypoints)
│   ├── .claude-plugin/plugin.json    # Claude manifest + PostToolUse hook → flightplan-lint.sh
│   ├── .codex-plugin/plugin.json     # Codex manifest (skills only; no hooks)
│   ├── hooks/flightplan-lint.sh      # lints flightplan task files on Edit/Write (path + content gated)
│   └── skills/
│       ├── preflight/                # skill: lightweight in-conversation spec (← odin probe)
│       ├── flightplan/               # skill: multi-file PLAN.md + tasks/ blueprint (← odin probe-deep); also hosts a narrow "waypoint mode" that plans one leg into docs/<proj>/legs/NN-slug/
│       │                             #   scripts/ also home autopilot's shared tools: next-ready / score-task (--log) / flightlog
│       ├── autopilot/                # skill: execute the tree via Workflow (wave loop + dev→verify→judge→score gate); see references/orchestrator.md
│       └── waypoints/                # skill: rolling-wave milestone roadmap ABOVE flightplan — writes only docs/<proj>/WAYPOINTS.md + waypoints.ts CLI (active / leg-scaffold / advance)
├── packages/monitor/                 # plugin: usage dashboard + cockpit (monorepo layout: packages/<plugin>)
│   ├── .claude-plugin/plugin.json    # Claude manifest (version must match marketplace.json) + SessionStart hooks → setup.ts --session-check + thoughtful injection
│   ├── .codex-plugin/plugin.json     # Codex manifest (skills: "./skills/" — both auto-discovered; no hooks support)
│   ├── commands/
│   │   └── thoughtful.md             # slash command: enable best-effort /cockpit scribe auto-logging (manual on Codex)
│   └── skills/
│       ├── usage-dashboard/          # skill: usage dashboard (the rear-view)
│       │   ├── SKILL.md              # skill trigger config & docs
│       │   ├── PRODUCT.md            # design direction — Sunrise Atlas (Big Sur dawn palette, calm working surface, anti-Nordic)
│       │   ├── scripts/
│       │   │   ├── api.ts            # data engine — reads ~/.claude/ & ~/.codex/, merges pricing, exports buildStats(); Claude aggregates now come from the rollup DB
│       │   │   ├── rollup-db.ts      # persistent rollup DB (bun:sqlite at ~/.local/share/q-lab/token-atlas/rollup.db): schema + accessors; usage_hourly / ingested_files / seen_requests / meta
│       │   │   ├── rollup-update.ts  # incremental tail-ingest of ~/.claude transcripts → usage_hourly (resume from bytes_parsed, billing dedup, truncation→rebuild, prune deleted files)
│       │   │   ├── live.ts           # live-sessions engine (Claude + Codex) — active sessions for the "Live now" panel
│       │   │   ├── atlas-server.ts   # Bun HTTP server (static + /api/stats + /api/live), port 5938
│       │   │   └── statusline-collector.ts # captures live rate_limits, chains ccstatusline, fires a throttled detached rollup nudge
│       │   ├── dashboard/dist/       # static SPA (petite-vue + Chart.js, no build step)
│       │   └── references/
│       │       └── pricing-defaults.json
│       ├── cockpit/                  # skill: per-project session cockpit; SKILL.md router → provider + pilot/scribe references
│       │   ├── SKILL.md              # thin router: /cockpit → pilot.md, /cockpit scribe → scribe.md
│       │   ├── references/
│       │   │   ├── pilot.md          # interactive front: open dashboard, log decisions, wait/send needs_your_call
│       │   │   ├── scribe.md         # background auto-distill via cockpit scribe
│       │   │   ├── claude-cli.md     # Claude provider/session/wait policy (named to avoid CLAUDE.md case-collision on macOS)
│       │   │   └── codex.md          # Codex provider/session/wait policy
│       │   ├── scripts/cockpit-server.ts # Bun daemon (singleton via ~/.local/share/q-lab/cockpit/daemon.json), port 5858: decision-log SSE + transcript stream + wait/send broker + Claude inbox/send + Codex remote-control send
│       │   ├── scripts/cockpit.ts        # CLI: log / scribe / wait / send / config
│       │   ├── scripts/cockpit-channel.ts # channel MCP server (stdio): long-polls /api/inbox, injects UI text into the live session (no tools — agent→UI is the transcript)
│       │   ├── scripts/codex-control-probe.ts # Codex app-server control client: managed remote-control websocket first, direct app-server fallback
│       │   ├── scripts/config.ts         # global log_language config at ~/.config/q-lab/cockpit/config.json
│       │   └── dashboard/dist/           # static SPA (petite-vue), Night Flight design system
│       └── install/                  # skill: one-stop setup/precheck for the whole plugin (command-triggered)
│           └── scripts/
│               ├── setup.ts          # monitor:install engine — checks both skills + wires the statusline config (--check/--dry-run/--apply); --migrate re-points statusline drift + removes the stale channel entry; --session-check is the marker-gated hook entry
│               ├── install.ts        # canonical dashboard precheck (exports dashboardChecks/printReport; CLI too)
│               ├── setup-statusline.ts   # statusline wiring (exports applyStatusline; CLI too)
│               └── statusline-decision.ts # pure wrap/stale/skip decision (unit-tested)
├── packages/chronicle/               # plugin: commit + PR/MR authoring + release automation; ships to both marketplaces at independent version (see "Releasing")
│   ├── .claude-plugin/plugin.json    # Claude manifest
│   ├── .codex-plugin/plugin.json     # Codex manifest, skills: "./skills/"
│   ├── agents/                       # nested child agents for all three skills (each skill = thin SKILL → no-Bash orchestrator → cheap children)
│   │   ├── manager.md / analyst.md / writer.md          # commit: manager orchestrates → analyst decides simple/atomic → writer commits
│   │   ├── editor.md / drafter.md / publisher.md        # pr: editor orchestrates → drafter authors title+body → publisher opens the request
│   │   └── releaser.md / surveyor.md / bumper.md / chronicler.md / finisher.md  # release: releaser orchestrates → surveyor + bumper + chronicler + (auto) finisher
│   └── skills/
│       ├── commit/                   # skill: unified simple/atomic commit decision tree
│       │   ├── SKILL.md
│       │   ├── references/commit-template.md
│       │   └── scripts/
│       │       ├── analyze-changes.ts
│       │       └── analyze-changes.test.ts
│       ├── pr/                       # skill: PR/MR author enriched by cockpit decision trail when available
│       │   ├── SKILL.md
│       │   └── scripts/
│       │       ├── analyze-branch.ts
│       │       ├── analyze-branch.test.ts
│       │       ├── request-creator.ts
│       │       └── request-creator.test.ts
│       └── release/                  # skill: config-first release automation (whole-repo vs per-component; prepare / auto / auto push)
│           ├── SKILL.md              # thin router → main-agent version gate → nested releaser orchestrator
│           ├── references/{release-config,monorepo-release,changelog-template}.md
│           └── scripts/
│               ├── analyze-release.ts    # pure core: version math, capture-group pattern read/write, shape detection, config I/O (32 tests)
│               └── analyze-release.test.ts
│   # .chronicle/release.json (committed, at repo root) is the source of truth for the release shape — whole-repo vs the set of independently-versioned/tagged components + their version-file patterns
└── packages/relay/                   # plugin: cross-harness task delegation (relay)
    ├── .claude-plugin/plugin.json        # Claude manifest, version 0.1.0
    ├── .codex-plugin/plugin.json         # Codex manifest, skills: "./skills/", version 0.1.0
    ├── commands/                        # backend-fixed alias commands (auto-discovered; generic entry is the relay:relay skill)
    │   ├── codex.md                     # alias: /relay:codex → /relay:relay codex $ARGUMENTS
    │   ├── opencode.md                  # alias: /relay:opencode → /relay:relay opencode $ARGUMENTS
    │   └── claude-cli.md                # alias: /relay:claude-cli → /relay:relay claude $ARGUMENTS
    └── skills/relay/
        ├── SKILL.md                      # orchestration, smart-apply, report formats, install docs
        ├── references/backends.md        # per-CLI flags + headless output + opencode symlink install
        └── scripts/
            ├── relay.ts                  # entry: relay <backend> <mode> [flags]; gate + dispatch + capture; builds prompt internally
            ├── relay-prompt.ts           # backend-agnostic prompt: formatPrompt (pure) + buildPromptFile (impure) + live file-contract/scope helpers
            ├── live.ts                   # live-pane layer (inside herdr, HERDR_ENV=1): herd.ts locator + liveGate + runLive poller; herd.ts is dynamically imported — no hard herdr dependency
            ├── context-collector.ts      # git/file/project context (ported from odin-codex)
            ├── shared.ts                 # run(), createTmpRunDir, timestamp, model+config resolution
            ├── types.ts                  # Mode, Strategy, Backend, InvokeOpts, RunResult
            ├── backends/
            │   ├── gate.ts               # capabilityGate + getBackend (pure; no concrete-backend imports)
            │   ├── index.ts              # concrete BACKENDS registry (imports the three backends; built at the entry point)
            │   ├── codex.ts              # native review + exec + image PNG handling (postRun)
            │   ├── opencode.ts           # opencode run + JSONL parse + model defaults
            │   └── claude.ts             # claude -p + /code-review native review
            └── *.test.ts                 # unit tests (bun test) — backends mock the CLI runner; live CLI behaviour is verified by manual smokes, not a committed integration test
```

relay ships to both Claude Code and Codex marketplaces via `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (see "Releasing" for current versions). OpenCode integration is available via a `~/.claude/skills/` symlink (documented in SKILL.md and references/backends.md).

```
packages/herdr/                       # plugin: Herdr reference + in-session agent orchestration
├── .claude-plugin/plugin.json        # Claude manifest, version 0.1.0
├── .codex-plugin/plugin.json         # Codex manifest, skills: "./skills/", version 0.1.0
└── skills/herdr/
    ├── SKILL.md                      # router: fronts the herd wrapper for orchestration; references for the long tail
    ├── references/                   # migrated third-party docs (config / cli / plugin-development / agent-orchestration)
    └── scripts/
        ├── herd.ts                   # typed Bun wrapper over the herdr CLI: spawn/send/keys/wait/read/list/close
        │                             #   (createHerd(run) factory — importable so relay consumes it on the live path);
        │                             #   names not pane ids, send writes literal+Enter, keys sends bare chords,
        │                             #   spawn({newTab}) opens an agent in its own labelled tab (create→start→close shell→restore focus; --tab-label overrides the agent-name default),
        │                             #   read defaults to visible, honors HERDR_BIN_PATH; gated on HERDR_ENV=1
        └── herd.test.ts              # unit tests (bun test) — mocks the herdr runner; live-verified inside herdr 0.7.1
```

### Data Flow

1. `api.ts` reads local files: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/**/*.jsonl`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`
2. Pricing: defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`
3. `atlas-server.ts` exposes `GET /api/stats` (calls `buildStats()`) and serves `dashboard/dist/` statically
4. Frontend fetches `/api/stats` on load, renders with petite-vue + Chart.js

### Usage rollup DB

Claude Code deletes transcripts via `cleanupPeriodDays` (default 30), so re-parsing `~/.claude/projects/**` on every load loses token/cost/model history as files age out. The rollup DB makes that history **survive deletion**:

1. `parseTranscriptUsage()` (in `api.ts`) calls `updateRollup()` then `readRollupAggregates()` — its four aggregate maps + `projectTokens` are sourced from the rollup (full history), not the live walk; `ledger` + file count stay on the live walk (inherently recent, shrink as files are cleaned up). If the DB is unavailable it falls back to the live-walk maps.
2. `rollup-update.ts` is incremental: each transcript is tail-parsed from `ingested_files.bytes_parsed` (at UTF-8-safe newline boundaries), billing-deduped across runs via `seen_requests`, and additively upserted into `usage_hourly(hour_ms, project, model)` — **tokens only** (cost stays a downstream live-pricing computation, so price corrections apply retroactively). `hour_ms` is the local hour-start (matches `hourStartMs`), so daily/heatmap reconstruction is byte-identical and `/api/stats` is unchanged.
3. Triggers: primary = dashboard load (update-then-read in `parseTranscriptUsage`); secondary = a detached, 5-min-throttled `nudgeRollup()` from `statusline-collector.ts`. No daemon.
4. Bounded growth: a file shrinking below `bytes_parsed` (truncation) forces a full rebuild; deleted files are pruned from `ingested_files` **and** `seen_requests` (`usage_hourly` keeps its tokens). Schema changes bump `meta.schema_version`, which drives a destructive rebuild (the rollup is fully derived, so rebuilding is always safe). DB lives at `~/.local/share/q-lab/token-atlas/rollup.db` (XDG, out of dotfiles sync).

### Live sessions ("Live now" panel)

Purely additive — the `/api/stats` snapshot is untouched. `live.ts` powers one endpoint (server binds `127.0.0.1`):

1. `GET /api/live` — active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy`/`idle`/`waiting`, stale-filtered at 10 min) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred`/`recent`). Drives the "Live now" panel, polled every 3s (paused while the tab is hidden).

usage-dashboard does **not** render transcripts — it's the rear-view (usage analytics). Clicking a Live-now row calls `openInCockpit(session)`, which opens `http://localhost:<cockpitPort>/?session=<id>&provider=<p>&project=<cwd>` in a new tab: cockpit (the live windshield) owns the transcript view. The port comes from `/api/live`'s `cockpitPort` (read from cockpit's `~/.local/share/q-lab/cockpit/daemon.json`, so a custom-`--port` cockpit still resolves), falling back to `5858`; rows are inert when `cockpitUp` is false so a dead daemon never opens a broken tab. The transcript renderer + `marked`/`DOMPurify`/`highlight.js` vendors were removed here to avoid maintaining two copies — cockpit's `transcript-stream.ts` + `modules/transcript.js` are the single source.

### Key Design Decisions

- **No build step** for frontend — `dashboard/dist/` is committed as-is, vendor libs included
- **Bun-only** runtime — uses `bun:sqlite`, `Bun.serve`, `Bun.file`
- Model usage keys are namespaced as `provider:model` (e.g. `claude:claude-opus-4-7`, `codex:o3`)
- **Billing dedup** — `api.ts` dedups transcript entries by `requestId:messageId` to avoid double-counting usage (the shared key lives in `dedup.ts`; the rollup ingest reuses it).
- **Usage rollup DB** — Claude aggregates are reconstructed from a persistent `bun:sqlite` rollup (see "Usage rollup DB" above) so usage history outlives `cleanupPeriodDays` transcript deletion. The DB stores tokens only; cost is computed downstream from live pricing.
- **Theme** — light + dark via `[data-theme]` on `<html>`; tokens defined twice in `style.css`; toggle uses the View Transitions API for a cross-fade
- **Sunrise Bloom delight** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` use an `::before` (or `::after`) radial-gradient bloom. JS `installBloomTracker()` in `app.js` lerps `--bloom-x/--bloom-y` toward cursor each frame for the trailing effect. Add new panel-shaped classes to **both** the CSS selector list and the JS `SELECTOR` constant
- **Hero wave** — `.hero-band` uses a 200%-wide SVG `mask-image` containing two identical wave cycles; `hero-wave-drift` animation slides `mask-position-x` one wavelength for a seamless loop
- **Live-now panel** — the `.live-panel` is registered in both the bloom CSS list and the JS `SELECTOR`. Rows link out to cockpit (`openInCockpit`); usage-dashboard itself renders no transcript.

## Commands

```bash
# Run the dashboard (port 5938, auto-opens browser)
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts

# Run with custom port / no auto-open
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts --port 9000 --no-open

# Run the full monitor:install engine — checks both skills + wires configs
bun packages/monitor/skills/install/scripts/setup.ts            # --check (default)
bun packages/monitor/skills/install/scripts/setup.ts --dry-run  # preview writes
bun packages/monitor/skills/install/scripts/setup.ts --apply    # wire both pieces

# Run only the dashboard precheck (verifies bun, data sources, vendor files)
bun packages/monitor/skills/install/scripts/install.ts

# Get stats as JSON (CLI mode of api.ts)
bun packages/monitor/skills/usage-dashboard/scripts/api.ts

# Get active live sessions as JSON (CLI mode of live.ts)
bun packages/monitor/skills/usage-dashboard/scripts/live.ts

# Inspect the live-sessions endpoint against a running server
curl -s localhost:5938/api/live | jq

# Update the usage rollup DB (incremental; --rebuild re-ingests from scratch)
bun packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts
bun packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts --rebuild

# Run the rollup test suite
bun test packages/monitor/skills/usage-dashboard/scripts/rollup-update.test.ts

# Run the cockpit daemon (port 5858)
bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts

# Restart the daemon onto THIS install's code (after a plugin update or a working-
# tree edit). Kills the current daemon and rebinds, then verifies our root won the
# port — superseding+retrying past any concurrent MCP respawn from another install.
# Serves whichever cockpit.ts you invoke, so run it from the updated cache (or repo).
bun packages/monitor/skills/cockpit/scripts/cockpit.ts restart            # [--port N] [--no-open]

# Read or update the global cockpit decision-log language
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config get-language
bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --log-language zh-TW

# Prune old decision logs — trash per-project .cockpit/logs/*.jsonl older than N
# days (default 14, matching the registry TTL) + drop dead registry entries. The
# registry self-reaps stale ENTRIES on write, but the jsonl FILES (and orphans
# whose entry was already reaped) never age out on their own.
bun packages/monitor/skills/cockpit/scripts/cockpit.ts prune --dry-run   # preview
bun packages/monitor/skills/cockpit/scripts/cockpit.ts prune             # [--days N]

# Enable best-effort thoughtful auto-logging in Codex or re-affirm it manually
/thoughtful

# Toggle the scribe Stop-hook nudges (/monitor:nudge command). Three scopes —
# session (TTL file ~/.local/share/q-lab/cockpit/scribe-nudge-toggle.json),
# project + user (global config). Most-specific defined scope wins.
bun packages/monitor/skills/cockpit/scripts/cockpit.ts nudge status            # on|off|toggle|clear|status
bun packages/monitor/skills/cockpit/scripts/cockpit.ts nudge off --scope user  # --scope session|project|user

# Dev: a live channel-flagged Claude session keeps respawning the cached daemon
# (the channel MCP's reconnect loop calls ensureCockpitDaemon when the daemon
# dies). `cockpit.ts restart` now wins that race for port 5858 (supersede + retry),
# so prefer it. To instead test working-tree changes against a fully isolated
# daemon (no contention at all), run it on its own port + home:
COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999

# Run the cockpit test suite
bun test packages/monitor/skills/cockpit/scripts/

# Run the install skill test suite
bun test packages/monitor/skills/install/scripts/
```

## Code Conventions

- Runtime: Bun (TypeScript, no transpile step needed)
- Use `type` over `interface`
- Frontend: petite-vue (not full Vue), Chart.js for charts
- No external npm dependencies — vendor libs (petite-vue, Chart.js, marked, DOMPurify, highlight.js, mermaid) are committed in `dashboard/dist/vendor/`. **mermaid** is the UMD bundle (`mermaid.min.js`, ~3.3MB, sets `globalThis.mermaid`) because its ESM build is code-split into chunks that can't ship as one file; `modules/diagram.js` lazy-loads it via a `<script>` tag on first diagram render, themes it to Night Flight (concrete hex, since mermaid's khroma engine can't parse `oklch()`), and sanitizes the SVG through DOMPurify's SVG profile. A decision entry carries Mermaid source via `cockpit log/scribe --diagram`
- Pricing is per-1M-tokens USD

## Releasing

⚠️ Versions live **only** in each plugin's two `plugin.json` files (Claude + Codex). The marketplace registries (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`) carry **no `version` field** — don't add one. The published version is the git tag plus the `plugin.json` values.

**Every plugin is versioned independently, on its own cadence.** There is no repo-wide version. Each plugin owns its version in its two `plugin.json` files and releases under a **plugin-scoped tag** `<plugin>-vX.Y.Z` (e.g. `chronicle-v0.1.0`). Current versions: monitor `3.18.3`, dispatch `3.15.1`, relay `0.5.0`, chronicle `0.5.0`, herdr `0.1.4`.

**Bump only the plugin(s) you actually touched** — leave every other plugin's version alone. Each plugin's two files move together:

- `packages/<plugin>/.claude-plugin/plugin.json` → `version`
- `packages/<plugin>/.codex-plugin/plugin.json` → `version`

> History note: tags up to `v3.12.1` were repo-wide `vX.Y.Z` and covered monitor + dispatch in lockstep. That lockstep is retired — monitor and dispatch now version independently like everything else, so a release touching only one of them bumps only that one. The legacy `vX.Y.Z` tags stay as-is; new releases use the scoped `<plugin>-vX.Y.Z` form.

**Preferred path: `/chronicle:release`** — this repo now dogfoods its own release skill. Its committed `.chronicle/release.json` records the per-component shape (each plugin is an independently-versioned component with its two `plugin.json` files as version-file patterns), so the skill bumps the right files, prepends the per-plugin `CHANGELOG.md` entry, and (in `auto` / `auto push` mode) replicates the plain-git gitflow finish with the scoped tag. Pick the touched component(s) at its version gate. It supports **coordinated multi-component releases natively**: name several components (or select the changed set at the gate) and the finisher cuts N scoped tags on one develop→main merge commit (one bump commit, N tags) — the same shape a `chronicle 0.5.0 + monitor 3.18.3` release takes.

If cutting a release by hand instead: `/odin-git:release` does not auto-detect these per-plugin fields, so **bump the touched plugin's two `plugin.json` files by hand** to match its scoped tag before finishing a release, then add the matching `CHANGELOG.md` entry (head it per-plugin, e.g. `## [chronicle 0.1.0]`, noting the scoped tag it tracks). Because the scoped tag isn't `v`-prefixed, `git flow release finish` won't produce it cleanly — replicate the finish with plain git (merge develop → main, annotated `<plugin>-vX.Y.Z` tag on main, merge main back to develop, push both branches + the tag).
