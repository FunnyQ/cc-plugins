# Task 08: Persist Dashboard Preferences

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

The dashboard currently has several controls:

- provider: All / Claude / Codex
- range: Last 7 / 30 / 90 days / All time
- daily trend mode: Tokens / Cost
- trend model scope: All / Top 5
- recent projects metric: Tokens / Cost
- selected trend models

These reset when the page reloads.

## Goal

Persist lightweight UI preferences in `localStorage` so repeated use keeps the user's preferred dashboard view.

## Requirements

- Persist:
  - providerKey
  - rangeKey
  - trendMode
  - trendModelScope
  - topProjectMode
  - selectedModels where possible
- Restore preferences on initial app creation before first render.
- Validate restored values against allowed options.
- If stored data is invalid, ignore it and continue.
- Do not persist fetched stats data.
- Do not write files to disk for this task.

## Suggested Implementation

- Add a storage key, for example `token-atlas:prefs:v1`.
- Add methods in `app.js`:
  - `loadPrefs()`
  - `savePrefs()`
  - `normalizePrefs(raw)`
- Call `loadPrefs()` during app initialization.
- Call `savePrefs()` when relevant controls change.
- After stats load, reconcile `selectedModels` with available models.

## Edge Cases

- `localStorage` unavailable or throwing due to browser settings.
- Selected model no longer exists.
- New model appears after refresh.
- Stored range/provider values are unknown.

## Acceptance Criteria

- Reloading the dashboard restores provider, range, trend mode, trend scope, and project metric.
- Invalid localStorage content does not crash the app.
- New models default to selected unless user preference clearly disables them.
- Existing controls continue to work before and after auto-refresh.

## Out of Scope

- Syncing preferences across browsers.
- Server-side settings.
- Persisting budget or pricing config.
