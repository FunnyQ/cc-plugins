# WORKTREE-04: Drift re-verify and its flightdeck and resume-point support

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/03
> **Blocks**: worktree/05
> **Status**: todo

## Goal

When a task lands onto a main tree that moved after its snapshot, the orchestrator re-verifies the merged result in the main tree before it marks the task done, and backs the land out if the check fails. The resume-point derivation and flightdeck both understand the new `reverify` gate.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify): the script block, plus the design-notes prose that describes drift.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify): a `reverify:` stub route and the five drift cases (drift pass, drift fail, drift null twice, drift null then pass, drift model).
- `packages/dispatch/skills/flightplan/scripts/lib/resume-point.ts` (modify): a failed `reverify` supersedes the judge's passing verdict.
- `packages/dispatch/skills/flightplan/scripts/lib/resume-point.test.ts` (modify): cases for that rule.
- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify): `reverify` becomes a gate role.
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify): label-parse and gate-outcome cases for `reverify`.

## Implementation notes

### Starting state

The orchestrator already runs the clean path in per-task worktrees:
- Every `wt-*` call runs under the one main-tree lock, and the `live` map tracks each worktree the run created and has not removed.
- dev, verify, and judge run in the worktree.
- `wt-land --expect` runs under the lock. A conflict runs `wt-rebase` and counts as a failed attempt.
- Mark-done and `wt-remove` follow a clean land.
- A parked task keeps its worktree.

Two land results still have interim behaviour:
- `drift: true` on a clean land is treated exactly like a clean land. **This task replaces that.**
- `status: "leak"` fails only the task that saw it, as a per-task infrastructure failure. **Leave that alone.** A later change turns it into a run-wide abort.

The tree watch, deferral, requalify, and `heldBack` machinery is still present and must keep working. A later change deletes it. Do not delete or rewire any of it here.

### Drift re-verify

This applies when `wt-land` returns `status: "clean"` with `drift: true`. The main-tree lock is still held, and so is the task's `Max parallel` slot. Release neither before this block ends.

1. Run `reverify:<ref>#<attempt>` **in the main tree**, not in the worktree.
   - Use the verify role's model and effort: the task's `verify` override parsed from its `modelsRaw`, otherwise opus / low.
   - Require the same `GATE_SCHEMA` shape the verifier returns.
   - Retry through `resilient(make, retryModel)`, but note that `resilient` retries only when `make` throws and returns a `null` result as-is. So `make` must throw when the agent result is `null`; that is what makes the one retry fire. The retry repeats the same prompt. Repeating it is safe, because `reverify` only runs Verification.
   - A second `null` makes `resilient` throw. Catch it at this call site and take the no-structured-result path below.
2. Build the prompt from the verifier's, with these differences:
   - The working directory is the repo root (`CFG.repoRoot`), not a worktree.
   - It carries no `WORKTREE` line.
   - It says the check runs because the main tree changed after this task's snapshot, so a failure means the merged result is broken.
   - The flightlog role is `reverify`, and the message still leads with `PASS` or `FAIL`.
3. **Pass:** record the land's `fingerprint` as the new main fingerprint and release the lock. Then mark-done and `wt-remove` exactly as on a clean land.
4. **Fail** (a structured result with `passed: false`):
   - Still holding the lock, run `wt-unland:<ref>` with `--op a<attempt>-unland`. The main tree goes back to the land's `previous` tree, so the recorded fingerprint does not change.
   - Run `wt-rebase:<ref>` with `--op a<attempt>-rebase`. The merge was clean, so the rebased worktree holds `R`, the merged result, with no markers.
   - Release the lock and count the attempt as failed.
   - Push an `attempts` entry whose `gateSummary` starts `REVERIFY FAIL:` and quotes the re-verify summary, so the next dev attempt sees why.
   - When that was the last attempt, park the task as for any other exhausted attempt, and keep the worktree.
5. **No structured result, even after the retry:**
   - Still holding the lock, run `wt-unland:<ref>` with `--op a<attempt>-unland`. The merged main tree is unverified, so backing it out is the safe default.
   - Release the lock. Do not rebase, and do not start another attempt.
   - End the task as an infrastructure failure, exactly as a verify with no structured result does today: it parks, and its worktree stays on disk and in the `live` map.
   - The failure reason says the drift re-verify returned no structured result on that attempt, and that the land was undone.

### Resume point: `reverify` supersedes the judge

`resumePoint(entries, task)` in `resume-point.ts` decides `from` latest-evidence-first. Today a passing `verdict` in the last attempt returns `from: "verify"`. A drift re-verify runs after the judge in the same attempt. When it fails, the passing score is stale, and the right restart is a new dev attempt.
- Add `"reverify"` as its own concept. Keep it out of `GATE_ROLES`, so the existing gate logic is unchanged.
- In `decide()`, check first: if the last attempt has a completed `reverify` step whose message matches `/^FAIL\b/`, return `{ from: "dev", gateRejected: true, reason: … }`. The reason names the drift re-verify on that attempt and quotes its message.
- A completed `reverify` whose message starts `PASS` changes nothing; the existing verdict logic applies.
- A `reverify` that only started is also ignored.
- Update the module comment's ordering sentence to say a failed re-verify supersedes the verdict.
- The returned `attempt` stays `lastAttempt + 1`.

### flightdeck: `reverify` is a gate role

In `fleet.ts`:
- Add `"reverify"` to `KNOWN_ROLES`.
- Extend `REF_ATTEMPT` to `/^(verify|requalify|reverify|judge|fix):(.+)#(\d+)$/`, and the cast on its match.
- Add `reverify: 6` to `ROLE_PROGRESS`. It runs after `judge` (5) and before the attempt ends.
- In `gateOutcome()`, treat `reverify` exactly like `verify` and `requalify`: a leading `PASS` or `FAIL`, then the off-contract scan.
- Keep `requalify` everywhere it appears. Flightlogs from past runs still carry it.

### Tests (`orchestrator-script.test.ts`)

Extend the label-routed stub with a `reverify:` route and a per-ref scenario queue. Its default returns a passing gate. Add these cases:
1. **Drift pass.** `wt-land` returns clean with `drift: true`, and `reverify` passes. The label order holds `wt-land:<ref>` → `reverify:<ref>#1` → `done:<ref>` → `wt-remove:<ref>`. The task completes, and the `reverify` prompt carries no `WORKTREE` line.
2. **Drift fail.** The same, but `reverify` fails on attempt 1. The label order holds `reverify:<ref>#1` → `wt-unland:<ref>` → `wt-rebase:<ref>` → `dev:<ref>#2`. Attempt 2's dev prompt contains `REVERIFY FAIL`. `done:<ref>` never runs for attempt 1.
3. **Drift null twice.** `reverify` returns `null` on both tries. The stub records two `reverify:<ref>#1` calls, the second on the structuredRetry model, then `wt-unland:<ref>` → `block:<ref>`. No `wt-rebase:<ref>`, `dev:<ref>#2`, `done:<ref>`, or `wt-remove:<ref>` runs. The result is an infrastructure failure, and its reason mentions the drift re-verify and the undone land. The run result's kept worktrees include the ref.
3b. **Drift null then pass.** `reverify` returns `null` once and a passing gate on the retry. The stub records two `reverify:<ref>#1` calls, then `done:<ref>` → `wt-remove:<ref>`. No `wt-unland:<ref>` runs, and the task completes.
4. **Drift model.** A task with `modelsRaw: "verify=sonnet/high"` runs `reverify` with model `sonnet` and effort `high`. A task without the header runs opus / low.

### Tests (`resume-point.test.ts` and `fleet.test.ts`)

- The last attempt has a passing score row, then a completed `reverify` note whose message starts `FAIL`. Expect `from: "dev"`, `gateRejected: true`, `attempt` = last + 1, and a reason mentioning the re-verify.
- The same trail with a `reverify` message starting `PASS` still returns `from: "verify"`.
- `parseAgentLabel("reverify:ui/main#2")` returns role `reverify`, ref `ui/main`, attempt 2.
- A `reverify` row whose message leads with `FAIL` gets gate outcome `failed`. One leading with `PASS` gets `passed`.

## Acceptance criteria

- [ ] A clean land with `drift: true` runs `reverify:<ref>#<attempt>` in the main tree under the lock, with the task's verify role. A pass records the new fingerprint, then marks the task done and removes its worktree.
- [ ] A failed `reverify` runs `wt-unland`, then `wt-rebase`, then the next attempt, with `REVERIFY FAIL` and the re-verify summary in its feedback.
- [ ] The drift-fail `wt-unland` and `wt-rebase` prompts carry `--op a<attempt>-unland` and `--op a<attempt>-rebase` for the failing attempt, and a retried call repeats the same id.
- [ ] A `reverify` that returns `null` is retried once, because its `make` throws on `null`. A `null` on the retry too runs `wt-unland`, does not rebase, and parks the task as an infrastructure failure with its worktree kept. A retry that passes completes the task.
- [ ] `resumePoint` returns `from: "dev"` with `gateRejected: true` when the last attempt's `reverify` failed after a passing verdict.
- [ ] `fleet.ts` parses `reverify:<ref>#<n>` labels, ranks `reverify` after `judge`, and colours its PASS and FAIL outcomes.
- [ ] A `leak` land result still fails only that task. The tree watch, deferral, requalify, and `heldBack` tests still pass unmodified, apart from inserted labels.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes, including the five drift cases (drift pass, drift fail, drift null twice, drift null then pass, drift model).
- [ ] `bun test packages/dispatch/skills/flightplan/scripts/lib/resume-point.test.ts` passes.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts` passes.
- [ ] `bunx --bun tsc --noEmit 2>&1 | grep -E "packages/dispatch/skills/(autopilot|flightplan)/scripts"` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A failed or silent re-verify leaves the merged main tree in place, or the re-verify runs in the worktree | Pass and fail work, but a `null` result is not retried once, the null path rebases or starts another attempt, or the lock is released before unland | Pass, fail, and null each behave exactly as specified, under the lock, with the verify role's model and effort |
| Test coverage | ×2 | No new cases | Drift pass and fail are covered, but either null case or the model case is not | All five orchestrator cases, plus the resume-point and fleet cases |
| Interface & readability | ×1 | The reverify prompt duplicates the verify prompt wholesale | Works, but the labels or roles drift from `worktree.md` | The reverify prompt reuses the verify prompt with the stated differences, and labels match exactly |
| Assumptions & docs | ×1 | Design notes still describe drift as treated like clean | Notes updated but vague | Design notes state the drift rule, why it unlands, and the resume-point supersession |

## Out of scope

- The run-wide abort on a leak, the wave-end leak check, Final review exemptions, and single-task resume in worktrees. Deferred to the next change in this bucket; a `leak` stays a per-task failure here.
- Deleting the tree watch, deferral, requalify, `heldBack`, or `GATE_SCHEMA.deferred`. Deferred, because structure and behaviour change separately.
- User-facing docs in `autopilot/SKILL.md`, `opencode.md`, and deckplan's authoring guide. Deferred to the docs change.
- Changes to `worktree.ts` itself. Its CLI, `unland` and `rebase` included, is fixed by `worktree.md`.
