# WORKTREE-03: Land results — conflict rebase and park

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/02
> **Blocks**: worktree/04
> **Status**: todo

## Goal

A land conflict no longer ends the task. The orchestrator rebases the task's worktree onto the current main tree and gives the next attempt the conflicted files, and a parked task reports the worktree it kept.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify): the land-result branch in `executeTask`, the park path, and the design-notes prose below the script.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify): the `wt-rebase:` stub route and the new test cases.

## Implementation notes

### What already exists

The script already has this worktree layer, and this task builds on it without changing it:
- **`CFG.repoRoot`**: every `worktree.ts` call passes `--repo ${CFG.repoRoot} --slug ${CFG.slug}`.
- **`withMainLock(fn)`**: the one promise-chain main-tree lock. It wraps every `wt-*` agent call.
- **`wtCall(label, command, schema)`**: a mechanical haiku agent wrapped in `resilient(...)`, with a `make` that throws on a `null` result. A missing structured result is retried once with a byte-identical command. A second failure throws to the caller, which turns it into `infrastructureFailure(...)`.
- **`live`**: a module-scope map from ref to worktree path. It is set after `wt-create` and deleted after `wt-remove`. The run result's `worktrees` is `live` plus the still-blocked start-kept leftovers.
- **`mainFingerprint`**: assigned by the baseline and by every clean land.
- **The pipeline for a non-final task**: `wt-create` → dev → verify → judge → `wt-land --expect ${mainFingerprint} --op a<attempt>-land`. A `clean` land then runs `done:<ref>` → `wt-remove`.
- **The clean-only land.** Any non-clean land status is currently an infrastructure failure whose cause starts with `LAND NOT CLEAN (<status>):`, and the worktree is kept. Its branch carries the comment `// clean-only land; conflict rebase, park reporting and drift/leak handling replace this`. **This task replaces that branch.**

The tree watch, deferral, requalify, and held-back machinery still exist, and they must keep working. A later change deletes them.

### New mechanical agent

| Label | Command | Schema fields (all required) |
|---|---|---|
| `wt-rebase:<ref>` | `bun ${S}/worktree.ts rebase <ref> --repo … --slug … --op a<attempt>-rebase` | `path` string, `base` string, `conflicted` string[] |

Run it through `wtCall` under `withMainLock`. `<attempt>` is the attempt whose land conflicted, so the op id is `a<attempt>-rebase`. A retried rebase repeats the identical command. `worktree.ts` replays a recorded `--op`, so the retry cannot rebase twice.

### Land result handling

Replace the clean-only branch with this handling. The `wt-land` call runs under the lock, with `--op a<attempt>-land` and `--expect ${mainFingerprint}`.

- **`clean`, `drift: false`**: unchanged. Set `mainFingerprint = fingerprint`, release the lock, then run `done:<ref>`, then `wt-remove` under the lock, and delete `live[ref]`.
- **`clean`, `drift: true`**: interim. Treat it exactly like `drift: false`, with no re-verify. Comment the branch `// interim: drift is landed without re-verify; replaced later`.
- **`conflict`**:
  1. Release the lock. The land left the main tree untouched, and `mainFingerprint` does not change.
  2. Run `wt-rebase` under the lock with `--op a<attempt>-rebase`. Set `wt.base` from its `base`. The path is unchanged, and `live[ref]` keeps it.
  3. Push a failed attempt onto `attempts`. Its `gateSummary` begins `LAND CONFLICT:` and lists every path in the land's `files`, one per line. Set `rationale`, `weighted`, and `missing` the way a failed verify gate does.
  4. `continue` to the next attempt. It reuses the rebased worktree, which now holds the conflict markers. It does not run `wt-create`.
  5. When no attempt is left, the task parks through the normal attempt-cap path. It does not use `infrastructureFailure`.
- **`leak`**: interim. It is an infrastructure failure for that task alone. Its cause starts with `MAIN TREE LEAK:` and lists every path in `paths`. The main tree is not reverted, the task does not land and runs no `wt-remove`, it stays in `live`, and other tasks keep running. Comment the branch `// interim: a leak fails only this task; replaced by a run-wide abort later`.
- **The retried land.** When `wtCall` retries a land whose first result was `null`, it repeats `--op a<attempt>-land` and the same `--expect` byte for byte. If the retry also fails, the task ends as an infrastructure failure with no `done:` and no `wt-remove:`.

### Park

A parked task keeps its worktree and never lands. This covers the attempt cap, an infrastructure failure after `wt-create`, and the interim leak.
- `parkBlocked` and the returned result add the worktree path, taken from `live[ref]`:
  - The parked `reason` ends with the line `Worktree kept at <path>`.
  - The escalation text carries the same `Worktree kept at <path>` line.
- The ref stays in `live`, so the end sweep keeps it and the run result's `worktrees` lists it.
- A task that never reached `wt-create`, such as a final review or a create that failed twice, adds no `Worktree kept at` line.

### Design notes prose (below the script)

- Replace the sentence about the clean-only land with one short note. A land conflict rebases the worktree onto the current main tree and costs one attempt, because the dev must resolve the markers. Conflicting edits within a wave therefore no longer need a `Depends on` edge.
- Add one line saying the land op id is per attempt. After a conflict fix, the next attempt's land acts instead of replaying the old conflict.
- Edit only sentences that now contradict behaviour. The deferral and held-back notes stay.

### Tests (`orchestrator-script.test.ts`)

- The stub `agent()` routes `wt-rebase:`. By default it returns `{path: '/wt/<ref>', base: 'b1', conflicted: <the land's files>}`, and scenarios override it per ref.
- The `wt-land` scenario queue takes a sequence per ref, for example `conflict` then `clean`, and `null` then `clean`.
- Add these cases:
  1. **Conflict then clean.** Attempt 1's land returns `conflict` with `files: ['src/a.ts', 'src/b.ts']`. The label order holds `wt-land:<ref>` → `wt-rebase:<ref>` → `dev:<ref>#2` → `verify:<ref>#2` → `judge:<ref>#2` → `wt-land:<ref>` → `done:<ref>` → `wt-remove:<ref>`. The rebase command carries `--op a1-rebase`, and the second land carries `--op a2-land`. Attempt 2's dev prompt contains `LAND CONFLICT:`, `src/a.ts`, and `src/b.ts`. `wt-create:<ref>` runs exactly once.
  2. **Conflict until the cap.** Every land returns `conflict`. The task parks through the attempt cap. Its escalation and parked reason contain `Worktree kept at /wt/<ref>`. No `done:` or `wt-remove:` runs for the ref, and the run result's `worktrees` contains `{ref, path: '/wt/<ref>'}`.
  3. **Park on a verify cap.** Every verify fails. The parked reason and escalation contain `Worktree kept at /wt/<ref>`, and `wt-sweep:end`'s keep list contains the ref.
  4. **Repeated-null land.** The first `wt-land` result is `null`, and the retry returns `clean`. Both recorded `wt-land` prompts carry the identical `--expect` and `--op a1-land`, and the task completes.
  5. **Repeated-null rebase.** The first `wt-rebase` result is `null`, and the retry returns a result. Both prompts carry `--op a1-rebase`, and attempt 2 runs.
  6. **Interim leak.** A land returns `leak` with `paths: ['x.ts']`. The task's cause starts with `MAIN TREE LEAK:` and names `x.ts`. It records no `done:` or `wt-remove:`, and its ref stays in `worktrees`. A sibling task in the same wave completes.
  7. **Interim drift.** A land returns `clean` with `drift: true`. The task completes exactly like `drift: false`, with no extra label.

## Acceptance criteria

- [ ] A `conflict` land runs `wt-rebase:<ref>` under the main-tree lock with `--op a<attempt>-rebase`. The next attempt reuses the same worktree path, runs no second `wt-create`, and its dev prompt contains `LAND CONFLICT:` plus every conflicted file.
- [ ] After a conflict on attempt 1, attempt 2's land carries `--op a2-land`. A conflicted land leaves `mainFingerprint` unchanged, so attempt 2's `--expect` equals attempt 1's.
- [ ] A task that conflicts on every attempt parks through the attempt cap, and its escalation contains `Worktree kept at <path>`.
- [ ] Every parked task whose worktree was created reports `Worktree kept at <path>` in both its parked reason and its escalation. It records no `wt-land` success and no `wt-remove:`, and appears in the run result's `worktrees`.
- [ ] A retried `wt-land` or `wt-rebase` repeats a byte-identical command, with the same `--op`, and for a land the same `--expect`.
- [ ] A `leak` land fails only that task, with a cause starting `MAIN TREE LEAK:`. A `clean` land with `drift: true` completes like `drift: false`. Both interim branches carry their one-line comment.
- [ ] The `LAND NOT CLEAN (` cause no longer appears anywhere in `orchestrator.md`.
- [ ] Every existing test still passes, including `defer and requalify gate`, `held-back paths`, and `plan concurrency cap`.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes, including the seven new cases.
- [ ] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/autopilot` prints nothing.
- [ ] `rg -n "LAND NOT CLEAN" packages/dispatch/skills/autopilot/references/orchestrator.md` prints nothing.
- [ ] `rg -n "SIBLING_MARKER|makeTreeWatch|deferralAccepted|heldBack" packages/dispatch/skills/autopilot/references/orchestrator.md` still prints matches, because the machinery must survive this task.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Any of: a conflict lands; a rebase runs outside the lock; a retry uses a new `--op`; a conflict recreates the worktree | Conflict rebase works, but the park path loses the worktree path, or `mainFingerprint` moves on a conflict | Conflict → rebase → next attempt, park reporting, and both interim branches match the worktree contract exactly. Every retry replays the same `--op` and `--expect`. |
| Test coverage | ×2 | No new tests | Conflict-then-clean only | All seven cases are tested, and label order and op ids are asserted |
| Interface & readability | ×1 | Rebase inlined outside `wtCall`, or conflict feedback built ad hoc | Works, but the land branch is hard to follow | One land-result switch in the script's idiom, reusing `wtCall`, `withMainLock`, and `live` |
| Assumptions & docs | ×1 | Design notes still describe the clean-only land | Conflict note added, but interim comments missing | The conflict and op-id notes state their why, and each interim branch carries its comment |

## Out of scope

- Drift re-verify in the main tree, `wt-unland`, `resume-point.ts`, and flightdeck's `reverify` role. Deferred: a later change replaces the interim drift branch.
- The run-wide abort on leak, the wave-end leak check, and single-task resume in a kept worktree. Deferred: a later change replaces the interim leak branch.
- Deleting the tree watch, deferral, requalify, and `heldBack`. Deferred, because structure and behaviour change separately.
- Changes to `worktree.ts`, the lock, `wtCall`, or the sweeps. They already exist; report a mismatch rather than editing them.
