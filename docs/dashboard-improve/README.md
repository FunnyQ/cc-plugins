# Dashboard Improvement Plan

This folder contains self-contained implementation tasks for improving the Token Atlas dashboard at `token-atlas/skills/dashboard/`.

Each task in `tasks/` is written so an agent can work from that file alone. Use this README for dependency ordering and parallel execution.

## Task Index

- `tasks/01-variance-comparison.md` — compare the selected range with the previous equal-length range.
- `tasks/02-project-drilldown.md` — inspect one project's totals and model breakdown.
- `tasks/03-session-thread-ledger.md` — add a row-level ledger for Claude sessions and Codex threads.
- `tasks/04-cost-anomaly-detection.md` — identify unusual high-usage days.
- `tasks/05-budget-burn-rate.md` — show monthly budget and projected spend.
- `tasks/06-pricing-confidence.md` — expose pricing source and fallback metadata.
- `tasks/07-token-composition-cache-efficiency.md` — explain token buckets and cache reuse.
- `tasks/08-persisted-preferences.md` — persist dashboard UI preferences in localStorage.
- `tasks/09-export-current-view.md` — export current filtered data as JSON/CSV.
- `tasks/10-data-health-diagnostics.md` — show local source health and counts.

## Dependency Graph

Can start independently:

- `01-variance-comparison`
- `04-cost-anomaly-detection`
- `07-token-composition-cache-efficiency`
- `08-persisted-preferences`
- `09-export-current-view`

API metadata tasks with mostly independent ownership:

- `05-budget-burn-rate`
- `06-pricing-confidence`
- `10-data-health-diagnostics`

Should wait until API shapes stabilize:

- `02-project-drilldown` depends on project model breakdown data.
- `03-session-thread-ledger` depends on a unified row-level ledger data shape.

## Recommended Parallel Waves

Wave 1:

- `01-variance-comparison`
- `06-pricing-confidence`
- `08-persisted-preferences`

Wave 2:

- `04-cost-anomaly-detection`
- `07-token-composition-cache-efficiency`
- `09-export-current-view`
- `10-data-health-diagnostics`

Wave 3:

- `05-budget-burn-rate`
- `02-project-drilldown`
- `03-session-thread-ledger`

## Coordination Notes

- Many frontend tasks touch `dashboard/dist/app.js`, `dashboard/dist/index.html`, and `dashboard/dist/style.css`; avoid running too many UI workers at once unless each has a narrow ownership boundary.
- Prefer API-only or metadata tasks in parallel with one UI-heavy task.
- Do not start `02` or `03` until the API payload shape they need is explicit and verified.
- Commit coherent verified slices. If multiple workers touched the same frontend files, integrate first, then commit the merged slice.
