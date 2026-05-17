# Task 07: Add Token Composition And Cache Efficiency

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Current model rows already include:

- input tokens
- output tokens
- cache read tokens
- cache creation/write tokens
- reasoning tokens
- cost

The table shows these as columns, but the dashboard does not summarize token composition or cache efficiency.

## Goal

Add a compact view that explains how token usage is composed and how much cache reuse is happening.

## Requirements

- Add token composition for the selected range and provider:
  - input
  - output
  - cache read
  - cache write
  - reasoning
- Add cache efficiency metrics:
  - cache read share of total tokens
  - cache read vs fresh input ratio
  - cache write share if present
- Show composition at summary level.
- Optionally add per-model mini composition bars inside the existing per-model table.
- Do not change cost calculation.

## Suggested Implementation

- In `app.js`, compute selected-range token buckets from `filteredByModel`.
- Add helpers:
  - `tokenComposition`
  - `cacheEfficiency`
  - `compositionPct(value, total)`
- In `index.html`, add a compact panel near the per-model cost table.
- Use segmented horizontal bars or ledger-style rows. Avoid decorative donut duplication since model distribution already uses a donut.

## UX Notes

- This is explanatory, not decorative.
- Use labels that map directly to the existing table columns.
- Do not rely on hue alone; include text values and/or labels.

## Edge Cases

- Zero total tokens.
- Models with reasoning tokens but no detailed cache fields.
- External models without cache pricing.
- Provider filters that remove all model rows.

## Acceptance Criteria

- Composition updates when date range or provider changes.
- Percentages sum sensibly within rounding tolerance.
- Zero-token state renders cleanly.
- Existing per-model cost table remains readable.
- No new API dependency is required unless the existing payload is insufficient.

## Out of Scope

- Changing token parsing.
- Changing pricing rates.
- Session-level cache analysis.
