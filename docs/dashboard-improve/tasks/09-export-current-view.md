# Task 09: Export Current View

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Current dashboard has filtered views for date range and provider, but no export.

## Goal

Allow the user to export the currently filtered dashboard data as CSV and JSON for local analysis or record keeping.

## Requirements

- Add export controls for:
  - JSON export of the current filtered view
  - CSV export of per-model rows
  - CSV export of project rows
- Exports must respect current provider and date range filters where the frontend has enough data.
- File names should include:
  - `token-atlas`
  - provider key
  - range key
  - current date
- Generate exports entirely in the browser. No server write required.
- Use Blob downloads.

## Suggested JSON Shape

```json
{
  "exportedAt": "2026-05-17T00:00:00.000Z",
  "filters": {
    "provider": "all",
    "range": "7"
  },
  "summary": {},
  "daily": [],
  "models": [],
  "projects": []
}
```

## Suggested Implementation

- Add utility methods in `app.js`:
  - `exportCurrentViewJSON()`
  - `exportModelsCSV()`
  - `exportProjectsCSV()`
  - `downloadBlob(filename, content, mimeType)`
  - `toCSV(rows)`
- Add a compact export menu or button group in the topbar or footer.
- Escape CSV fields correctly. Do not hand-roll partial escaping that breaks commas, quotes, or newlines.

## UX Notes

- Keep export controls secondary. They should not compete with core filters.
- Use clear labels: `Export JSON`, `Models CSV`, `Projects CSV`.
- Avoid adding a modal.

## Acceptance Criteria

- JSON export downloads and contains current filters, summary, daily rows, models, and projects.
- CSV model export downloads valid CSV with headers.
- CSV project export downloads valid CSV with headers.
- Exports work after switching provider/range.
- No server-side files are created.

## Out of Scope

- PDF export.
- Chart image export.
- Importing exported files.
