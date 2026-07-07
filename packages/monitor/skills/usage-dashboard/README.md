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

```
usage-dashboard/
├── SKILL.md
├── scripts/
│   ├── api.ts                # data engine (also CLI: prints JSON)
│   ├── atlas-server.ts       # HTTP server + auto-open
│   └── statusline-collector.ts # captures live rate_limits and chains ccstatusline
│                             # (precheck install.ts + setup-statusline.ts now live in the install skill)
├── dashboard/dist/           # static frontend (no build step)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── vendor/
│       ├── petite-vue.es.js
│       └── chart.umd.js
└── references/
    └── pricing-defaults.json
```
