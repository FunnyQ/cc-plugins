# Task 06: Add Pricing Confidence Panel

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Pricing defaults: `token-atlas/skills/dashboard/references/pricing-defaults.json`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Current pricing behavior:

- Defaults are loaded from `references/pricing-defaults.json`.
- OpenRouter `/api/v1/models` is fetched opportunistically with a 3s timeout.
- User overrides at `~/.config/cc-dashboard/pricing.json` win.
- Failures are silent.

## Goal

Make cost estimate trust visible by showing where pricing came from and which models used fallback pricing.

## Requirements

- Expose pricing metadata from `api.ts`.
- Show a compact `Pricing confidence` or `Estimate basis` panel in the UI.
- Include:
  - whether OpenRouter live pricing was used
  - whether user overrides were loaded
  - number of models using default pricing
  - number of models using fallback pricing
  - list of fallback-priced models, if any
- If live pricing fails, do not show an error state. Show `defaults only` or equivalent.
- If user override JSON is invalid, expose a non-fatal warning.

## Suggested API Shape

```json
{
  "pricingMeta": {
    "defaultsLoaded": true,
    "openRouter": {
      "attempted": true,
      "used": false,
      "error": null
    },
    "userOverride": {
      "path": "~/.config/cc-dashboard/pricing.json",
      "loaded": false,
      "error": null
    },
    "models": {
      "priced": 8,
      "fallback": 1,
      "fallbackModels": ["codex:unknown"]
    }
  }
}
```

Exact shape may differ, but keep it stable and documented in this task if changed.

## Implementation Notes

- `loadPricing()` currently returns only `PricingTable`. Extend it to also track metadata, or add a parallel `loadPricingWithMeta()` while keeping existing pricing calculations simple.
- Identify fallback models by comparing actual models in `byModel` against direct pricing table hits.
- Do not make OpenRouter required.
- Do not expose API keys or environment data.

## UX Notes

- Keep this informational and compact. It supports trust, it is not the main dashboard.
- Put it near the cost table footer or dashboard footer.
- Use precise labels: `override`, `live`, `default`, `fallback`.

## Acceptance Criteria

- Dashboard shows pricing basis without requiring network access.
- User override loaded state is visible.
- Fallback-priced models are visible.
- Invalid user override file does not crash dashboard.
- Existing cost calculations remain unchanged except for intentional metadata tracking.

## Out of Scope

- Editing pricing from the UI.
- Comparing prices across providers.
- Persisting OpenRouter data.
