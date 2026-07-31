# WIRING-04: final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/hangar.md`
> - `../_context/rubric.md`
>
> **Depends on**: wiring/03, contract/02, server/05, ui/04
> **Final review**: true
> **Status**: done

## Goal

Judge the finished flightdeck as one deliverable: does it compose, does it match the direction that was
agreed, and did it leave the rest of the plugin as healthy as it found it.

## Files to create / modify

- Any file in `packages/dispatch/` — fixes only, scoped to defects this review finds.
- No new feature files. A gap that needs new scope is recorded, not built.

## Implementation notes

This is the holistic gate. Do not re-score the individual tasks; their own rubrics already did that.
Score whether the assembled thing works and belongs.

### Does it compose

Run the real thing against a real tree and read it as a user would, not as its author.

- The derivation layer, the two endpoints, and the three views agree with each other. A colour means the
  same state in the lane cards, the graph nodes, and the fleet rows.
- A state change moves through the whole chain: file on disk to derived state to rendered card.
- The two data paths coexist — the polled tree snapshot and the streamed flightlog — without one
  overwriting the other's view or fighting over the same state.
- Nothing in the browser re-derives what the server already derived. Two implementations of the same
  rule will drift.

### Does it meet the goal

The agreed outcome was: see which agents are in flight right now, see the tree's shape and progress, see
each task's rubric verdict, and get all of it without a second command.

"Does it feel useful" is not scoreable, and two reviewers would answer it differently. Score these four
concrete observations instead, each recorded in the fixture-flight evidence file:

1. **Live fleet** — during the run, the page showed at least one agent's role, task ref, attempt number,
   and a rising elapsed value **at the same time**, without opening the log.
2. **Progress** — at least one task card was observed changing state during the run, with no reload.
3. **Verdict** — a rubric score appeared on the page, and its weighted value matched the verdict the run
   itself recorded.
4. **No second command** — the page was opened by the skill, not by hand.

All four confirmed is a pass on this dimension. Any one missing caps it below the bar, however good the
rest looks. If the evidence file does not record them, the dimension cannot be scored above 3 — an
unverifiable claim is not a passing one.

### Is it consistent with the repository

- Bun, `type` over `interface`, pure functions with a thin impure entry point, tests beside sources.
- The cross-plugin rule held: nothing under `packages/dispatch/` imports from `packages/monitor/`.
- Exactly one library is vendored, and it is petite-vue.
- The cross-skill import stayed narrow: only the three permitted sibling modules.
- The design system is followed rather than decorated around. Check the stated anti-goals specifically —
  an anti-goal violation is the most likely way this drifted, because each one is individually tempting.

### No regressions

The riskiest edit in this plan changed the file that drives every autopilot run.

- The existing test suites are green.
- All four pre-existing flightlogs still parse, and their rendered run logs are unchanged.
- The workflow control flow was not altered: same agents, labels, models, schemas, and stage order. The
  prompt strings did change, deliberately and in three enumerated ways, so judge the control flow rather
  than the raw presence of modified lines. Judge it across the whole range of the plan's commits, not
  against the working tree — by now every earlier task has landed, so an uncommitted diff says nothing.
- A plan tree with no flightdeck involvement still flies exactly as before.

### Defects handed on from the fixture flight

The fixture flight fixes only wiring defects and records everything else. Read that list first and treat
each entry as a finding this gate owns: reproduce it, fix it in its own component, and note the outcome.
An unresolved entry there is an unresolved finding here, not someone else's problem.

### Judging severity

Fix what is broken or inconsistent. Record what is merely missing. A finding that needs new scope is a
known gap, not a reason to keep building — the version boundary was drawn deliberately.

## Acceptance criteria

- [x] The daemon was run against a real tree and every view was read as a user, not as the author.
- [x] The three views agree on what each state colour means.
- [x] The polled snapshot and the streamed log coexist without either clobbering the other.
- [x] No derivation rule is implemented twice, once on each side.
- [x] All four goal observations are confirmed against the fixture-flight evidence file: simultaneous
      live fleet detail, an observed task state change, a verdict matching the run's own, and a page the
      skill opened without a second command.
- [x] Repository conventions hold: runtime, types, purity, test placement.
- [x] Nothing under the dispatch package imports from the monitor package.
- [x] Exactly one vendored library is present.
- [x] The cross-skill import surface is still only the three permitted modules: the task loader, the
      flightlog module, and the task parser.
- [x] No stated design anti-goal is violated.
- [x] Both test suites are green.
- [x] All four pre-existing flightlogs parse and render unchanged.
- [x] Every orchestrator hunk matches the permitted set — added start lines, added end lines, existing
      completion lines gaining a phase flag, and the single fixer role change — with the control flow
      itself unchanged, judged against a stable pre-plan baseline commit rather than the working tree.
- [x] Every defect the fixture flight handed on was reproduced, fixed in its owning component, and its
      outcome recorded.
- [x] Every defect found here is fixed; every gap found is recorded rather than built.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/ packages/dispatch/skills/flightplan/scripts/` — all green.
- [x] Confirm no cross-plugin import:
      `rg -n "packages/monitor|\.\./\.\./\.\./monitor" packages/dispatch/` returns nothing.
- [x] Confirm the vendor surface:
      `ls packages/dispatch/skills/autopilot/dashboard/dist/vendor/` → `petite-vue.es.js` only.
- [x] Confirm the cross-skill import surface:
      `rg -n "from \"\.\./\.\./flightplan" packages/dispatch/skills/autopilot/scripts/` — every hit
      resolves to one of the three permitted modules, nothing else.
- [x] Confirm the fixture flight left durable evidence: `docs/flightdeck/FIXTURE-FLIGHT.md` exists, is
      committed, and records the observations and any defects that were found and fixed.
- [x] Re-render every pre-existing trail and diff against its committed run log; all four produce no
      output from `diff`.
- [x] Establish the baseline first. By the time this gate runs, every earlier task has already been
      committed, so a plain working-tree diff shows nothing and proves nothing. Anchor on the commit that
      introduced this plan's task tree — everything after it is this plan's work:
      `BASE=$(git log --diff-filter=A --format=%H -1 -- docs/flightdeck/tasks/README.md)`
      If the run is flying under autopilot, its own recorded base ref is equivalent and may be used instead.
- [x] Confirm the workflow control flow is untouched across that whole range:
      `git diff "$BASE"..HEAD -- packages/dispatch/skills/autopilot/references/orchestrator.md`
      Every hunk must be one of exactly three permitted kinds: an added start-log line, an added end-log
      line, or an existing completion line gaining a phase flag — plus one role value changed on the
      fixer's line. Three hunks legitimately modify existing lines, so "additions only" is the wrong test.
      What must be unchanged is the control flow itself: same agents, labels, models, schemas, stage order.
- [x] Review the full scope of the plan's changes over the same range:
      `git diff --stat "$BASE"..HEAD -- packages/dispatch/`
- [x] Run the daemon against a real tree and against this plan's own tree; read every view in both.
- [x] Check the design anti-goals one by one against the rendered page.
- [x] Confirm no raw hex outside the token block:
      `rg -n "#[0-9a-fA-F]{3,8}\b" packages/dispatch/skills/autopilot/dashboard/dist/style.css | rg -v "^\s*\d+:\s*--"` returns only `:root` lines.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Integration < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration | ×3 | The pieces do not compose; a state change fails to reach the screen | Composes but the two data paths conflict, or a rule is implemented on both sides | Every layer agrees, both data paths coexist cleanly, each rule lives in exactly one place |
| Meets the goal | ×2 | Two or more of the four recorded observations are missing or unconfirmed | Exactly one is missing, or the evidence file does not record them so they cannot be verified | All four recorded and confirmed: simultaneous live fleet detail, an observed state change, a matching verdict, and a page opened by the skill |
| Consistency | ×2 | Cross-plugin import present, or a design anti-goal violated | Conventions mostly held with drift in one area | Runtime, types, purity, vendor surface, import surface, and the design system all hold |
| No regressions | ×2 | An existing suite fails, or a pre-existing trail renders differently | Suites pass but the control-flow check ran against an empty working-tree diff, or rejected the three legitimate line modifications | Suites green, all four trails render identically, every orchestrator hunk matched against the permitted set across a real pre-plan baseline range |

## Out of scope

- Re-scoring individual tasks. Their own rubrics already did that; this gate judges the assembled whole.
- Building anything deferred: the Workflow journal layer, a plan picker, a post-mortem export, a
  staleness ceiling, table filtering, graph pan and zoom. Record them, do not build them.
- Bumping the plugin version, writing a changelog entry, or cutting a release. Those are a separate
  human-invoked step after this tree lands.
- Fixing unrelated pre-existing issues discovered along the way. Report them and leave them.
