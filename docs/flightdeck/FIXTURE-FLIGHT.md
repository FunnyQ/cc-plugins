# Fixture Flight Verification Record

**Date**: 2026-08-01
**Dev engine**: Claude
**Waves**: 3 work waves plus the empty closing scout
**Clean re-flight workflow**: `wf_e17affc6-5a0`

## Live Observations

### Browser and plan

- [x] `launch.ts` opened the browser once after switching the existing daemon.
- [x] `/api/tree` showed `flightdeck-fixture` with core and close buckets.
- [ ] Direct desktop rendering could not be captured because `screencapture` returned `could not create image from display`.

### Fleet rows during work waves

- [x] Scout, dev, verify, judge, review, and fix start entries appeared live.
- [x] Every start entry received a matching end entry.
- [x] Agent labels, task refs, and attempts were present in the live trail.
- [ ] Pulsing indicators and ticking elapsed text were not directly visible from this headless execution context.

The clean sequence was:

```text
scout
dev core/01 → verify core/01 → judge core/01
scout
dev core/02 → verify core/02 → judge core/02
scout
review close/01: simplification, reuse, altitude, codex, efficiency
fix close/01 → verify close/01 → judge close/01
scout
```

### Task card state

- [x] Core/01 changed from ready to in-progress, then done after its judge passed.
- [x] Core/02 stayed blocked until core/01 was done, then changed from in-progress to done.
- [x] Close/01 stayed blocked until both core tasks were done, then changed from in-progress to done.
- [x] These transitions occurred through live daemon updates without a manual reload.

### Score rendering

- [x] The API exposed the same numeric scores as the run verdicts.
- [x] Core/01 scored `4.571428571428571`.
- [x] Core/02 scored `4.571428571428571`.
- [x] Close/01 scored `4.714285714285714`.
- [ ] The visual meter itself could not be inspected from the headless execution context.

### Graph

- [x] Dependency state changed in place as each task landed.
- [ ] Node recoloring and stable node positions could not be directly inspected from the headless execution context.

### Closing review

- [x] Five review rows appeared in the live trail.
- [x] The Codex cross-vendor review completed without `CODEX UNREACHABLE`.
- [x] A fix row appeared and completed.

## Verification Results

```text
=== Flightlog directories ===
docs/flightdeck-fixture/.flightlog
=== Required role roles ===
dev
fix
judge
review
scout
verify
=== Start/end balance check ===
true
Exit code: 0
=== Runlog generation ===
/tmp/fd-fixture-runlog.md
Checking for phase entries in runlog...
0 (correct)
=== Daemon status ===
"flightdeck-fixture"
=== Test suites ===
bun test v1.3.13 (bf2e2cec)

281 pass
0 fail
511 expect() calls
Ran 281 tests across 21 files. [1.90s]
```

The complete test output was captured at `/tmp/fd-final-verification.txt` before cleanup.

## Wiring Defects

### Premature task completion

**What was wrong**: Both first-flight dev agents changed their task status to `done` before verify and judge ran. This prematurely unlocked dependent tasks in the dashboard.

**File changed**: `packages/dispatch/skills/autopilot/references/orchestrator.md`

**Fix**: Added one shared `STATUS_RULE`. Dev, external-dev, and final-fixer prompts must leave tasks `in-progress`. Only the post-judge `mark-done.ts` step may write `done`.

**Re-flight**: A complete clean re-flight followed. Core/01, core/02, and close/01 remained `in-progress` through their judges. Each changed to `done` only after its passing verdict.

## Non-wiring Defects

No product non-wiring defects were found. Visual-only browser assertions remain unverified because the execution context could not capture the desktop display.

## Closing Gate Addendum (wiring/04, attempt 1)

The fixture flight left three observations unconfirmed because its execution context
could not capture the desktop display. The closing gate confirmed each one against a
running daemon plus the rendered markup, without a browser.

- [x] **Rising elapsed with role, task, and attempt at once.** One in-flight row rendered
      `role=review task=close/01 attempt=1 elapsed=1m 1s`, then `elapsed=1m 4s` three
      seconds later from the same payload. All four facts sit in one row.
- [x] **Score meter renders.** `renderScore` emitted the fill and threshold widths from
      the run's own verdict (`4.50`, `passed=true`) — the same numbers `/api/tree` reports.
- [x] **Node recolouring and stable node positions.** Graph state classes map to the same
      tokens as the lane cards (`-done` → `--state-done`, `-in-progress` → `--state-flight`,
      `-ready` → `--state-ready`, `-blocked` → `--state-blocked`), and `app.js` re-lays out
      only when the task structure string changes, so a state-only poll leaves coordinates frozen.

### Defects this gate found and fixed

Four defects came from the cross-vendor lens. Each was reproduced against the pre-gate
commit `2b32f44` and fixed in its owning component.

1. **A task left `in-progress` while agents were still flying.** `fleet.ts` tracked open
   starts in a `Set` keyed by `(task, role, attempt)`, so five parallel review lenses
   collapsed into one entry and the first lens to finish cleared the whole group.
   Reproduced: five lens starts plus one end reported `state=ready`. Fixed by counting
   open starts, so one end cancels exactly one start.
2. **A duplicate judge row, and a short elapsed time.** Any non-start entry could close a
   row, so a judge's `score` closed it and the judge's real end note opened a second row.
   Reproduced: one judge produced 2 rows with `elapsed=2000`. Fixed by letting only a note
   close a row; a verdict attaches to the judge row instead. Now 1 row, `elapsed=3000`.
3. **An unvalidated daemon record reaching `process.kill`.** `readRecord` returned any JSON
   object. It now validates pid, port, root, and plan, and returns null otherwise.
4. **A launcher printing a URL that opens nothing.** The reuse path checked only that the
   pid was alive. Reproduced with a live unrelated pid and a dead port: the launcher printed
   `http://localhost:5799/` and exited 0. It now requires the port to answer, discards the
   stale record, and starts a real daemon.

## Workflow Runtime Notes

- The first flight completed 3 tasks with 21 agents and no escalation.
- The clean re-flight completed 3 tasks with 21 agents and no escalation.
- The clean re-flight used one `.flightlog` directory and 39 JSONL entries.
- All five closing-review finding files were created.
- The rendered runlog omitted every start-phase entry.
