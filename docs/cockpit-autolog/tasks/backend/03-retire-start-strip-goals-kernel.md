# BACKEND-03: Retire `start`, strip goal machinery from the CLI kernel

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/02
> **Blocks**: frontend/01, skills/01, docs/01
> **Status**: todo

## Goal

Remove the goal-setting ceremony and `cockpit start` from `cockpit.ts` entirely, while
keeping `log` / `scribe` / `wait` / `send` working and auto-registering without `start`.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit.ts` (modify) — delete goal + start code.
- `packages/monitor/skills/cockpit/scripts/cockpit.test.ts` (modify) — drop/rewrite tests.

## Implementation notes

Remove these, currently in `cockpit.ts` (line numbers approximate — verify against the
file):

- `type GoalRecord = { type: "goal"; session_goal: string; ts: string };` (~line 25).
- `writeProjectMeta(...)` (~lines 230–257) and `readMetaField(...)` (~lines 223–228) — both
  exist only for `project-meta.md`, which is being deleted. Confirm no other caller remains;
  if `readMetaField` has another consumer, keep that path but drop the meta usage.
- `writeGoalRecord(...)` (~lines 263–280).
- `cmdStart(...)` (~lines 308–341) and its `case "start":` in the `main()` switch.

Keep `cmdLog`, `cmdScribe`, `cmdConfig`, `cmdWait`, `cmdSend`, `upsertSession`, `findSession`,
`readDecisionRecords`, and the `needs_your_call`/`wait`/`send` bridge intact.

**Auto-registration check:** `cmdScribe` already calls `upsertSession(...)` before writing
(~line 484). Confirm `cmdLog` also registers (or resolves a live session) so the first
`log`/`scribe` in a session with no prior `start` succeeds and shows up `tracked: true`. If
`cmdLog` relied on `start` having created the registry entry, add the same `upsertSession`
guard it needs — do not reintroduce goals to do it.

**Legacy tolerance:** `readDecisionRecords` already filters to `type === "decision"`, so a
stale line-1 `type:"goal"` record in an old log is ignored. Leave that filtering in place.

### Tests to remove/rewrite in `cockpit.test.ts`

These goal/lang/start tests no longer apply (approx line ranges): "writes project-meta.md
with project_goal" (51–70), "goal record is line 1…" (72–89), "preserves created
timestamp…" (117–148), "re-running start preserves the decision trail" (186–217), the
`log_language` meta tests (150–183, 219–244), and the `--provider codex` *start* test
(247–265) — rewrite the provider-routing assertion to use `log`/`scribe` instead of `start`.
Replace them with a test proving a fresh session can `log`/`scribe` with no prior `start`
and lands `tracked: true` in the registry.

## Acceptance criteria

- [ ] `GoalRecord`, `writeGoalRecord`, `writeProjectMeta`, `cmdStart`, and the `start` route are gone.
- [ ] `readMetaField`/`project-meta.md` reads/writes are removed from `cockpit.ts`.
- [ ] `log` / `scribe` / `wait` / `send` and the `needs_your_call` bridge still work.
- [ ] A first `log` or `scribe` in a session with no prior `start` auto-registers (`tracked: true`).
- [ ] No remaining reference to `session_goal` / `project_goal` / `project-meta` in `cockpit.ts`.
- [ ] Removed/rewrote the obsolete goal/lang/start tests; added the no-start auto-register test.

## Verification

- [ ] `bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts` passes.
- [ ] `grep -n "goal\|project-meta\|cmdStart\|GoalRecord" packages/monitor/skills/cockpit/scripts/cockpit.ts` returns nothing.
- [ ] No-start auto-register: in a temp `COCKPIT_HOME`, run a `scribe`/`log` write with no `start`; confirm the registry entry exists (`tracked: true`).
- [ ] `needs_your_call` bridge smoke (no `start`): in a temp `COCKPIT_HOME`, `cockpit log --decision "Q?" --needs-call --option A --option B`, capture the session/call id from the log, then `cockpit send <id> "A"`; confirm the log's latest call record is closed with a recorded `response` of `A` (the `wait` side parks for the UI/`send` answer — exercising `send` is the deterministic, non-blocking half). Prefer encoding this as a test in `cockpit.test.ts` if the existing bridge tests make it cheap.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | breaks log/scribe or leaves goal code | removes goals but no-start path broken | goals/start gone, log/scribe/wait/send + auto-register all work |
| Test coverage | ×2 | tests fail or deleted without replacement | removed only | obsolete tests dropped + no-start auto-register test added |
| Interface & readability | ×1 | dead helpers left dangling | mostly clean | no orphaned imports/helpers; surgical diff |
| Assumptions & docs | ×1 | silent removal of shared helper | partial | confirmed no other `readMetaField` consumer before removal |

## Out of scope

- Server-side goal readers in `registry.ts` / `project-info.ts` — Deferred to the server-strip task in this bucket.
- Dashboard goal UI — Deferred to the frontend bucket.
