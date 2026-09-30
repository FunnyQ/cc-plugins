# Usage Dashboard Reference

Human-facing overview for the usage dashboard skill.

## Sections

- **Provider switch** — All / Claude / Codex / OpenCode, with All as the combined default
- **Overview cards** — sessions, interactions, tokens, estimated cost from local usage (filtered by date range)
- **Daily trend** — line chart per provider model with Tokens/Cost switch and multi-select toggle
- **Model distribution** — donut chart filtered by date range and provider
- **Per-model cost & tokens table** — provider, input/output/cache/reasoning breakdown with USD estimate, filtered by date range
- **Activity heatmap** — 7d × 24h grid plus GitHub-style daily activity wall built from local activity data
- **Top projects** — ranked by message count with % bar
- **Recent activity** — projects sorted by last seen

## File layout

The engine and server are Rust: `packages/monitor/cockpit-rs/src/atlas/`, run as `cockpit atlas serve|stats|live|rollup-update|statusline`.

```
usage-dashboard/
├── SKILL.md
├── contract/               # black-box suite + golden/ fixtures for `cockpit atlas`
├── dashboard/dist/           # static frontend (no build step)
│   ├── index.html
│   ├── app.js
│   ├── styles/                # 12 sheets, linked individually from index.html
│   └── vendor/
│       ├── petite-vue.es.js
│       └── chart.umd.js
└── references/
    └── pricing-defaults.json
```
