# Changelog

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
