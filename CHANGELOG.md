# Changelog

## [3.0.1] - 2026-05-25

### 🐛 Bug Fixes

- **Cockpit `needs_your_call` answers no longer cross-talk between cards**: Each wait is now bound to its specific call, so answering one decision card can never wake a wait parked on a different (stale) card. Only the latest open call is ever active — answering an older, superseded call no longer reopens it.
- **Stale cockpit daemon paths resolved after a plugin move or update**: The daemon now records where it was launched from and only reuses an existing daemon when the paths match; a moved or updated install supersedes the old one instead of serving stale files (404 static, 200 API).
- **`cockpit log` verifies entries persisted**: A read-back guard catches silent drops so logged decisions are durable.

### ♻️ Internal

- **usage-dashboard internals refactored into testable pure modules**: The filesystem/network-bound scripts now delegate their logic (billing dedup, per-project cost, daily activity merge, live-session enrichment, statusline decisions) to pure modules. Behavior is unchanged, verified end-to-end.
- **usage-dashboard now has a test suite (0 → 56 tests)**: Covers the newly extracted modules plus `api.ts` helpers (cost, token/key/date math), bringing the full monitor suite to 167 passing.

## [3.0.0] - 2026-05-24

### ⚠️ Breaking

- **Token Atlas and Cockpit are now one plugin: `monitor`**: The two separate plugins have merged into a single `monitor` plugin that ships both as skills (`usage-dashboard` + `cockpit`). **You must reinstall** — remove the old `token-atlas` and `cockpit` plugins, then install `monitor@q-lab-marketplace` (Claude Code) / `monitor@q-lab-marketplace` (Codex). One install, one version line, one marketplace card.
- **Skill rename**: `dashboard` → `usage-dashboard`. Invocation namespaces are now `monitor:usage-dashboard` and `monitor:cockpit`; the in-skill trigger phrases (e.g. `/token-atlas`, `/cockpit`) still work.

### ♻️ Internal

- **Both skills now ship to Codex**: previously only Cockpit was on the Codex marketplace; `monitor` exposes both skills (`skills: "./skills/"` auto-discovers them). The `usage-dashboard` skill's run paths were made runtime-neutral (`<plugin-root>`) so they resolve under Codex as well as Claude Code.
- **Packaging-only merge**: the two web servers stay independent (usage-dashboard on 5938, cockpit daemon on 5858) — no runtime/daemon merge in this release.

## [2.6.1] - 2026-05-24

### 💄 Polish

- **The "Live now" cockpit-down notice points at the command**: When Cockpit's daemon isn't running, Token Atlas now tells you to run `/cockpit` to start it, instead of a raw port hint.

## [2.6.0] - 2026-05-24

### ✨ New Features

- **Cockpit is the single live transcript view**: Token Atlas's "Live now" rows now open the running session straight in Cockpit (deep-linked by URL) instead of rendering a transcript in-app, and Cockpit can open any running session — tracked or not. One transcript renderer, no drift between the two dashboards.
- **Live sessions across every project in the Cockpit manifest**: The manifest mirrors what's actually running (from `~/.claude/sessions` and the Codex state DB), so genuinely-live sessions show up even from projects you never ran `/cockpit` in; sessions without a goal trail appear as "untracked".
- **Session prev/next navigator**: The Cockpit manifest bar's ‹ › are now real controls that step the selection through active sessions (wrapping, cross-project), with keyboard ←/→ support and a "2 / 3" position readout.
- **Know which sessions are worth opening in Cockpit**: Token Atlas tags live sessions that already have a Cockpit decision trail with a "cockpit" badge, and flags when the Cockpit daemon isn't running so clicking a row never opens a dead tab.
- **A `/cockpit` invite for untracked sessions**: Opening a session Cockpit isn't tracking now shows a gentle Decision Log card inviting you to run `/cockpit` and start a trail, instead of a blank "No decisions logged yet."
- **Scroll-to-top history in the Cockpit transcript**: The live transcript reverse-paginates older entries as you scroll up, keeping the viewport anchored where you were reading.
- **Subagent notifications read as their own role**: Agent and task completion messages render with a distinct subagent role and accent instead of looking like one of your own messages.

### 🐛 Bug Fixes

- **Live rows open Cockpit's real port**: Token Atlas opens transcripts on the port Cockpit actually bound (read from `daemon.json`) rather than a hardcoded 5858, so a Cockpit started on a custom `--port` no longer opens a dead tab.
- **Wide code no longer overflows the transcript**: Long single-line JSON and code blocks scroll within their column instead of spilling past it and being clipped.
- **Diff lines wrap again**: Long diff lines soft-wrap in the Cockpit transcript instead of widening the column and clipping the +/- gutter.

### 💄 Polish

- **Cockpit dashboard aligned to the Night Flight design system**: the untracked-session invite drops the reserved nebula color for a tonal card with an aurora accent, the navigator arrows use an on-scale radius and the standard ease-out curve, and em dashes were removed from UI copy.

### ♻️ Internal

- **Distinct dashboard server filenames**: Cockpit's and Token Atlas's servers were renamed to `cockpit-server.ts` and `atlas-server.ts`, so a `pkill -f "serve-dashboard.ts"` can no longer take down both daemons at once.

### 📝 Documentation

- **`/cockpit-start` is now `/cockpit`**: the cockpit skill's invocation was shortened.
- **Marketplace docs cover both plugins**: CLAUDE.md now describes Token Atlas and Cockpit as siblings, documents the dynamic Cockpit port, and corrects the release process to the three version files that must be bumped together.

## [2.5.1] - 2026-05-24

### 🐛 Bug Fixes

- **No more missed Cockpit call answers on cold start**: The broker now stashes a `needs_your_call` answer that arrives before the agent has parked its wait, so responses sent during the startup race are delivered instead of lost. Stashed answers are single-use and time-bounded so they can't leak into an unrelated later call.
- **Hero stays raised while you're being asked**: The cockpit hero viewport no longer collapses while a session is awaiting your input — it holds open on an open `needs_your_call`, stays raised for a 60-second grace period after you answer, and skips viewport moves during backlog replay so it only reacts to live activity.

### ⚡ Performance

- **Faster Cockpit dashboard loads**: Registry log files are now read with a bounded 64KB head instead of being slurped whole, and each project's goal metadata is read once per build (cached across sessions and projects) instead of repeatedly — cutting redundant file I/O on busy projects.

### ♻️ Internal

- **Shared HTTP response helpers**: Duplicate `jsonResponse()` / `jsonError()` helpers across the broker, project-info, dashboard server, and SSE tailer were consolidated into a single `http.ts` module.

### 📝 Documentation

- **Lighter Cockpit terminology**: Dropped the "windshield" metaphor from the cockpit skill docs in favor of plainer "heading" / "cockpit" wording.

## [2.5.0] - 2026-05-24

### ✨ New Features

- **Resilient Cockpit live streams**: The log and transcript SSE streams now share a watch-first, poll-backed tailer that waits for a not-yet-created file instead of dead-ending on a 404, falls back to polling when `fs.watch` never fires, and re-binds watchers after atomic file replacement (inode change) — no more blank or stale live panels.
- **Authoritative Cockpit session resolution**: Session lookup now trusts the live `CLAUDE_CODE_SESSION_ID` first and only falls back to the most-recently-modified transcript when it's absent, so decisions are no longer misfiled to a stale or concurrent session. `cockpit log` auto-resolves the current session when `--session` is omitted.

### 🐛 Bug Fixes

- **No duplicate call responses**: A `needs_your_call` card is marked resolved immediately after a successful dashboard response, and the Send control stays disabled to guard against duplicate click or Enter submits.

## [2.4.4] - 2026-05-24

### ✨ New Features

- **Safer Cockpit call responses**: `needs_your_call` options now select first instead of sending immediately, so the final answer is only delivered when Send is pressed.
- **Additional instructions field**: Replaced the custom-answer input with a one-line auto-growing textarea, allowing `Shift+Enter` line breaks and optional comments to be sent alongside a selected option.

> Token Atlas runtime is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.4.

## [2.4.3] - 2026-05-24

### 📝 Documentation

- **Marketplace README refresh**: Clarified the positioning of Token Atlas as the usage-history view and Cockpit as the active-session control surface, and tightened install notes for the current Claude Code and Codex marketplace entries.
- **Demo dashboard previews**: Replaced README screenshots with demo/fake-data previews for both plugins, so the above-the-fold screenshots show key features without exposing local usage traces.
- **Sharper preview assets**: Switched dashboard previews to PNG assets to keep UI text, labels, and fine lines crisp in README rendering.

> Runtime behavior is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.3.

## [2.4.2] - 2026-05-24

### 📝 Documentation

- **Cockpit needs-your-call guidance**: Clarified that when a Cockpit session is already running, any workflow that needs to ask the user should route that question through `needs_your_call` and wait for the cockpit answer.
- **Shared user-facing wording**: Generalized Cockpit and Token Atlas product/skill wording from project-specific operator language to neutral `user` / `users` wording, while preserving author metadata, marketplace ids, install commands, and task-history docs.

> Token Atlas runtime is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.2.

## [2.4.1] - 2026-05-24

### ✨ New Features

- **Cockpit Design System panel**: Added a dedicated dashboard panel for the Cockpit design system so `DESIGN.md` renders as its own focused reference surface instead of being buried in Project Info.
- **Faster-feeling hero animation**: Increased the hero starfield density, added more visible star variants and gradient trails, lengthened the tails, and kept the moving beacon following the warped vanishing point for a stronger cockpit-in-motion feel.
- **Automatic hero quieting**: The Cockpit hero now auto-collapses after 60 seconds and pauses the starfield animation, while still allowing manual reopening.

### 💄 Improvements

- **Cleaner dashboard chrome**: Removed the Project Info panel and flight-row toggle now that the Design System panel owns the design reference workflow.
- **Quieter default panels**: `CLAUDE.md` and `AGENTS.md` Project Info sections now start collapsed by default when that legacy data path is used.

### 🐛 Bug Fixes

- **Clearer Design panel route failures**: The dashboard now distinguishes an unavailable design-system route from a missing design file, making stale daemon restarts easier to diagnose.

> Token Atlas is unchanged in this release; the version bump keeps marketplace plugins aligned at 2.4.1.

## [2.4.0] - 2026-05-24

### ✨ New Features

- **New plugin: cockpit**: A new marketplace plugin that gives each project a live mission-control view of your coding agents. Capture a per-project goal and a running decision log behind a `/cockpit-start` human gate, then watch live transcripts, decisions, and "needs your call" prompts as your agents work — with respond-from-the-dashboard buttons that send your answer straight back to the waiting session.
- **Claude Code and Codex sessions side by side**: Cockpit discovers and streams both Claude Code and Codex sessions, with provider badges and per-provider transcript streaming so you can supervise mixed-agent work from one dashboard.
- **Per-project decision-log language**: `cockpit start` accepts a `--log-language` flag (asked for at start) so each project's decision trail can be recorded in your preferred language; the setting persists across re-runs.
- **Project Info modal**: View a project's goal, metadata, `CLAUDE.md`, `AGENTS.md`, and `DESIGN.md` design tokens in a modal triggered from the project rail, with path-confined reads of the assistant instruction files.

### 🎨 Design

- **"Night Flight" deep-space flight deck**: Cockpit ships a distinctive deep-space dashboard — a HUD viewport with a forward warp starfield, rotating destination beacon, leader callouts, collapsible projects manifest, and screen-styled instrument panels for the live transcript and decision log. Deep-space OKLCH palette with a cool aurora navigation accent and a warm signal reserve held back for "needs your call" dock alerts.

### 🐛 Bug Fixes

- **Non-destructive start**: Re-running `cockpit start` on an existing session now refreshes only the leading goal record and preserves the full decision/response trail instead of wiping it.
- **Robust wait/send bridge**: The wait/send commands now surface daemon errors (bad token, invalid session) instead of misreporting, fail fast on repeated stale-daemon connection failures, keep long-polls and SSE streams alive under the daemon idle timeout, and no longer kill a foreign process holding the port.
- **Stable decision-log dedupe**: Decision-log cards are deduped by durable record id (content-based fallback for legacy logs) so EventSource reconnects no longer re-render the backlog as duplicates, and relative timestamps refresh periodically instead of freezing.
- **Hardened security**: `CLAUDE.md` reads are confined to the exact project-root path, rejecting symlinks that resolve elsewhere inside the project.

### 📝 Documentation

- **Provider-neutral cockpit skill**: Refactored the cockpit skill into a shared, provider-neutral core with deltas-only `claude.md` / `codex.md` references (plugin-root resolution, find-session command, wait policy), documented the dashboard daemon lifecycle and a session-id discovery helper, and added Codex marketplace + install documentation.

> Token Atlas is unchanged in this release; the version bump unifies all marketplace plugins at 2.4.0.

## [2.3.4] - 2026-05-23

### 💄 Improvements

- **Larger live transcript text**: Bumped the streamed conversation prose to a larger font size for more comfortable reading of live transcripts.

### 📝 Documentation

- **Token Atlas design system reference**: Documented the Sunrise Atlas design language as a `DESIGN.md` color/typography spec and a machine-readable `DESIGN.json` token set (tonal ramps and color metadata) for the dashboard skill.

## [2.3.3] - 2026-05-23

### 🐛 Bug Fixes

- **Live transcript layout for wide content**: Wide blocks like tables and code blocks in the live transcript now scroll horizontally within their chat bubble instead of bursting out of the panel, and tool-segment entries line up cleanly with regular assistant and user messages.

## [2.3.2] - 2026-05-22

### 🐛 Bug Fixes

- **Live diff wrapping**: Long lines in live file diffs now soft-wrap inside the diff block instead of clipping or overflowing the panel, so wide edits stay fully readable.

## [2.3.1] - 2026-05-22

### 🐛 Bug Fixes

- **Version sync**: Bumped the plugin manifest (`plugin.json`) to match the marketplace version, which was missed in the 2.3.0 release so the marketplace and the installed plugin reported different versions.

### 📝 Documentation

- Updated the README and project guide to reflect Codex live sessions, GFM Markdown rendering, syntax highlighting, and inline file diffs, and documented that both version files must be bumped together on release.

## [2.3.0] - 2026-05-22

### ✨ New Features

- **Codex live sessions**: The Live now panel now surfaces your active Codex threads alongside Claude sessions, with click-to-open transcripts that stream Codex messages, tool calls, and results in the same modal.
- **Live file diffs**: File edits now appear inline in the live transcript as collapsible, color-coded diff views — Codex `apply_patch` edits and Claude Edit / MultiEdit / Write calls render with a unified, aligned format that highlights added, removed, and context lines for quick scanning.
- **Richer transcript rendering**: Live Markdown is now rendered with a proper Markdown engine and sanitized for safety, adding GFM tables, more heading levels, and safer external links. Code blocks in transcripts and tool output now get syntax highlighting based on the detected language.

### 🔧 Improvements

- **Consistent tool-block styling**: Claude and Codex tool calls and results now share the same visual treatment, so the live transcript reads consistently regardless of which assistant produced it.
- **Cleaner transcript layout**: Messages now read as conversation bubbles with larger, more readable text, while tool and result blocks stay visually distinct and collapse by default to cut noise. File-change blocks default to expanded for visibility.
- **Cleaner notification cards**: Claude task notifications and Codex subagent notifications now render as compact result cards instead of raw XML or JSON, hiding internal ids and metadata.

### 🐛 Bug Fixes

- **No more duplicate Codex messages**: Fixed Codex assistant and tool messages showing up twice in the live transcript by using a single display source.
- **Stable diff layout**: Fixed live diffs overflowing the modal or stretching too wide, and tightened spacing so blank diff rows no longer look oversized — long lines now scroll inside the diff block.
- **More robust live parsing**: Hardened transcript parsing so escaped entities stay literal, vanished session files are skipped gracefully, and active Codex sessions sort ahead of idle ones.

## [2.2.0] - 2026-05-22

### ✨ New Features

- **Live now panel**: A new dashboard panel surfaces your currently active Claude sessions with live status dots, project names, and relative timestamps, refreshing automatically as sessions come and go.
- **Live transcript modal**: Click any live session to open a streaming transcript that follows along in real time — backed by a server-sent-events stream that tails the session as it's written.
- **Reverse-scroll history**: Scroll to the top of a live transcript to load earlier messages on demand, paging backward through the session without loading the whole file at once.
- **Rich transcript rendering**: Transcript entries render as Markdown prose with collapsible code blocks for tool calls, results, and JSON, plus clear role labels and styled thinking blocks for terminal-style readability.

### 🔧 Improvements

- **Faster live polling**: Transcript indexing now uses a short-lived cache and incremental file reads instead of rescanning the full session tree on every poll, with hidden-tab updates skipped to save work.
- **Smarter auto-scroll**: The transcript modal only auto-scrolls when you're pinned to the bottom, so reading earlier messages no longer yanks you back down.
- **Quieter reconnects**: Brief stream disconnections stay silent — errors only surface after 15 seconds — and retry state clears cleanly when the stream recovers.
- **Better accessibility & layout**: Live transcript styling adds focus-visible outlines for keyboard navigation, active-state feedback, and an improved responsive grid.

### 🐛 Bug Fixes

- **Transcript deduplication & pairing**: Fixed dropped text and tool-use blocks that shared an identity key, paired tool results back into their originating tool calls for clean terminal-style output, and capped blockquote nesting to prevent overflow on deeply nested quotes.

## [2.1.1] - 2026-05-21

### ✨ New Features

- **Hero wave settles into calm**: The animated hero wave now gently eases to a gentle stop after 60 seconds of inactivity, using a smooth quintic decay so the dashboard relaxes into a restful state instead of looping forever. Fully respects `prefers-reduced-motion`.

## [2.1.0] - 2026-05-21

### ✨ New Features

- **Live usage-limits panel**: New dashboard panel that surfaces your real-time quota windows so you can see how close you are to hitting limits at a glance.
- **Claude rate limits from the statusline**: Token Atlas now reads your Claude Code rate limits via a lightweight statusline collector and shows your 5-hour and weekly usage windows live.
- **Codex live usage limits**: The same panel now pulls live rate limits for Codex too, displaying Claude and Codex windows side by side with provider-specific states and empty states.
- **One-step statusline setup**: A new setup flow can auto-wire the statusline collector into your Claude Code settings (with backup and your approval), and re-discovers the installed plugin path after cache updates — no manual config editing.

### 🔧 Improvements

- **Redesigned usage-limits panel**: Circular gauges replace horizontal bars, and Claude and Codex now sit in separate, clearly badged sub-panels for easier reading.
- **Smarter limit visuals**: Meters use severity-encoded fills (amber to magenta), a time-elapsed marker that reveals when you're burning faster than the window pace, and a projected-at-reset indicator with safe/warn/over levels.
- **Better dashboard pacing**: The Monthly budget panel now sits directly above the Usage shifts panel, keeping spend-pacing and anomaly questions next to each other.
- **Accessibility**: Usage meters now expose ARIA progressbar attributes for screen readers.

## [2.0.4] - 2026-05-18

### 🔧 Improvements

- **Dashboard HTML maintainability**: Split the generated dashboard shell into focused partial files and added a lightweight loader so the shipped interface stays easier to maintain without changing runtime behavior.

### 📖 Documentation

- **README feature overview**: Simplified the feature list into clearer grouped sections and removed visual direction copy so marketplace readers can scan the plugin capabilities faster.

## [2.0.3] - 2026-05-18

### 🔧 Improvements

- **Dashboard preview in README**: Added the Token Atlas dashboard screenshot so marketplace visitors can see the current Sunrise Atlas experience before installing.
- **Install guidance polish**: Clarified the automatic precheck behavior and fixed marketplace/CLI install syntax so setup instructions match the current plugin workflow.
- **Dashboard asset organization**: Split the shipped dashboard runtime and styles into focused modules, making future updates easier to maintain without changing the user-facing dashboard behavior.

## [2.0.2] - 2026-05-17

### 🔧 Improvements

- **Auto-precheck before launch**: `SKILL.md` now chains the install precheck in front of `serve-dashboard.ts`, so the dashboard only starts once the environment is verified. Failed checks surface verbatim with their hints — no silent auto-fixes.
- **Required vs optional install checks**: `install.ts` now distinguishes required failures (`✗`, exit 1) from optional ones (`○`, exit 0 with a notice). Missing `history.jsonl` — common for fresh Claude Code installs without chat history — no longer blocks the dashboard; the project ranking section just stays empty.

### 🐛 Bug Fixes

- **Plugin manifest version drift**: `token-atlas/.claude-plugin/plugin.json` was stuck at `1.0.0` while the marketplace tracked `2.0.x`. Both files now agree on the released version.

## [2.0.1] - 2026-05-17

### 📖 Documentation

- **README refresh for Sunrise Atlas**: Updated feature list to reflect the v2.0.0 dashboard — daily burn hero, monthly budget tracker, project drilldown modal, session ledger, anomaly panel, token composition & cache efficiency, data health diagnostics, light/dark themes, pointer-tracking bloom, animated hero wave, current-view export, and persisted preferences. Added a one-line note that the visual direction is "Sunrise Atlas — Big Sur dawn palette over a calm working surface".
- **CLAUDE.md updates for contributors**: Documented the theme system (`[data-theme]` tokens + View Transitions cross-fade), the Sunrise Bloom delight (cursor-tracking radial glow on panels/cards — with a reminder to register new panel-shaped classes in both the CSS selector list and the JS `SELECTOR` constant), and the hero wave mask animation. Added CHANGELOG.md to the project tree and switched the PRODUCT.md description from "Nordic-inflected" to "Sunrise Atlas".

## [2.0.0] - 2026-05-17

### ✨ New Features

- **Sunrise Atlas redesign**: Complete visual overhaul of the Token Atlas dashboard with a warm dawn-to-dusk palette inspired by Big Sur. Cost is now the hero metric, set against a layered animated wave band.
- **Light & dark themes**: Theme toggle that respects `prefers-color-scheme` on first load, persists your choice, and cross-fades smoothly between Dawn (light) and Dusk (dark) modes.
- **Daily burn metric**: Primary cost card now shows your average daily spend with a sparkline trend and comparison delta against the previous period.
- **Monthly budget tracker**: Configure a monthly budget and see month-to-date spend, remaining budget, and projected burn rate alongside a sunrise-spectrum progress meter.
- **Project drilldown**: Selectable project cards open a viewport-safe modal with a provider-aware model breakdown for each project.
- **Session ledger**: Unified, sortable, filterable table of recent Claude sessions and Codex threads in one place.
- **Usage anomaly panel**: Detects elevated usage days from your active baseline and surfaces which models drove the spike.
- **Token composition & cache efficiency**: New dashboard sections that break down where your tokens go and how much your prompt cache is saving you.
- **Export current view**: One-click JSON or CSV exports scoped to the active provider and date range, grouped under a single export dropdown.
- **Data health diagnostics**: Compact footer panel showing the status of each local data source (Claude, Codex, pricing) — non-fatal failures no longer block the dashboard.
- **Persisted preferences**: Your filter, range, and view choices now stick across reloads.
- **Variance comparison**: Selected ranges show deltas against the prior equivalent period, with pricing-confidence metadata so you know how solid an estimate is.
- **Loading overlay**: Animated full-screen sunrise overlay during initial data fetch, with staggered "Reading local traces" title and layered breathing waves.
- **Pointer-tracking glow**: Subtle cursor-following radial glow on interactive surfaces — fully respects `prefers-reduced-motion`.

### 🔧 Improvements

- **Typography overhaul**: Self-hosted Fraunces variable font for editorial display headings, SF Pro Rounded for hero metric values, system stack for body — full offline support.
- **Refined visual tokens**: Normalized heading sizes, panel spacing, radii, and motion tokens across the dashboard.
- **Big Sur sunrise wallpaper**: New translucent dawn and dusk background veils replace the previous Nordic-themed asset.
- **Chart palette refresh**: Claude pulls warm dawn hues (coral/amber/gold), Codex pulls cool dusk hues (violet/magenta/indigo/sky).
- **Hero wave motion**: Three-layer animated waves with organic, out-of-phase drift and skew — restrained 5–8px amplitudes.
- **Cost-first hierarchy**: Dashboard reordered so cost reads first — hero → KPI strip → budget → trend → per-model table → usage shifts → activity → ledger → data health.
- **Qwen pricing defaults**: Added qwen pricing defaults and external pricing alias resolution.

### 🐛 Bug Fixes

- **Dark mode badges**: Fixed status badges and modals showing cold-blue residue in dark mode — they now read as warm-tinted patches.

### 📖 Documentation

- **Brand pivot to Sunrise Atlas**: Rewrote PRODUCT.md brand personality from Nordic mythology to "warm, composed, watching the sun come up over your data"; added SHAPE.md design brief covering layout, states, and interaction model.

## [1.1.0] - 2026-05-13

### 🔧 Improvements

- **Dashboard sync**: Updated Token Atlas dashboard runtime and data engine to stay in sync with the latest odin-dashboard improvements — includes refined API logic and frontend presentation tweaks

## [1.0.1] - 2026-05-05

### Added

- Installation instructions for Claude plugins (CLI and TUI methods)
- Prerequisite check command for dashboard setup
- Documentation for stats-cache.json seeding via /stats command

## [1.0.0] - 2026-05-05

### Added

- Initialize Claude Code plugin marketplace with plugin registry
- Add token-atlas plugin: local web dashboard for Claude Code & Codex usage analytics
  - Overview cards, daily trends, model distribution, activity heatmap, top projects
  - Bun-based backend with zero-build frontend (petite-vue + Chart.js)
  - Pricing engine: defaults + OpenRouter live fetch + user overrides
  - Data sources: ~/.claude/ stats & history, ~/.codex/ sessions
