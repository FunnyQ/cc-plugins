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

After installation, run the prerequisite check inside Claude Code:

```bash
bun $CLAUDE_PLUGIN_ROOT/skills/dashboard/scripts/install.ts
```

This verifies that Bun is available, vendor files are in place, and Claude data sources exist. If `stats-cache.json` is missing, run `/stats` once in Claude Code to seed it.

## token-atlas

A single-page dashboard that reads your local `~/.claude/` and `~/.codex/` data and visualizes it in a browser. No telemetry, no cloud — everything stays on your machine.

### Features

- **Overview cards** — sessions, interactions, tokens, estimated cost
- **Daily trend** — line chart per model with Tokens/Cost toggle
- **Model distribution** — donut chart by provider
- **Per-model table** — input/output/cache/reasoning token breakdown with USD estimate
- **Activity heatmap** — 7d × 24h grid + GitHub-style daily activity wall
- **Top projects** — ranked by message count
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
