# UI-05: Multi-project nesting

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
>
> **Depends on**: ui/01, server/02
> **Status**: done

## Goal

The side-rail groups sessions under their project (project → sessions), so Q can see multiple projects at once and expand each project's session swimlanes. Selecting a session still drives the same 3-column detail.

## Files to create / modify

- `cockpit/skills/cockpit/dashboard/dist/app.js` (modify) — group sessions by project; expand/collapse state.
- `cockpit/skills/cockpit/dashboard/dist/modules/project-rail.js` (new) — the nested rail component.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (modify) — nested rail styling.

## Implementation notes

The session model already solved the hard part; this is **layout only** (the concept doc: "多專案 = 再加一層 nesting; session model 一解，多專案只剩 layout").

### Data

- `GET /api/projects` returns projects with `projectGoal`, `activeCount`, `sessionCount`.
- `GET /api/sessions` returns all sessions (each carries its `project`).
- Group sessions by `project` client-side; order projects with active sessions first, then by most-recent activity.

### Rail structure

```
▾ project A   (goal snippet)        ● 1 active / 3
    ▸ session a1  active
      session a2  ended
▾ project B   (goal snippet)        ● 0 active / 1
      session b1  ended
```

- Each project row: name (basename of path), goal snippet, active/total counts.
- Expand/collapse per project (default: expand projects with an active session, collapse fully-ended ones).
- Clicking a session selects it (sets `selectedProject` + `selectedSessionId`) exactly as before — the 3 columns and the goal bar react unchanged.
- The top goal bar shows the **selected** project's goal.

### Polling

Reuse the existing `/api/sessions` 3s poll; just regroup on each refresh. Preserve expand/collapse and selection across refreshes.

## Acceptance criteria

- [x] The rail shows projects as parents with their sessions nested beneath.
- [x] Projects with active sessions sort first and default to expanded; fully-ended projects default collapsed.
- [x] Each project row shows a goal snippet and active/total session counts.
- [x] Selecting any session under any project drives the 3-column detail and updates the goal bar.
- [x] Expand/collapse and selection survive the 3s poll refresh.

## Verification

- [x] Seed two projects (each with a `cockpit start`), daemon running: the SPA rail (Q) shows both projects, each with its session(s) nested.
- [x] Collapse project A, wait through a poll → A stays collapsed.
- [x] Select a session in project B → goal bar shows B's goal and the columns load B's session.

## Out of scope

- Cross-project aggregation / search — not needed; the rail is navigational.
- Changing the 3-column detail — it stays single-session; this task only adds the grouping layer above it.
