# BACKEND-04: Strip goal readers from registry + project-info

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/03
> **Blocks**: docs/01
> **Status**: done

## Goal

Remove every server-side reader and payload field tied to goals and to `project-meta.md`,
so the dashboard API no longer carries `sessionGoal` / `projectGoal` / project-prose.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/registry.ts` (modify)
- `packages/monitor/skills/cockpit/scripts/project-info.ts` (modify)
- `packages/monitor/skills/cockpit/scripts/registry.test.ts` (modify)
- `packages/monitor/skills/cockpit/scripts/project-info.test.ts` (modify)
- `packages/monitor/skills/cockpit/scripts/call-log.test.ts` (modify)

## Implementation notes

### `registry.ts` (line numbers approximate — verify)

- Drop `sessionGoal: string` from the `SessionView` type (~line 57) and `projectGoal: string`
  from `ProjectView` (~line 66).
- Delete `readSessionGoal(...)` (~lines 193–206) and `readProjectGoal(...)` (~lines 208–219).
- In `buildSessions(...)`, remove the `goalCache` map (~lines 237–244) and the
  `sessionGoal` / `projectGoal` fields from each returned `SessionView` (~lines 275–276).
- In `buildProjects(...)`, remove `projectGoal: group[0]?.projectGoal ?? ""` (~line 331).

### `project-info.ts` (line numbers approximate — verify)

- Remove `projectGoal: string` from the `ProjectInfo` type (~line 29).
- `buildProjectInfo(...)` (~lines 238–239) currently calls `readProjectGoal` and reads the
  meta prose. Remove the `projectGoal` field. Also remove `readMetaBody(...)` (~lines 38–48)
  and the `meta` (prose) field it feeds, since `project-meta.md` is being deleted. The HTTP
  handler `handleProjectInfo(...)` (~lines 249–265) should stop emitting `projectGoal`/`meta`.
- If removing `meta` leaves `buildProjectInfo` returning only tokens/instruction-files, keep
  those; only the goal + prose fields go.
- Note: the dashboard SPA has **no** `/api/project-info` consumer (verified — a grep of
  `dashboard/dist/` for `project-info`/`projectInfo` finds nothing), so removing the `meta`
  prose field here has no frontend counterpart. Removing the now-unused field is still
  correct cleanup; just don't expect a paired frontend change.

### Tests

- `registry.test.ts`: remove the "goal readers" test (~213–223) and the `projectGoal`
  assertion in the buildProjects test (~288–298). Keep the rest of those tests, adjusting
  fixtures that called `start(...)` with goals to instead seed via `log`/`scribe`.
- `project-info.test.ts`: drop the `seedMeta` goal/prose helper usage and the
  `projectGoal`/`meta` assertions (~70–121); keep token/instruction-file assertions.
- `call-log.test.ts`: the `type:"goal"` fixture (~line 6) is fine to keep as a *legacy*
  record the call-log reader must skip — keep that "ignores a goal-only log" test as a
  regression guard for backward tolerance.

## Acceptance criteria

- [x] `SessionView.sessionGoal`, `ProjectView.projectGoal`, `ProjectInfo.projectGoal` are removed.
- [x] `readSessionGoal`, `readProjectGoal`, `readMetaBody`, and `goalCache` are deleted.
- [x] `/api/sessions`, `/api/projects`, `/api/project-info` payloads no longer include goal or prose fields.
- [x] `call-log` still tolerates a legacy `type:"goal"` line-1 record (regression test kept).
- [x] All three touched test files pass after fixture/assertion updates.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/registry.test.ts packages/monitor/skills/cockpit/scripts/project-info.test.ts packages/monitor/skills/cockpit/scripts/call-log.test.ts` passes.
- [x] `grep -n "Goal\|readMetaBody\|project-meta" packages/monitor/skills/cockpit/scripts/registry.ts packages/monitor/skills/cockpit/scripts/project-info.ts` returns nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | payloads still carry goal/prose or readers throw | fields removed but a reader/handler left dangling | all goal/prose readers + fields gone; legacy goal record tolerated |
| Test coverage | ×2 | tests fail | obsolete tests removed only | assertions updated + legacy-tolerance regression kept |
| Interface & readability | ×1 | orphaned imports/types | mostly clean | no dead code; types trimmed cleanly |
| Assumptions & docs | ×1 | unverified payload shape | partial | confirmed no consumer of removed fields remains server-side |

## Out of scope

- Dashboard frontend rendering of those fields — Deferred to the frontend bucket.
