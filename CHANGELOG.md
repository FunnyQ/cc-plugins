# Changelog

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
