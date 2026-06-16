# DOCS-02: Final review — whole-system gate

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/01, backend/02, backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04, docs/01
> **Status**: done
> **Final review**: true

## Goal

Holistically verify the consolidated cockpit: the three skills became one automatic system,
goals/project-meta/start are gone, global language config drives entries, and nothing that
had to be preserved (the `needs_your_call`/`wait`/`send` bridge, legacy-log tolerance) broke.

## Files to create / modify

- None expected. This is a review gate. If it finds defects, file fixes against the relevant
  bucket's task rather than patching blindly here; only make a small correction inline if it
  is trivial and clearly within an already-completed task's intent.

## Implementation notes

This gate scores **integration and goal-fit**, not a re-score of individual tasks. Walk the
whole deliverable end to end:

### Integration checks

- `bun test packages/monitor/skills/cockpit/scripts/` is fully green (config, cockpit,
  registry, project-info, call-log, and untouched suites).
- `cockpit config --log-language zh-TW` then `cockpit config get-language` → `zh-TW`; with
  no config → `English`. (Use a temp `XDG_CONFIG_HOME`.)
- A fresh session can `cockpit scribe`/`cockpit log` with **no** prior `start` and registers.
- The `needs_your_call` / `wait` / `send` bridge still functions (autopilot's dependency).

### Consistency checks

- One skill only: `packages/monitor/skills/` no longer contains `cockpit-scribe/` or
  `thoughtful/`; `cockpit/SKILL.md` routes to `pilot.md` + `scribe.md`.
- `commands/thoughtful.md` exists; the second `SessionStart` hook is present and the manifest
  is valid JSON with `mcpServers` + `channels` intact.
- No live references to goals / `project-meta.md` / `cockpit start` anywhere in
  `packages/monitor/skills/cockpit/` source or `CLAUDE.md`.
- scribe.md and pilot.md resolve language via `cockpit config get-language` (no project-meta
  grep), and resolve the CLI from the same-skill base dir.

### Regression checks

- A legacy log with a line-1 `type:"goal"` record does not crash the dashboard stream or the
  call-log reader.
- Dashboard (owner's dev server) renders the decision trail with no goal UI and no
  project-prose panel, no console errors.

### Goal-fit

- Confirm the PLAN's outcome holds: open a session → auto-logging happens (Claude via hook),
  the only human-set config is the global `log_language`.

## Acceptance criteria

- [x] Full cockpit test suite is green.
- [x] Language round-trips via the CLI; defaults to English with no config.
- [x] No-start auto-registration verified; `needs_your_call`/`wait`/`send` intact.
- [x] `cockpit-scribe/` and `thoughtful/` skill dirs are gone; one cockpit skill routes to both modes.
- [x] No live goal / project-meta / start references remain in cockpit source or CLAUDE.md.
- [x] Legacy goal-record tolerance holds (no crash); dashboard has no goal/prose UI, no console errors.
- [x] Any defects found are logged against the owning task, not silently patched.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/` green.
- [x] `grep -rn "project-meta\|cmdStart\|GoalRecord\|session_goal\|project_goal" packages/monitor/skills/cockpit/scripts/ packages/monitor/skills/cockpit/SKILL.md packages/monitor/skills/cockpit/references/` returns nothing.
- [x] Dashboard dist is clean too: `grep -rni "goal" packages/monitor/skills/cockpit/dashboard/dist/ | grep -v vendor` returns nothing — this catches `leg__goal`, `decision-log__goal`, `projectGoal`, `sessionGoal`, `selectedSessionGoal`, `selectedProjectGoal`, `renderGoal`, `goalSnippet`, `shortGoal`, and any user-facing "set a goal" text. (The hero subtitle binding at `index.html` must no longer reference goal getters.)
- [x] Plugin manifests advertise no goals: `grep -in "goal" packages/monitor/.claude-plugin/plugin.json packages/monitor/.codex-plugin/plugin.json` returns nothing; both parse as valid JSON.
- [x] `ls packages/monitor/skills/` shows no `cockpit-scribe` / `thoughtful`; `ls packages/monitor/commands/` shows `thoughtful.md`.
- [x] `bun -e "JSON.parse(require('fs').readFileSync('packages/monitor/.claude-plugin/plugin.json','utf8'))"` exits 0.
- [x] Manual dashboard pass on the owner's dev server (clean trail + legacy-goal session, no errors).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Integration < 4 is an automatic veto. This gate scores the whole deliverable, not individual tasks.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / does it compose | ×3 | suite red or pieces don't connect | works but a seam is rough (e.g. language not flowing to scribe) | tests green; config→scribe→dashboard all compose end to end |
| Meets the PLAN goal | ×2 | still 3 skills or goals remain | mostly consolidated, friction remnant | one auto system; only config is global log_language |
| Consistency | ×1 | contradictory docs/code | minor drift | code, references, command, hook, CLAUDE.md all agree |
| No regressions | ×1 | bridge or legacy-log handling broke | minor UI regression | bridge intact, legacy logs tolerated, no console errors |

## Out of scope

- New features beyond the consolidation — Deferred. Reason: this gate verifies the planned scope only.
