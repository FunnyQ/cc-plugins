# Changelog

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
