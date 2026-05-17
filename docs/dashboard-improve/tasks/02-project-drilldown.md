# Task 02: Add Project Drilldown

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Current project surfaces:

- `Top 3 projects (by cost)`
- `Recent projects` with Tokens/Cost toggle

The current `projects` payload already includes project path, name, message counts, Claude/Codex counts, tokens, cost, firstSeen, lastSeen, and provider split.

Product direction: this should feel like a serious local ledger. Favor dense, readable operational detail over decorative cards.

## Goal

Allow the user to select a project and inspect usage details for that project without leaving the dashboard.

## Requirements

- Add an inline project detail panel or drawer-like section. Avoid a modal as the first implementation.
- Selecting a project from either project list should open/update the detail view.
- The project detail view should show:
  - project name and full path
  - first seen and last seen
  - total tokens and total cost
  - Claude vs Codex split
  - model breakdown for this project
  - daily cost/tokens trend for this project if data is available
- The selected project should be visually identifiable in project lists.
- Provide a clear close/back control.
- Respect the current provider filter where practical. If project totals are all-time, label that clearly.

## Data Work

`api.ts` currently computes `projectModelUsage` internally for Claude and Codex, but the public `projects` rows do not expose model-level project breakdowns.

Extend each project row with a `models` array. Suggested shape:

```json
{
  "model": "claude:claude-sonnet-4-...",
  "provider": "claude",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheCreationTokens": 0,
  "reasoningTokens": 0,
  "costUSD": 0,
  "isExternal": false
}
```

If daily project trend is too invasive for this slice, implement the model breakdown first and leave daily project trend as a follow-up note inside the file or PR summary.

## Suggested Implementation

- In `api.ts`, expose project model breakdown using existing `transcriptUsage.projectModelUsage` and `codexUsage.projectModelUsage`.
- In `app.js`, add:
  - `selectedProjectPath`
  - `selectedProject`
  - `selectProject(path)`
  - `clearSelectedProject()`
  - helper methods for project model totals and provider split
- In `index.html`, make project items buttons or otherwise keyboard-accessible controls.
- Add detail section near the project ranking area, not at the very top of the page.

## Accessibility

- Project rows must be keyboard selectable.
- Selected state must not rely on color alone.
- The close/back control must have an accessible label.

## Acceptance Criteria

- Clicking a project opens a detail view with correct totals.
- Selecting a different project updates the same detail view.
- Provider split and model breakdown match project totals within rounding tolerance.
- Keyboard users can select and close the project detail.
- Empty/missing model data is handled with a clear empty state.

## Out of Scope

- Session-level drilldown.
- File-level activity.
- Opening the project in an editor.
