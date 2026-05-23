# UI-01: SPA shell & 3-column layout

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: server/02
> **Blocks**: ui/02, ui/03, ui/04
> **Status**: todo

## Goal

A no-build petite-vue SPA shell: top project-goal bar, left session side-rail (active first, click to select), and a 3-column main area (live transcript │ decision log │ info) scaffolded with placeholder panels.

## Files to create / modify

- `cockpit/skills/cockpit/dashboard/dist/index.html` (new) — page shell, imports vendor libs + app.js.
- `cockpit/skills/cockpit/dashboard/dist/app.js` (new) — petite-vue app: fetch + poll `/api/projects`, `/api/sessions`; selection state; layout.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (new) — layout (goal bar, side-rail, 3-column grid).

## Implementation notes

### Layout (target)

```
┌─ PROJECT GOAL ─────────────────────────────┐
├──────┬──────────────────────────────────────┤
│ sess │  live        decision      info       │
│ ▸ A  │  transcript   log           goal/meta  │
│   B  │  (col 1)      (col 2)        (col 3)    │
└──────┴──────────────────────────────────────┘
```

- **Top bar**: selected project's `projectGoal`.
- **Side-rail**: sessions from `/api/sessions`, **active first**; each shows a short session-goal + an active/ended dot. Click selects (sets `selectedSessionId`).
- **Main**: CSS grid, 3 equal-ish columns. Each column is an independent panel with a header; bodies are placeholders this task — the later per-column tasks fill them.

### petite-vue wiring

- Import `petite-vue.es.js` from `./vendor/`. Use `createApp({...}).mount()`.
- State: `projects`, `sessions`, `selectedProject`, `selectedSessionId`.
- On load: `fetch('/api/projects')` + `fetch('/api/sessions')`; **poll `/api/sessions` every 3s** (pause when the tab is hidden — `document.visibilitychange`), mirroring token-atlas's live polling.
- Selecting a session sets `selectedSessionId` and `selectedProject` (its `project`). The three columns key off these (so the column tasks can open their SSE streams).
- No router, no build. Match `token-atlas/.../dashboard/dist/app.js` module style (ES modules, `./modules/*.js`).

### Styling

- Modern CSS (CSS variables, grid, scoped via class names). No Tailwind.
- Define CSS custom properties for colors/spacing on `:root` (the theming task overrides these from DESIGN.md).
- Active session row visually distinct from ended (ended = muted/read-only look).

## Acceptance criteria

- [ ] Opening `/` renders the goal bar, a session side-rail, and three labeled columns.
- [ ] Sessions load from `/api/sessions`, active ones listed first, ended ones visually muted.
- [ ] Clicking a session highlights it and sets the selected session/project state.
- [ ] `/api/sessions` is polled every 3s and pauses while the tab is hidden.
- [ ] Project-goal bar shows the selected project's goal.
- [ ] No build step — page works by opening the served `index.html`; vendor libs load from `./vendor/`.

## Verification

- [ ] With the daemon running and at least one seeded session, load `localhost:5858/` in a browser (Q): side-rail shows the session, columns render as placeholders.
- [ ] Toggle a session active→ended (stale heartbeat) → side-rail reflects the status on next poll.
- [ ] Check the browser console: no module/load errors.

## Out of scope

- Column **content** (transcript / log / info rendering) — Deferred to the per-column tasks.
- Per-project theming from DESIGN.md — Deferred to the theming task (this task ships neutral default tokens).
