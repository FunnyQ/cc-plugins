# Fix plan — make flightplan and autopilot fail closed

> **Status**: ready to execute
> **Owner**: Q
> **Rewritten**: 2026-08-01
> **Scope**: remaining work after the flightdeck and rust-rewrite recovery runs

## Goal

Preserve one reliable contract across the real workflow:

1. `flightplan` writes and validates a complete task tree.
2. `autopilot` executes only valid task states.
3. Only a passed binary gate and rubric gate may transition a task to `done`.
4. A run may report success only when every task in the tree is `done`.
5. Infrastructure failures must remain attributable to their task and cause.

The implementation must fail closed. A malformed task, lost pipeline result, or stalled tree must
produce a non-zero command result or an autopilot escalation. It must never look like clean completion.

## Current state

The original incident recovery is complete:

- `docs/flightdeck/tasks/` is fully `done`.
- `herdr-workbench/docs/rust-rewrite/tasks/` is fully `done`.
- The rust-rewrite flightlog records passing verdicts for `cutover/02` and `cutover/03`.
- The orchestrator tells dev agents to leave tasks `in-progress`; only `mark-done.ts` may write `done`.
- External-engine prompts use bounded foreground calls and a defined notification-based wait rule.
- The wave loop reconciles a missing parallel result to its task, but it loses the original error.

The following defects remain:

- The automatic flightplan hook does not recognize the current scaffolded Required-reading header.
- `mark-done.ts` can tick gate checkboxes without updating Status.
- Readiness does not reject `done` tasks with unticked gate checkboxes.
- A resumed run cannot use its current-run `completed` array to prove whole-tree completion.
- Pipeline and agent failures lose their original infrastructure cause.
- The incident handoff document contains stale or incorrect claims.

## Safety boundary

Do not require the entire repository to be clean. Unrelated user changes may exist.

Before editing a file:

1. Confirm no active workflow, external delegate, or live pane is writing that file.
2. Inspect its current diff and recent history.
3. Preserve unrelated changes.

The only product paths in this plan are:

```text
packages/dispatch/hooks/flightplan-lint.sh
packages/dispatch/hooks/flightplan-lint.test.ts
packages/dispatch/skills/flightplan/SKILL.md
packages/dispatch/skills/flightplan/references/task-template.md
packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts
packages/dispatch/skills/flightplan/scripts/lib/parse-task.test.ts
packages/dispatch/skills/flightplan/scripts/lint-task.ts
packages/dispatch/skills/flightplan/scripts/lint-task.test.ts
packages/dispatch/skills/flightplan/scripts/next-ready.ts
packages/dispatch/skills/flightplan/scripts/next-ready.test.ts
packages/dispatch/skills/flightplan/scripts/mark-done.ts
packages/dispatch/skills/flightplan/scripts/mark-done.test.ts
packages/dispatch/skills/autopilot/SKILL.md
packages/dispatch/skills/autopilot/references/orchestrator.md
packages/dispatch/skills/autopilot/scripts/fleet.ts
packages/dispatch/skills/autopilot/scripts/fleet.test.ts
packages/dispatch/skills/autopilot/scripts/tree-api.ts
packages/dispatch/skills/autopilot/scripts/tree-api.test.ts
docs/flightdeck/tasks/_context/data-model.md
docs/handoff-mark-done-silent-strand.md
```

Do not modify `herdr-workbench`. Its recovery is evidence for this plan, not remaining work.

## Implementation plan

### 1. Repair the flightplan hook contract

`flightplan` currently scaffolds this header:

```markdown
> **Required reading** (read before starting; do not need to open other files):
```

The hook only recognizes a colon immediately after `**Required reading**`, so it silently skips every
current task file.

Change the content signature to accept the current annotated header and the legacy colon header. Keep
the signature narrow enough to reject near misses such as `**Required reading later**`.

Update the flightplan skill text so its documented hook signature matches the supported formats.
Add the bare-Status rule to the task template. A Status value must be exactly `todo`, `in-progress`,
`done`, or `blocked`. Put run notes on a separate line.

This hook only observes harness `Edit|Write` calls. It cannot observe files written by external CLIs,
relay, or Bash. Keep it as early feedback for flightplan authors. Items 2–5 provide the fail-closed
execution boundary. Also require the external-engine dev driver to run `lint-task.ts <task-file>` after
the delegate returns and before the binary gate starts.

Tests must cover:

- A current scaffolded header invokes lint.
- A legacy colon header invokes lint.
- An unrelated Markdown file remains a silent no-op.
- A near-miss marker remains a silent no-op.
- A malformed task under the current header exits `2` with lint feedback.

Verify:

```bash
bun test packages/dispatch/hooks/flightplan-lint.test.ts
bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/flightdeck/tasks
```

### 2. Make `mark-done.ts` atomic and fail loud

Treat `markDone(content)` as one state transition. It may update Status and gate checkboxes together,
or it may fail without producing partial output.

Required behaviour:

- Accept only the four bare Status values defined by the shared parser.
- Reject a decorated value such as `in-progress (attempt 3)`.
- Locate Status only in the header blockquote before the first `##` heading.
- Require exactly one valid Status header in that scope.
- Throw when the Status header is missing, duplicated, or malformed.
- Do not return content with ticked gate boxes after any validation failure.
- Keep the pure function idempotent.
- Make the CLI name the task file on stderr and exit non-zero on failure.
- Leave the original file unchanged when the CLI fails.
- Reuse the parser's Status rule. Do not maintain a second set of accepted values.

Use a validation pass before the rewrite pass. Do not write the file until `markDone()` returns.

Tests must cover:

- `todo`, `in-progress`, `blocked`, and `done`.
- A decorated Status value that fails without changing content.
- A missing Status header.
- Duplicate Status headers.
- A Status example in the body that does not count as a duplicate header.
- Gate and non-gate checkboxes.
- Idempotence.
- CLI success.
- CLI failure with byte-for-byte unchanged input.

Verify:

```bash
bun test packages/dispatch/skills/flightplan/scripts/mark-done.test.ts
```

### 3. Put execution validity beside the shared task parser

A dependency is satisfied only by a valid completed task. The invalid fingerprint is:

```text
Status: done + any unticked checkbox in Acceptance criteria or Verification
```

Implement one shared validation function beside `parseTask()`. Do not duplicate Markdown section
parsing in `lint-task.ts` and `next-ready.ts`. Do not add a required `ParsedTask` field unless every
typed consumer and fixture is updated and type-checked.

The shared result must let consumers distinguish:

- structurally valid and unfinished;
- structurally valid and completed;
- malformed completion state.

Then enforce it in both consumers:

- `lint-task.ts` reports a `completion-state` violation.
- `next-ready.ts` exits non-zero instead of unlocking dependents or returning an empty ready set.
- A parsed task with `status === null` is invalid and makes readiness exit non-zero.
- `fleet.ts` derives malformed completion as `invalid`, never `done`.
- A dashboard dependency on an invalid task remains `blocked` and lists that ref in `blockedBy`.
- `tree-api.ts` includes `invalid` in its counts instead of presenting the tree as complete.
- `data-model.md` records the same precedence before the ordinary `done` rule.

Apply the invariant only to checkboxes inside `## Acceptance criteria` and `## Verification`.
Unchecked boxes in other sections remain valid.

Tests must cover:

- `done` with all gate boxes checked.
- `done` with an unchecked acceptance box.
- `done` with an unchecked verification box.
- `done` with an unchecked non-gate box.
- A dependent task is never returned when its dependency has malformed completion state.
- CLI `--json` fails loudly on malformed completion state.
- A decorated or unknown Status fails readiness instead of disappearing from the graph.
- Dashboard state and counts expose malformed completion as invalid.
- Dashboard dependents remain blocked by an invalid task.

The `completion-state` message must instruct the executor to reset Status to `in-progress` or `todo`
and rerun the gates. It must explicitly forbid manually checking the boxes.

Verify:

```bash
bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts
bun test packages/dispatch/skills/flightplan/scripts/next-ready.test.ts
bun test packages/dispatch/skills/flightplan/scripts/lib/parse-task.test.ts
bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts
bun test packages/dispatch/skills/autopilot/scripts/tree-api.test.ts
```

### 4. Make whole-tree completion resume-safe

The current-run `completed` array is not a tree completion count. A resumed autopilot run excludes
tasks completed by earlier runs, so comparing `completed.length` with tree size is incorrect.

Extend the readiness scout output, or add a sibling script mode, to return one authoritative snapshot:

```json
{
  "ready": [],
  "counts": {
    "total": 0,
    "todo": 0,
    "inProgress": 0,
    "done": 0,
    "blocked": 0,
    "invalid": 0
  }
}
```

Use the shared parser from item 3. Do not let the orchestrator count task files or parse Markdown.

Wave-loop termination rules:

- `done === total` means clean completion.
- `total` must equal the sum of every status bucket.
- `invalid > 0` is a scout failure that lists the invalid task refs.
- A non-empty ready set starts the next wave.
- An empty ready set with unfinished tasks means stalled.
- A stalled run returns an escalation containing the remaining status counts and task refs.
- A malformed tree remains a scout failure.
- Existing `done` tasks count toward completion during resume.

Keep the current `next-ready.ts --json` interface compatible if another consumer relies on its array
shape. Prefer a new flag or a separate summary function over an unannounced breaking change.

Tests must cover:

- A fresh tree.
- A fully completed tree.
- A resumed tree containing earlier `done` tasks.
- A stale `in-progress` task with no ready work.
- A blocked dependency chain.
- A mixed tree where independent ready work may continue.
- A malformed Status counted as invalid and rejected.

Verify:

```bash
bun test packages/dispatch/skills/flightplan/scripts/next-ready.test.ts
```

Use unit tests for the snapshot function. Verify the Markdown orchestrator with a disposable fixture
tree under a session-created temporary directory. Before running it, record the exact expected result
for a resumed tree and the exact escalation fields for a stale `in-progress` tree. Do not reuse or
modify the completed flightdeck tree.

### 5. Preserve infrastructure failures through the task pipeline

Do not depend on `parallel()` returning an error object. Wrap each task thunk before passing it to
`parallel()` so the task ref and thrown error survive:

```js
async () => {
  try {
    return await executeTask(item)
  } catch (error) {
    const parked = await tryParkBlocked(item, error)
    return infrastructureFailure(item.ref, error, parked)
  }
}
```

Use one explicit infrastructure-failure result shape. Reconcile every input task by index or task ref.
Do not use `.filter(Boolean)` before reconciliation. Ensure the result-processing loop handles a null
defensively without reading `r.passed`.

Handle agent failures separately from quality failures:

- A verifier returning `passed: false` is a quality failure and may retry the dev loop.
- A verifier returning no structured result is an infrastructure failure.
- A judge returning no structured result is an infrastructure failure.
- A thrown task pipeline is an infrastructure failure.
- Infrastructure failure parks the task and returns an escalation immediately.
- Catch wrappers must attempt `markBlockedPrompt`; record whether parking succeeded.
- The escalation must say that verification did not run or did not return a verdict.
- Do not rerun dev after an infrastructure failure in the same autopilot invocation.
- Record the current attempt for audit purposes. Do not claim that no compute was consumed.

If the harness exposes no original cause for a null agent result, report that limitation precisely.
Do not invent an error message.

Tests or a deterministic workflow fixture must cover:

- A task pipeline throw.
- A null verifier result.
- A genuine failed verifier result.
- A null judge result.
- A parallel wave where one task passes and one infrastructure-fails.
- No incomplete task disappears from both `completed` and `escalations`.

Treat the post-judge transition as another infrastructure boundary. Give `markDonePrompt` a structured
result such as `{ ok, status, error }`. Require it to run `mark-done.ts`, reread the task, and confirm a
bare `Status: done`. Add the task to `completed` only after that result passes. Otherwise park and
escalate it; never return both completion and stall records for the same task.

Verify that the returned escalation names the task and available cause, and that the task is parked as
`blocked`.

### 6. Align the autopilot contract and incident record

After items 1–5 pass:

1. Update `packages/dispatch/skills/autopilot/SKILL.md` with the new scout result and termination rules.
2. Update `docs/handoff-mark-done-silent-strand.md` with verified facts only.
3. Mark reconstructed evidence as reconstructed.
4. Correct stale next-ready line references, the task count, and the hook-marker diagnosis.
5. Remove the old suggestion that checkbox updates can be skipped inside the existing single pass.
6. State that rust-rewrite recovery is complete and retain its passing verdicts as evidence.

Verify documentation claims against current source and flightlogs with `rg`. Do not retain fixed line
numbers unless they still resolve after the implementation.

## Required execution order

Run the items in dependency order:

```text
hook contract ───────────────┐
                            ├─> documentation alignment
atomic mark-done ────────────┤
                            │
shared completion validity ─┼─> resume-safe tree completion ─> orchestrator termination
                            │
infrastructure preservation ┘
```

Items 1 and 2 may run independently. Item 3 must precede item 4. Implement item 4 before item 5 because
both change the wave-loop contract. Item 6 runs last.

## Final verification

Run focused tests first, then the dispatch package suite:

```bash
bun test packages/dispatch/hooks/flightplan-lint.test.ts
bun test packages/dispatch/skills/flightplan/scripts/mark-done.test.ts
bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts
bun test packages/dispatch/skills/flightplan/scripts/next-ready.test.ts
bun test packages/dispatch/skills/flightplan/scripts/lib/parse-task.test.ts
bun test packages/dispatch
```

Then run these artifact checks:

```bash
bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/flightdeck/tasks
bun packages/dispatch/skills/flightplan/scripts/next-ready.ts docs/flightdeck/tasks --summary
```

Expected result:

- All tests pass.
- The flightdeck tree lints cleanly.
- The completed flightdeck tree reports no ready tasks and an all-done summary.
- A scratch malformed-completion fixture fails lint and readiness.
- A scratch stalled tree returns an autopilot escalation.
- A scratch resumed tree completes without a false stall.

## Out of scope

- Re-running the completed flightdeck or rust-rewrite plans.
- Changing scoring arithmetic or rubric thresholds.
- Changing dev, reviewer, or judge model policy.
- Adding worktree isolation to individual agents.
- Changing dashboard layout or visual design; task-state consistency is in scope.
- Replacing the existing external-engine wait design unless a new reproduction shows it still fails.
