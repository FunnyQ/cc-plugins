# FRONTEND-01: Remove goal rendering from the dashboard

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/03
> **Blocks**: docs/01
> **Status**: done

## Goal

Strip every goal-related element from the cockpit dashboard SPA so it renders the decision
trail cleanly with no goal header, no session-goal snippet, and no dead goal styling.

## Files to create / modify

All under `packages/monitor/skills/cockpit/dashboard/dist/`:

- `modules/decision-log.js` (modify)
- `modules/project-rail.js` (modify)
- `app.js` (modify)
- `index.html` (modify)
- `style.css` (modify)

No build step — edit the committed `dist/` files directly.

## Implementation notes

Line numbers are approximate — verify against the files. Remove, don't just hide.

### `modules/decision-log.js`

- In `handle(rec)` (~lines 635–637) drop the `rec.type === "goal"` branch so a goal record
  is **silently ignored** (not rendered, not thrown) — that is how legacy logs stay
  tolerated. Make sure `handle` no-ops on an unrecognized/goal `type` rather than crashing.
- `recordKey(rec)` (~line 73): **remove** the `if (rec.type === "goal") return "goal";`
  line too — it is dead once goals are never rendered, and leaving it would fail the
  goal-free grep gate below.
- `renderGoal(rec)` (~lines 357–362): delete the function.
- The `.decision-log__goal` HTML scaffold (~lines 137–142): remove.

### `modules/project-rail.js`

- `goalSnippet(text, max)` (~lines 12–16): delete (and its export).
- `projectGoalOf(...)` and the `goal:` field in `groupSessionsByProject()` (~lines 27–55,
  esp. 47): remove the goal attachment.

### `app.js`

- Remove the `goalSnippet` import (~line 7).
- Delete getters `selectedProjectGoal` (~87–93) and `selectedSessionGoal` (~116–119).
- Delete methods `goalSnippet(text)` (~283–285) and `shortGoal(s)` (~310–313).

### `index.html`

- Remove `<span class="leg__goal" v-text="shortGoal(s)">` (~line 168).
- **Hero subtitle binding (~line 49)**: it reads
  `v-text="selectedSessionGoal || selectedProjectGoal || 'Select a session to begin'"`.
  Those two getters are being deleted from `app.js`, so this binding would dangle. Replace
  the expression with just the fallback — `v-text="'Select a session to begin'"` (or a
  session-label binding that does not reference goals). Removing the getters without fixing
  this line breaks the hero render.

### `style.css`

- Remove `.leg__goal` (~815–820) and the `.decision-log__goal*` block (~1277–1301).

## Acceptance criteria

- [x] No goal header, session-goal text, or project-goal snippet renders anywhere in the dashboard.
- [x] `renderGoal`, `goalSnippet`, `shortGoal`, `selectedProjectGoal`, `selectedSessionGoal` are all gone.
- [x] A legacy log whose line 1 is `{type:"goal",...}` does not crash the stream — the record is skipped.
- [x] No `leg__goal` / `decision-log__goal` references remain in `index.html` or `style.css`.
- [x] No leftover imports/usages reference removed functions (no console ReferenceErrors).

## Verification

- [x] `grep -rn "goal\|Goal" packages/monitor/skills/cockpit/dashboard/dist/` returns only unrelated matches (none in app.js/index.html/project-rail.js/decision-log.js/style.css).
- [x] Manual (owner's dev server): open a session with decision entries — trail renders, no goal UI, no console errors. Open a session whose log still has a legacy goal line — no crash.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Frontend has no automated tests — Correctness folds in no-regression on the owner's dev server.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | dashboard errors or goal UI remains | goal UI gone but legacy goal log crashes | goal UI fully removed; legacy goal record skipped; no console errors |
| Test coverage | ×2 | no verification path | only "it loads" | both manual checks (clean session + legacy-goal session) specified & done |
| Interface & readability | ×1 | dead functions/CSS left | mostly clean | no orphaned fns, imports, or CSS classes |
| Assumptions & docs | ×1 | silent partial removal | partial | confirms grep-clean across all five files |

## Out of scope

- The project-description prose panel — there is **no** frontend consumer of `/api/project-info`
  in `dashboard/dist/` (verified: a tree grep for `project-info`/`projectInfo` finds nothing).
  The prose field is dropped server-side, so there is nothing to remove in the SPA.
