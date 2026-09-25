# WORKTREE-05: Run-wide abort on leak, and single-task resume in worktrees

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/04
> **Blocks**: worktree/06
> **Status**: done

## Goal

A write to the main tree from outside a land stops the whole run before anything else lands or commits, and leaves every worktree whose work has not landed on disk for inspection; a task that landed cleanly before the abort still finishes and removes its worktree. A single-task resume runs in the task's kept worktree, against a fresh fingerprint baseline. The Final review task keeps working in the main tree, and both rules exempt it.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify): the script block, plus the design-notes prose that describes leaks, the abort, and resume.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify): the new test cases, reusing the existing `wt-show:` stub route.

## Implementation notes

### Starting state

The orchestrator already runs every non-final task in its own worktree:
- Every `wt-*` call runs under the one main-tree lock.
- The `live` map tracks each worktree the run created and has not removed. Every report of kept worktrees reads it.
- A clean land marks the task done and removes the worktree. A conflict rebases. A drifted land runs `reverify` in the main tree, and unlands on a failure.
- `wt-sweep:start` runs before the fingerprint baseline, and `wt-sweep:end` runs at run end.

One land result still has interim behaviour, and this task replaces it: `status: "leak"` fails only the task that saw it, as a per-task infrastructure failure, and the rest of the run carries on.

The tree watch, deferral, requalify, and `heldBack` machinery is still present and must keep working. A later change deletes it. Do not delete or rewire any of it here.

### Run-wide abort

- Add one script-level abort state: `let aborted = null`. Once set, it holds `{ reason, paths }`.
- **Set it** in two places:
  - `wt-land` returns `status: "leak"`. The reason names the ref that saw it, and `paths` comes from the land result.
  - The wave-end check `wt-leak:<wave>` returns a non-empty `paths`. That check is `fingerprint --expect <last recorded fingerprint>`, run under the lock after the wave's `parallel(...)` resolves and **before anything else in the wave loop** — before the no-progress `if (!passedThisWave) break`, the inter-wave commit, and the post-loop commit. A wave where no task passed still runs it.
  - The wave-end check returns no structured result even after its retry. The main tree's state is then unknown, so set the abort with reason "wave-end leak check returned no result" and empty `paths`.
  - Tests: a zero-pass wave runs `wt-leak:<wave>` before the loop exits and no `commit-` label runs after a leak; a double-null `wt-leak:<wave>` sets the abort, and no commit and no `wt-sweep:end` run.
- Never overwrite a set abort. The first cause wins.
- **Check it** at three points, through one helper:
  - Inside the `Max parallel` slot wrapper, before the task body runs. A task still queued for a slot must see an abort that was set while it waited, so it never runs `wt-create`.
  - At the top of every attempt in the task pipeline.
  - Immediately before every `wt-land`, after taking the lock.
- **A task that sees it** stops at once:
  - It does not land.
  - It does not park: no `block:` agent, and no Status edit.
  - It returns an infrastructure-failure result whose reason is `run aborted: <abort reason>`.
  - Its worktree, if it has one, stays on disk and in the `live` map.
- **A task whose land was clean before the abort still finishes.** The checks above all sit before a land, so after a clean land the task runs `done:` and `wt-remove:` even if the abort is set meanwhile. Its work is already in the main tree, and its worktree holds nothing unlanded. The abort preserves only worktrees whose work has not landed.
- **The run reacts to it:**
  - After the current wave's `parallel(...)` resolves, the wave loop stops. No further scout runs.
  - No inter-wave commit runs, and neither does the post-loop commit.
  - The end sweep (`wt-sweep:end`) is skipped.
  - The run result carries `aborted: { reason, paths }`. Its `worktrees: [{ ref, path }]` field lists every entry still in the `live` map, which is exactly this run's worktrees with unlanded work. It also lists every `{ ref, path }` the start sweep kept whose Status is still `blocked`: those leftovers from an earlier run never entered `live`, but they are on disk too. This is the same reporting rule the clean end of a run uses.
- Delete the interim per-task leak handling. After this task, a leak never parks a task.

### Final review exemptions

The Final review task runs in the main tree, and its fixer writes the main tree on purpose.
- **Wave-end check:** a wave that ran the Final review task runs no `wt-leak:<wave>`. The fingerprint is not compared again after it.
- **Resume:** a single-task resume of the Final review task, from `dev`, `verify`, or `judge`, takes no baseline and runs no `wt-show` or `wt-create`. It runs in the main tree exactly as it does today.

### Single-task resume

A single-task resume (`CFG.resumeTask` set, for a non-final task) runs one pipeline, with no scout and no wave loop.
- **Baseline.** At resume start, before any other step, take the main-tree lock and run `fingerprint` with no `--expect`, labelled `wt-leak:resume`. Record the result as the fingerprint baseline. Every later `wt-land --expect` in the resume uses it.
- **`CFG.resumeFrom` is `verify` or `judge`:**
  - Under the lock, run `wt-show:<ref>`. It returns `{ path, base, exists }`.
  - When `exists` is false, halt the resume before any agent step runs. Return an infrastructure-failure result such as `the kept worktree for <ref> is gone: <path> — resume from dev instead`. Do not recreate it: the kept worktree holds the only copy of the work being resumed.
  - Otherwise add `path` to the `live` map and use it as the task's `WORKTREE` for every step of the resumed attempt.
  - A `judge` resume still reads `CFG.attestationFile` as it does today. Only the working directory changes.
- **`CFG.resumeFrom` is `dev`:**
  - Under the lock, run `wt-show:<ref>` first.
  - When `exists` is true, reuse that worktree: add it to `live` and run the resumed attempt there. It may hold unlanded work, for example the rebased merge left by a failed drift re-verify, and `create` would delete it.
  - Only when `exists` is false, run `wt-create` under the lock, as a fresh pipeline does.
- After the resumed pipeline ends, clean up as a normal run does. Remove the worktree after a clean land, and keep it on park.
- Reuse the existing `wt-show:` agent, schema, and stub route; do not add a second one.

### Tests (`orchestrator-script.test.ts`)

1. **Leak at land while a sibling waits.** Use `Max parallel` 1 and two ready tasks. The first task's `wt-land` returns `leak`. The second task never records a `wt-create`, `wt-land`, `done:`, or `block:` label. No `commit-` label runs, and no `wt-sweep:end` runs. The result carries `aborted` with the leak paths, and `worktrees` lists only the first ref.
2. **Leak at land with a started sibling.** Use `Max parallel` 2 and two ready tasks. The first task's `wt-land` returns `leak` while the second is still in dev. The second task never records a `wt-land`, `done:`, or `block:` label, and `worktrees` lists both refs.
3. **Final review is exempt.** A wave that runs only the Final review task ends with no `wt-leak:<wave>` label. The run-scoped `wt-leak:baseline` at run start is unaffected. A Final review resume from `verify` runs no `wt-leak:resume`, `wt-show:`, or `wt-create:` label.
4. **Wave-end leak.** A wave completes cleanly, then `wt-leak:<wave>` returns non-empty `paths`. No inter-wave commit, no further scout, and no `wt-sweep:end` run, and `aborted` is set. The start sweep's scenario keeps one still-blocked leftover `{ref, path}`, and the aborted run's `worktrees` lists it.
5. **Resume from verify.** `CFG.resumeFrom` is `verify`, and `wt-show` returns `exists: true` with path `/wt/x`. The first labels are `wt-leak:resume` then `wt-show:<ref>`, with no `wt-create`. The verify prompt contains `/wt/x`.
6. **Resume from judge.** `CFG.resumeFrom` is `judge`, `CFG.attestationFile` is set, and `wt-show` returns `exists: true` with path `/wt/j`. The labels start `wt-leak:resume`, `wt-show:<ref>`, then `judge:<ref>#<n>`, with no `wt-create` and no `verify:`. The judge prompt contains `/wt/j` and the attestation path.
7. **Resume with a missing worktree.** `wt-show` returns `exists: false`. No `verify:`, `judge:`, `dev:`, or `wt-create:` label runs, and the result is an infrastructure failure naming the path.
8. **Resume baseline.** A resumed task that lands passes the baseline fingerprint from `wt-leak:resume` as `--expect` in its `wt-land` prompt.
9. **Clean land before the abort.** Use `Max parallel` 2 and two ready tasks, A and B. A's `wt-land` returns `clean`. Then B's `wt-land` returns `leak`. A still records `done:<A>` and `wt-remove:<A>`. B records no `done:` or `block:`, and `worktrees` lists only B.
10. **Resume from dev reuses a kept worktree.** `CFG.resumeFrom` is `dev`, and `wt-show` returns `exists: true` with path `/wt/d`. No `wt-create:` label runs, and the dev prompt contains `/wt/d`.
11. **Resume from dev without a worktree.** `CFG.resumeFrom` is `dev`, and `wt-show` returns `exists: false`. `wt-create:<ref>` runs after `wt-show:<ref>`, and the dev prompt contains the created path.

## Acceptance criteria

- [x] A leak, from a land or from the wave-end check, sets a run-wide abort. Every task checks it before its slot body, at each attempt, and before each land.
- [x] After an abort, no task lands or parks, no commit or end sweep runs, and the run result carries `aborted` plus every entry still in the `live` map and every still-blocked worktree the start sweep kept.
- [x] A task whose land was clean before the abort still runs `done:` and `wt-remove:`, and is absent from the aborted run's `worktrees`.
- [x] The wave-end leak check runs before the inter-wave commit and is skipped for a wave that ran the Final review.
- [x] A `--from verify|judge` resume takes a baseline fingerprint first, then runs in the worktree `wt-show` reports, and halts naming the path when `exists` is false. A `--from dev` resume runs `wt-show` first, reuses an existing worktree, and runs `wt-create` only when it is missing.
- [x] A Final review resume takes no baseline and runs no `wt-show` or `wt-create`.
- [x] The tree watch, deferral, requalify, and `heldBack` tests still pass unmodified, apart from inserted labels.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes, including all eleven new cases, numbered 1–11 under Tests: waiting sibling, started sibling, Final review exempt, wave-end leak, resume from verify, resume from judge, missing worktree, resume baseline, clean land before the abort, resume from dev reusing a worktree, and resume from dev without one.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/autopilot/scripts` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A task lands or a commit runs after an abort, or a resume lands against no baseline | The abort works, but a queued task still creates a worktree, the Final review trips the leak check, or a missing worktree is silently recreated | Abort, exemptions, and resume behave exactly as specified, with no land after an abort |
| Test coverage | ×2 | No new cases | Leak cases covered, but the waiting-sibling, judge-resume, or missing-worktree case is not | All eleven cases, each asserting the labels named |
| Interface & readability | ×1 | The abort is threaded through several flags | Works, but checks are scattered across call sites | One abort state and one check helper; labels exactly as `worktree.md` names them |
| Assumptions & docs | ×1 | Design notes still describe a leak as a per-task failure | Notes updated but vague | Design notes state the abort rule, the Final review exemptions, and why a missing worktree halts instead of recreating |

## Out of scope

- Deleting the tree watch, deferral, requalify, `heldBack`, or `GATE_SCHEMA.deferred`. Deferred, because structure and behaviour change separately.
- User-facing docs in `autopilot/SKILL.md`, `opencode.md`, and deckplan's authoring guide. Deferred to the docs change.
- Changes to `worktree.ts` itself. Its CLI, `show` and `fingerprint --expect` included, is fixed by `worktree.md`.
- Drift re-verify, `resume-point.ts`, and `fleet.ts`. Already shipped before this change.
