# cc-plugins

A local Claude Code plugin marketplace. Private plugins for extending Claude Code with custom skills.

## Plugins

| Plugin | Description |
|--------|-------------|
| [token-atlas](./token-atlas) | Local web dashboard for Claude Code & Codex usage — sessions, tokens, cost, model mix, project activity |

## Installation

### CLI

```bash
claude plugins add-marketplace --source github --repo FunnyQ/cc-plugins
claude plugins install token-atlas
```

### TUI (interactive)

1. Open Claude Code
2. Type `/plugins` to open the plugin manager
3. Select **Add Marketplace** → enter `FunnyQ/cc-plugins`
4. Select **Install Plugin** → choose `token-atlas`

The skill runs a prerequisite check automatically before launching the dashboard, so there's no manual setup step. If something's missing, the hint will be surfaced — the most common case is `stats-cache.json` not yet existing; just run `/stats` once in Claude Code to seed it.

If you want to run the precheck yourself:

```bash
bun $CLAUDE_PLUGIN_ROOT/skills/dashboard/scripts/install.ts
```

## token-atlas

A single-page dashboard that reads your local `~/.claude/` and `~/.codex/` data and visualizes it in a browser. No telemetry, no cloud — everything stays on your machine.

The visual direction is **Sunrise Atlas** — Big Sur dawn palette over a calm working surface, designed for repeated daily use.

### Features

- **Daily burn hero** — today's spend as the primary metric, with sparkline and 7-day delta
- **Monthly budget tracker** — month-to-date spend, remaining budget, projected burn
- **Overview cards** — sessions, interactions, tokens, estimated cost
- **Daily trend** — stacked bar chart per model with Tokens/Cost toggle
- **Model distribution** — donut by provider, with a per-model breakdown table (input/output/cache/reasoning + USD)
- **Project rankings + drilldown modal** — top projects by message count, click for per-model detail
- **Session ledger** — recent Claude and Codex sessions side by side
- **Anomaly panel** — flags days that broke from your baseline
- **Token composition & cache efficiency** — input vs cache-read vs output share
- **Activity heatmap + activity wall** — 7d × 24h grid + GitHub-style daily wall
- **Data health diagnostics** — surfaces non-fatal source-read failures
- **Light + dark themes** — View Transitions cross-fade, honors `prefers-color-scheme`
- **Pointer-tracking bloom** — warm light glides behind the cursor on hover; respects `prefers-reduced-motion`
- **Animated hero wave** — sunrise band drifts slowly along its wavy bottom edge
- **Current-view export** — JSON / CSV of whatever filters are active
- **Persisted preferences** — provider filter, theme, comparison window
- **Provider filter** — All / Claude / Codex

### Prerequisites

- [Bun](https://bun.sh) runtime
- At least one Claude Code session (run `/stats` once to seed `stats-cache.json`)

### Quick Start

```bash
bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts
```

Opens `http://localhost:5938` in your default browser.

### Options

```
--port <n>    Use a different port (default: 5938)
--no-open     Don't auto-open browser
```

### Pricing

Token costs are estimated using bundled defaults (`references/pricing-defaults.json`). On startup, live prices are fetched from OpenRouter (3s timeout, silent fail). You can override with a custom file:

```
~/.config/cc-dashboard/pricing.json
```

```json
{
  "models": {
    "claude-opus-4-7": { "input": 5.00, "output": 25.00, "cacheRead": 0.50, "cacheWrite": 6.25 }
  }
}
```

## Adding a New Plugin

1. Create a directory with `.claude-plugin/plugin.json`
2. Add skills under `skills/<skill-name>/SKILL.md`
3. Register in `.claude-plugin/marketplace.json`

## License

MIT
