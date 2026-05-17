# Task 05: Add Budget And Burn Rate

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Pricing is loaded in `api.ts` from defaults, OpenRouter opportunistically, and user overrides at `~/.config/cc-dashboard/pricing.json`.

## Goal

Add a local monthly budget view that shows spend-to-date, projected month-end spend, and remaining budget.

## Requirements

- Support a user-configurable monthly budget stored locally.
- Recommended config path:
  - `~/.config/cc-dashboard/budget.json`
- Suggested config shape:

```json
{
  "monthlyBudgetUSD": 100
}
```

- If no budget file exists, show a compact setup hint and do not error.
- Display:
  - month-to-date estimated cost
  - monthly budget
  - remaining budget
  - projected month-end spend based on current daily average
  - budget usage percentage
- Use the current provider filter if practical. If budget is global only, label it clearly.

## Data Work

Add budget config reading to `api.ts` so the frontend receives:

```json
{
  "budget": {
    "monthlyBudgetUSD": 100,
    "source": "/Users/.../.config/cc-dashboard/budget.json",
    "monthToDateCostUSD": 0,
    "projectedMonthEndCostUSD": 0
  }
}
```

If provider-specific month-to-date values are easier on the frontend, expose only config from the API and compute current month spend in `app.js` from `stats.daily`.

## UX Notes

- This is a planning aid, not billing truth. Copy should say `estimated`.
- Avoid red panic states. Use restrained threshold states:
  - under 50%
  - 50-80%
  - 80-100%
  - over budget
- Keep the visual form compact, likely near overview cards.

## Acceptance Criteria

- Missing budget config does not break the dashboard.
- Valid budget config renders a budget panel with correct month-to-date and projection values.
- Projection handles early month and zero-spend months.
- Date logic uses local dates consistently with existing daily aggregation.
- Styling works on desktop and mobile.

## Out of Scope

- Editing the budget inside the dashboard.
- Multiple budgets per project.
- Alerts or notifications.
