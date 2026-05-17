# Task 04: Add Cost Anomaly Detection

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

The dashboard already has daily totals in `stats.daily`, including tokens, cost, provider breakdown, and usage by model.

Product direction: help the user understand "what changed" and "where tokens went" quickly. This feature should identify unusual cost/tokens without feeling alarmist.

## Goal

Add a lightweight anomaly panel that identifies unusually high usage days and explains the main driver.

## Requirements

- Detect anomalies for the currently selected provider and date range.
- Start with simple robust statistics:
  - use median daily cost/tokens as baseline
  - flag days above a configurable hardcoded multiplier, for example 2x median, with a minimum absolute cost/token threshold
- For each anomaly, show:
  - date
  - cost and/or token total
  - ratio vs baseline
  - top contributing model
- Keep wording calm:
  - Good: `May 12 ran 2.4x above the 30-day median. Main driver: Claude Sonnet.`
  - Avoid: `Warning! Dangerous spike!`
- If no anomalies exist, show a compact empty state.

## Suggested Implementation

- Compute anomalies on the frontend from `filteredDaily`.
- Add helpers in `app.js`:
  - `median(values)`
  - `usageAnomalies`
  - `topModelForDay(day, metric)`
- Add a compact panel near the daily trend or summary cards.
- Style as a restrained ledger note, not a bright alert.

## Edge Cases

- No daily data.
- Fewer than 5 days in the selected range.
- Median is 0.
- A single-day range.
- Days with cost but no model usage details.

## Acceptance Criteria

- Anomalies update when range or provider changes.
- No anomaly is shown for "not enough data" unless there is a meaningful baseline.
- Top model attribution is correct based on the selected metric.
- The feature does not add new API dependencies.
- No console errors when daily data is empty.

## Out of Scope

- Machine learning.
- User-configurable anomaly thresholds.
- Notifications.
