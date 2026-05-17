# Task 01: Add Variance Comparison

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

The dashboard is a petite-vue + Chart.js single page app served by Bun:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Current dashboard features include provider switch, date range filter, overview cards, daily trend chart, model distribution, per-model cost table, hourly rhythm, daily calendar, top cost projects, and recent projects.

Product direction: precise, composed, quietly technical. This is a local usage ledger, not a generic SaaS analytics page. Avoid decorative chart clutter, glassmorphism, neon observability styling, and literal fantasy UI.

## Goal

Add a comparison layer that explains how the selected range changed versus the immediately previous range of the same length.

Example: if the user selects "Last 7 days", compare those 7 days against the 7 days immediately before them. If the user selects "Last 30 days", compare against the previous 30 days. For "All time", comparison should be disabled or shown as unavailable.

## Requirements

- Show deltas for:
  - estimated cost
  - tokens
  - interactions
  - sessions
  - tool calls
- Deltas should include absolute change and percentage change where possible.
- Handle zero baseline gracefully:
  - If previous value is 0 and current is non-zero, show `new activity` or equivalent.
  - If both are 0, show no change.
- Keep provider filtering consistent:
  - All / Claude / Codex should affect both current and comparison windows.
- Do not require new data files. Use existing `stats.daily` payload.
- Do not change pricing logic unless needed for this task.

## Suggested Implementation

- Add computed helpers in `dashboard/dist/app.js`:
  - `comparisonDaily`
  - `comparisonSummary`
  - `summaryDeltas`
  - a formatter for delta labels/classes
- Reuse existing `filterDayByProvider(day)` so provider filtering matches current summary logic.
- Add compact delta indicators to the existing overview cards in `index.html`.
- Add minimal styles in `style.css` for positive, negative, neutral, and unavailable deltas.

## UX Notes

- Cost increase should not automatically be styled as "good". Use neutral language like `+$3.20 vs previous 7d`.
- Keep the card hierarchy focused on the current value. Delta is supporting context.
- Do not add another large chart for this task.

## Acceptance Criteria

- Switching date range updates both current totals and comparison deltas.
- Switching provider updates both current totals and comparison deltas.
- "All time" does not show misleading percentage deltas.
- The dashboard still renders when there are fewer historical days than the comparison window.
- No console errors during refresh, range switch, or provider switch.

## Out of Scope

- Anomaly detection.
- Project-level drilldown.
- Budget forecasting.
- Persisted preferences.
