# SHAPE

Design brief for Token Atlas dashboard. This document specifies feature scope, visual direction, user interaction, and layout constraints—not specific pixels, but the skeleton that guides frontend implementation.

## Feature Summary

Token Atlas is a cost-ledger dashboard for local Claude Code and Codex usage. Users want to **answer three questions fast:**

1. What did I spend this period?
2. Where did the tokens go (by model, project, time)?
3. What changed (anomalies, trends, cache efficiency)?

**Primary action:** Open dashboard, scan the hero cost metric, then drill into charts (trend, donut, heatmap, calendar) or project detail to understand spend.

## Design Direction

### Light Mode: "Dawn"
A warm, paper-light working surface framed by a bold sunrise wave at the top. The wave is the only high-saturation color; everything below it is restrained (muted neutrals, subtle grid lines, white space). The mood is "unfolding a map at the first light of day—calm, oriented, trustworthy."

Key visual anchors: **Big Sur default wallpaper** (organic curves, violet→magenta→coral→orange→amber→sky), **Linear app** (flat surfaces, generous spacing, single-hue focus groups), **Stripe** (dense tables, semantic color hierarchy).

### Dark Mode: "Dusk"
The same surface and typography scale, but with a **dusk-blue working surface** (oklch(22% 0.036 270)) and the wave becomes a **dusk-sky gradient** (violet→indigo→magenta, cooler than dawn). The mood is "reviewing the day's work under evening light—introspective, measured."

Text remains white (or very light warm). Charts use the same sunrise spectrum for Claude and a cool dusk palette for Codex, so the same data looks subtly different depending on theme.

## Scope

**In scope:** Hero band (cost + period + delta), KPI cards, monthly budget meter, daily trend chart, model distribution donut, per-model cost table, token composition bar, usage anomalies, top projects, activity heatmap, activity calendar, recent projects, session ledger, data health.

**Out of scope:** Project creation, config editor, user authentication, real-time sync, mobile app, email alerts, API versioning.

## Layout Strategy

### Desktop grid (1200px base)

```
[Hero band — full width, organic wave SVG, 3-layer coloring]
  ↓
[KPI strip — 4 cards, dense metrics, no borders]
  ↓
[Monthly budget — full width, meter + stats]
  ↓
[Trend + Donut — 2 cols, left wide, right compact]
  ↓
[Cost table — full width, model rows with inline meter]
  ↓
[Token composition + bar + legend — full width]
  ↓
[Usage shifts (anomalies) — full width, diagnostic]
  ↓
[Activity stack — left col: rank + heatmap + calendar, right col: projects]
  ↓
[Session ledger — full width, compact table]
  ↓
[Data health — expandable, footer-like]
```

### Responsive breakpoints

- **1200px+:** Trend + Donut in a row, Activity stack (heatmap/calendar/rank) on the left
- **768–1199px:** Trend full-width, Donut below it, Activity panels stack vertically
- **<768px:** Single column, all sections stack, heatmap/calendar scroll horizontally

## Key States

### Loading
- Spinner or skeleton cards until `/api/stats` responds
- Hero band shows loading placeholder

### Error
- Large error message, no data rendered
- Refresh button prominent

### Empty
- Cards and charts show "No data for this filter"
- Budget setup guidance if no config exists

### No selection / filters applied
- Provider filter defaults to "All"
- Range filter defaults to "Last 7 days"
- Trend chart shows top 5 models by default
- All metrics update synchronously when filter changes

## Interaction Model

### Provider & Range filters (hero band)
- Segmented control: All / Claude / Codex (mutually exclusive)
- Dropdown: 7 days / 30 days / 90 days / All time
- Clicking either filter re-fetches `/api/stats?provider=...&range=...` and updates all metrics

### Theme toggle (hero band, right side)
- Button with icon: ☼ (dawn) / ☾ (dusk)
- First load respects `prefers-color-scheme`
- User override persists in `localStorage["token-atlas.theme"]`
- Toggles `[data-theme="dark"]` on `<html>`

### Refresh (hero band)
- Button disabled while loading or refreshing
- On click, fetches fresh `/api/stats` snapshot
- Useful if user suspects stale cache

### Export (hero band, dropdown menu)
- Options: Current view JSON, Models CSV, Projects CSV
- Respects current filters (provider, range)

### Project detail modal
- Clicking a project row (in rank, ledger, or top-3 card) opens a modal
- Shows project metadata, model breakdown table, trend note (not yet available)
- Close with button, Escape key, or click outside

### Trend chart interactivity
- Toggles: All models / Top 5 models
- Toggles: Tokens / Cost
- Checkboxes: Individual model visibility
- Checkbox unchecking persists to `localStorage["token-atlas.selectedModels"]`

### Tables
- Clickable rows for project detail (no hover highlight; only focus ring)
- Inline meters (cost share vs highest) with tooltips
- Responsive: columns stack under breakpoints

## Content Requirements

### Hero band
- **Brand name & logo** (Token Atlas, small icon)
- **Period label** (e.g., "Last 7 days", "2024-11-01 to 2024-11-07")
- **Cost metric** (large, bold white or near-black: `$1,234.56`)
- **Delta** (if previous period available: `↑ 12% · vs last 7 days` or `↓ 8% · vs last 30 days`)

### KPI cards
- **Estimated cost:** total usage-based estimate
- **Tokens:** total input + output + cache reads/writes + reasoning
- **Interactions:** Claude messages + Codex threads
- **Sessions:** unique Claude sessions + Codex threads
- Each card shows delta vs previous period (↑ / ↓, pct + context label)

### Daily trend chart
- **X-axis:** dates, labels every 7 days or aligned to week start
- **Y-axis:** tokens or cost (auto-scale)
- **Legend:** colored dots + model names, check/uncheck to toggle
- **Series fill:** optional wave fill at 0 (to evoke Big Sur)
- **Grid:** light, muted
- **Tooltip:** dark background (chart-tooltip-bg), white text, shows model name + value + date

### Model distribution donut
- **Center label:** "123 models" or "All time"
- **Legend:** color swatch + model name + pct + absolute value
- **Hover:** tooltip shows exact pct
- **Colors:** sunrise spectrum (coral, amber, gold, violet, magenta), mapped from data

### Cost table
- **Columns:** Model, Source, Input, Output, Cache read, Cache write, Reasoning, Cost
- **Inline meter:** cost share vs highest (0–100% fill, same color as model mark)
- **Badges:** "ext" for external models (OpenRouter, etc.)
- **Footer:** pricing confidence summary, fallback models if any

### Monthly budget meter
- **Track:** background (surface-2)
- **Fill:** ramp from amber → orange → coral → magenta (based on usage %)
- **Label:** "$X of $Y" + "N% used"
- **Stats below:** Remaining, Projected, Projected use %

### Token composition bar
- **Segments:** sky / coral / amber / orange / violet (input / output / cache-read / cache-write / reasoning)
- **Width:** each segment scaled to % of total tokens
- **Legend:** below bar, showing label + count + %

### Activity heatmap
- **Grid:** 7 rows (days of week), 24 columns (hours of day)
- **Color ramp:** violet (cold) → magenta (warm) → no hotter end (stops before coral)
- **Labeling:** Hours on top (0, 3, 6, ...), Days on left (Mon, Tue, ...)
- **Cells:** `title="Monday 14:00 · 1,234 tokens"`, no interaction

### Activity calendar
- **Layout:** ISO week grid (52–53 columns for full year, Sat–Sun on right)
- **Color ramp:** coral (few) → orange (moderate) → amber (high) — warm sunset end
- **Month labels:** Jan, Feb, ... (each above its first week)
- **Day labels:** Mon, Wed, Fri (only odd rows)
- **Cells:** small squares, `title="2024-11-15 · 5 interactions"`, no interaction

### Project detail modal
- **Header:** Project name + path (code), close button
- **Metadata:** First seen, Last seen, Tokens, Cost
- **Split:** Claude tokens + cost, Codex tokens + cost
- **Table:** Model breakdown (all-time project totals, not filtered by range)

## Recommended Impeccable References

- **Big Sur wallpaper** (macOS default, 2020): Organic curves, warm dawn palette, horizon focus
- **Linear** (app.linear.dev): Flat surfaces, generous spacing, dense tables, restrained color
- **Stripe Dashboard** (stripe.com/dashboard): Semantic color hierarchy, accessible typography, card grid with breathing room
- **Apple Music** (iOS, Now Playing): Atmospheric color blending, white text on colored surface, restrained chrome

## Open Questions

1. **Activity wall calendar:** Should we show week numbers (ISO 8601) on the left?
2. **Project detail:** Should we include a "Project trend" (daily cost over window) inside the modal?
3. **Heatmap interactivity:** Should clicking a cell drill into sessions for that hour?
4. **Mobile heatmap/calendar:** Should we offer a "compact view" (just month + day-of-week, no hour detail)?
5. **Anomaly thresholds:** What constitutes a "shift"? (e.g., 2x previous day, or top 10% variance?)
