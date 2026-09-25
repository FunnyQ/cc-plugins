# WORKTREE-02: Run each task pipeline in its own worktree

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/01, models/02
> **Blocks**: worktree/03
> **Status**: done

## Goal

Every non-final autopilot task runs dev, verify, and judge inside its own git worktree. Its result enters the main tree only through a clean land, under one main-tree lock that wraps every `worktree.ts` call. This task builds the isolation layer, the sweeps, and a clean-only land. A later change replaces the non-clean land handling.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify): the script block, plus the design-notes prose below it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify): stub routes for the new labels, plus the new test cases.
- `packages/dispatch/skills/autopilot/SKILL.md` (modify): one Step 1 line that resolves `CFG.repoRoot`, and nothing else in this file.

## Implementation notes

This change is behaviour-only. **Leave the tree watch, the deferral, the requalify step, and the held-back paths working.** That covers `makeTreeWatch`, `withWriter`, `SIBLING_MARKER`, `deferralAccepted`, the requalify block in `executeTask`, `GATE_SCHEMA.deferred`, the `heldBack` set, and `commitInstructions(…, heldBack)`. A later change deletes them. Their existing tests must still pass, changed only by inserted `wt-*` labels: `describe("defer and requalify gate")`, `describe("held-back paths")`, and `describe("plan concurrency cap")`.

`worktree.ts` already exists at `${S}/worktree.ts`, where `S = CFG.scriptsDir`. Its CLI, output shapes, exit codes, and idempotency rules are in `../_context/worktree.md`. This task only calls it.

### Clean-only land (stated on purpose)

This task lands only a `clean` result. A later change replaces everything else in this list.
- A land that returns `clean` lands, whatever its `drift` value, and gets no re-verify.
- Any other land status (`conflict` or `leak`) is an infrastructure failure for that task, built with `infrastructureFailure(...)`.
  - Its cause starts with `LAND NOT CLEAN (<status>):` and lists `files` for a conflict or `paths` for a leak.
  - The task does not land, does not run `wt-remove`, and stays in `live`, so its worktree is kept and reported.
  - Other tasks keep running.
- Put one comment at that branch: `// clean-only land; conflict rebase, park reporting and drift/leak handling replace this`.
- Single-task resume stays as it is. It keeps running in the main tree and gets no `wt-*` agent.
- There is no wave-end leak check yet.

### CFG

- Add `repoRoot: '<abs>'` to the `CFG` literal. Its value is the absolute output of `git rev-parse --show-toplevel`. Every `worktree.ts` call passes `--repo ${CFG.repoRoot} --slug ${CFG.slug}`.
- In `autopilot/SKILL.md` Step 1, add one line to the CFG-assembly list. It sets `CFG.repoRoot` to the root that `git rev-parse --show-toplevel` already captured there. Make no other edit to SKILL.md.
- Add `repoRoot` to the config fixture that `loadScript` / `runOrchestrator` use in the test file.

### Mechanical worktree agents

A Workflow script has no process API, so each `worktree.ts` call is an `agent()` with these properties:
- It runs on haiku, taken from the mechanical entry of the role map in `../_context/models.md`, not a literal.
- It has a JSON schema that mirrors the printed object, with every field required.
- Its prompt says to run exactly this one command and return its stdout JSON through StructuredOutput. Include `RETURN_CONTRACT`.

**Null-throwing wrapper.** The existing `resilient(make, retryModel)` retries only when `make` throws, and passes a `null` result through unchanged.
- Add one helper, for example `wtCall(label, command, schema)`. Its `make` calls `agent(...)` and throws when the result is `null`, and it runs that `make` through `resilient(make, MODEL.structuredRetry)` (or whatever the role map calls the structuredRetry entry). A missing structured result is then retried exactly once.
- The retry repeats the identical command string, including the same `--op` and the same `--expect`. Never recompute either between the two calls. This is safe because `worktree.ts` replays a recorded `--op` and makes every other subcommand idempotent.
- A second failure, meaning the retry also threw, reaches the caller as a thrown error. The caller turns it into `infrastructureFailure(ref, attempt, cause, …)`, the same way a verify that returns nothing is handled. When the failing call is a sweep or the baseline, the run stops with the cause, because no task owns it.

| Label | Command | Schema fields (all required) |
|---|---|---|
| `wt-create:<ref>` | `bun ${S}/worktree.ts create <ref> --repo … --slug …` | `path` string, `base` string |
| `wt-land:<ref>` | `… land <ref> --expect <fingerprint> --op a<attempt>-land …` | `status` enum `clean`/`conflict`/`leak`, `drift` boolean, `files` string[], `paths` string[], `fingerprint` string, `previous` string |
| `wt-remove:<ref>` | `… remove <ref> …` | `removed` boolean |
| `wt-sweep:list` | `… sweep --keep-all …` | `removed` array, `kept` array of `{ ref, path }` |
| `wt-show:<ref>` | `… show <ref> …` | `path` string, `base` string or null, `exists` boolean |
| `wt-sweep:start` / `wt-sweep:end` | `… sweep --keep <ref,…> …`, omitting `--keep` when the list is empty | `removed` string[], `kept` array of `{ ref: string, path: string }` |
| `wt-leak:baseline` | `… fingerprint …` | `fingerprint` string, `paths` string[] |

- The `wt-land` schema requires all six fields for every status, with the values fixed by the "Land result fields" table in `../_context/worktree.md`.
- Build the land op id from the attempt: `a<attempt>-land`. A new attempt gets a new id.
- Keep the last fingerprint in one module-scope variable, `mainFingerprint`. Only the baseline and a clean land assign it.

### Main-tree lock

Add a plain promise-chain lock beside `makeSlots`, for example `const withMainLock = (fn) => { const run = mainTail.then(fn); mainTail = run.catch(() => {}); return run }`.
- Exactly one lock exists for the whole run.
- It wraps **every** `wt-*` agent call: `wt-create`, `wt-land`, `wt-remove`, both `wt-sweep` calls, and `wt-leak:baseline`. Each one reads or rewrites the main tree or the shared `state.json`.
  - A multi-file `git apply` is not atomic, so a `create` that snapshots while another task is landing would capture half a land.
  - Two unlocked state rewrites can lose an entry.
- It is taken inside the task's existing `inSlot(...)` slot, so the `Max parallel` slot still covers the whole pipeline, land included.
- Dev, verify, judge, and mark-done run outside the lock.

### Pipeline for a non-final task

`executeTask(item, watch)` gains a per-task `wt = { path, base }`.
1. Before the attempt loop, run `wt-create` under the lock, then set `live[ref] = path`.
2. Each attempt runs dev, then verify, then judge, exactly as today, with the worktree rules in every prompt (see Prompts).
3. When the judge passes, run `wt-land` under the lock with `--expect ${mainFingerprint} --op a<attempt>-land`.
   - `clean`: set `mainFingerprint = fingerprint` and release the lock. Run mark-done (`done:<ref>`) against the main-tree task file as today. Then run `wt-remove` under the lock and delete `live[ref]`.
   - Any other status: the clean-only failure above.
   - **After a clean land, never park and never unland.** The work has passed its judge and is already in the main tree.
     - If `done:<ref>` returns no structured result even after its retry, the result is an infrastructure failure whose reason is "landed, but Status was not marked done". Still run `wt-remove`. A person re-runs `mark-done.ts` by hand; the next run does not re-offer the task only if its Status is fixed, which the escalation says.
     - If `wt-remove` returns no structured result even after its retry, the task still counts as completed. Run `wt-show:<ref>` under the lock to learn what happened. When `exists` is false, delete `live[ref]`, because the removal did happen. When `exists` is true, or `wt-show` also returns nothing, delete `live[ref]` and append `{ ref, path }` to a run-level `cleanupFailures` list. The task stays in `completed` only; it is not in `escalations` or `needsHuman`. The end sweep's keep list does not include it, so the end sweep retries the removal; the entry stays in `cleanupFailures` either way, because the orchestrator cannot tell whether that retry worked.
     - Add a stub route for `wt-show:`. Its default returns `{ path: '/wt/<ref>', base: 'b0', exists: true }`. A later change reuses this route for resume.
     - Test both: a double-null `done:` after a clean land records `wt-remove:` and no `block:` or `wt-unland:`; a double-null `wt-remove:` followed by `wt-show` `exists: false` completes the task and lists nothing; followed by `exists: true` it puts `{ ref, path }` in `cleanupFailures` and not in `worktrees`.
4. A retry after an ordinary verify or judge failure reuses the worktree unchanged. It does not run `wt-create` again.

### Live worktrees

Keep one module-scope `live` map from ref to worktree path.
- Set `live[ref]` right after every successful `wt-create`.
- Delete `live[ref]` right after every successful `wt-remove`.
- The kept-worktree report is `live` plus every entry in `startKept` (see below) whose ref the last scout still reports as `blocked`, with no duplicate refs. The run result's `worktrees`, and anything else that reports kept worktrees, uses only this union. Never build it from the end sweep's result.

### Final review and sweeps

- **Final review.** A task with `finalReview: true` runs exactly as today, in the main tree. It gets no task-scoped `wt-*` agent, no `WORKTREE` line, and no land. The run-scoped sweeps and baseline still run.
- **Start sweep.** At run start, before wave 1's dispatch, run `wt-sweep:start`, then `wt-leak:baseline`, which assigns `mainFingerprint`.
  - Build the keep list from the first scout's `unfinished` entries whose `state` is `blocked`.
  - The sweep deliberately removes this slug's leftovers from a previous run, except those of `blocked` refs. It touches nothing outside the slug's worktree root, `<repo-parent>/.<repo-name>-autopilot/<slug>/`.
  - Save the sweep's returned `kept` entries (`{ ref, path }`) as `startKept`. They were not created by this run, so they are not in `live`.
- **End sweep.** After the loop, run `wt-sweep:end --keep <refs>`. The keep list is every ref in `live`, plus every ref in `startKept` that the last *successful* scout still reports as `blocked`. A blocked leftover this run never touched therefore keeps its worktree, and its unlanded work survives.
  - When the first scout failed, there is no keep list at all. Skip both sweeps, and instead run `wt-sweep:list` (`sweep --keep-all`, which removes nothing). Report its `kept` entries plus `live`, so every worktree on disk is listed.
  - When a later scout failed, skip the end sweep, and report `live` plus every `startKept` entry. A stale blocked state must never delete a worktree.
  - Add a test for each: first scout fails → only `wt-sweep:list` runs, and its entries appear in `worktrees`; a later scout fails → no `wt-sweep:end` runs and `startKept` entries are still reported.
- **Run result.** The returned object becomes `{ slug, completed, escalations, needsHuman, worktrees, cleanupFailures }`.
  - `worktrees` is `[{ ref, path }]`, built from the kept-worktree union above and sorted by ref.
  - `cleanupFailures` is `[{ ref, path }]`, sorted by ref; `[]` on a clean run.
  - A fully clean run with no blocked leftovers returns `worktrees: []`.

### Prompts

Add one helper, `worktreeRules(wtPath)`. It returns the rules from "Prompt rules for agents in a worktree" in `../_context/worktree.md`:
- `WORKTREE: <path>`. Run `cd` there first. Every source file you create or edit has an absolute path under it.
- Exactly three writes are exempt, because they belong to the run rather than the task's source:
  - `flightlog.ts log` into the main-tree flightlog.
  - The task file's Status line in the main tree.
  - The judge's scratch files under `/tmp`.
- Nothing else is written outside the worktree.
- The task file and the flightlog stay at their main-tree absolute paths.
- Verification runs from the worktree, with commands relative to the repo root.
- External drivers run `cd <WORKTREE> && <command>` in one shell call.

Pass the worktree path into `devPrompt`, `devExternalPrompt`, `verifyPrompt`, and `judgePrompt`, either as a new trailing parameter or through the item. Each includes `worktreeRules(path)` when the task is not a final review.
- In `devExternalPrompt`, prefix the wrapper command line with `cd <WORKTREE> && `. The wrapper line is either `bun ${S}/${engine.wrapper} delegate…` or `bun ${CFG.relayPath} …`.
- `markDonePrompt` and `markBlockedPrompt` stay main-tree only, because they edit the task file.

### Design notes prose (below the script)

Rewrite the note that begins **"Do NOT give the dev agent `isolation: 'worktree'`."** so that it says three things:
- `agent({isolation: 'worktree'})` is still wrong, because it isolates one agent call and never merges back.
- The orchestrator now owns one worktree per task. It spans dev → verify → judge, and mechanical agents create and land it through `worktree.ts`.
- A judged pass enters the main tree only through a three-way land under the main-tree lock.

Also:
- Add one short note on the main-tree lock. It covers every `worktree.ts` call, because a create that ran unlocked could snapshot half a land, and two unlocked state rewrites could lose an entry.
- Add one short note on the null-throwing wrapper. `resilient` retries only a throw, and the retry is safe only because `worktree.ts` replays a repeated `--op`.
- Edit only the sentences that now contradict behaviour. The deferral and held-back notes stay, because a later change deletes them.

### Tests (`orchestrator-script.test.ts`)

- The stub `agent()` routes these new label prefixes: `wt-create:`, `wt-land:`, `wt-remove:`, `wt-sweep:`, and `wt-leak:`.
  - Defaults:
    - create returns `{path: '/wt/<ref>', base: 'b0'}`.
    - land returns `{status: 'clean', drift: false, files: [], paths: [], fingerprint: <fresh>, previous: <expect>}`.
    - baseline returns `{fingerprint: 'f0', paths: []}`.
    - sweep returns `{removed: [], kept: <keep list mapped to {ref, path: '/wt/<ref>'}>}`.
    - remove returns `{removed: true}`.
  - Scenarios override per ref, including a queue of results, so a first `null` followed by a real result can be scripted.
- The stub records each `wt-*` prompt, so tests can assert the exact command string, including `--op` and `--expect`.
- Existing tests keep passing. Where a test asserts an exact label list, it now includes the `wt-*` labels in their correct positions.

## Acceptance criteria

- [x] `CFG.repoRoot` exists in the script's `CFG` literal. SKILL.md Step 1 sets it from `git rev-parse --show-toplevel`, and that is SKILL.md's only change.
- [x] A clean non-final task records labels in this order: `wt-create:<ref>` → `dev:<ref>#1` → `verify:<ref>#1` → `judge:<ref>#1` → `wt-land:<ref>` → `done:<ref>` → `wt-remove:<ref>`.
- [x] Every `dev:`, `dev-<engine>:`, `verify:`, and `judge:` prompt of a non-final task contains its worktree path. It also names the three exempt writes (flightlog log, task Status line, `/tmp` judge scratch) and forbids any other write outside the worktree. The external-driver prompt's wrapper line is prefixed with `cd <path> && `.
- [x] A test holds one task's `wt-land` open. It asserts that a second task's `wt-create`, `wt-land`, and `wt-remove` each wait until the first releases.
- [x] A `wt-land` whose first result is `null` is retried once with a byte-identical command, carrying the same `--expect` and `--op a1-land`, and the task then completes. A `wt-land` that is `null` twice ends that task as an infrastructure failure, with no `done:` and no `wt-remove:`.
- [x] A land returning `conflict` or `leak` ends that task as an infrastructure failure whose cause starts with `LAND NOT CLEAN (`. It records no `done:` or `wt-remove:` for its ref, its `{ref, path}` appears in the run result's `worktrees`, and a sibling task in the same wave still completes.
- [x] A `clean` land with `drift: true` completes the task exactly like `drift: false`.
- [x] A `finalReview` task records no task-scoped `wt-*` label (`wt-create:`, `wt-land:`, `wt-rebase:`, `wt-remove:` for its ref), and its prompts carry no `WORKTREE:` line. The run-scoped `wt-sweep:start`, `wt-leak:baseline`, and `wt-sweep:end` still run.
- [x] `wt-sweep:start` keeps exactly the refs the scout reports as `blocked`. `wt-leak:baseline` runs after it and before wave 1's first `wt-create`. A fully clean run returns `worktrees: []`.
- [x] Across runs: the scout reports a leftover ref as `blocked` and the start sweep keeps it with a path. This run never dispatches it. `wt-sweep:end`'s keep list still contains it, and the run result's `worktrees` contains that `{ref, path}`.
- [x] The existing `defer and requalify gate`, `held-back paths`, and `plan concurrency cap` tests pass, changed only by inserted `wt-*` labels.
- [x] The rewritten isolation note no longer tells readers to sequence conflicts with `Depends on` instead of isolating them.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/autopilot` prints nothing.
- [x] `rg -n "repoRoot" packages/dispatch/skills/autopilot/SKILL.md` prints exactly one line.
- [x] `rg -n "SIBLING_MARKER|makeTreeWatch|deferralAccepted|heldBack" packages/dispatch/skills/autopilot/references/orchestrator.md` still prints matches, because the machinery must survive this task.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Any of: a `wt-*` call runs without the lock; a final review gets a worktree; a non-clean land lands; a retried land uses a new `--op` or `--expect` | The clean path works, but a non-clean land removes its worktree, or `worktrees` is built from a sweep result | The clean path, the non-clean failure, both sweeps, and the cross-run blocked leftover match the worktree contract. Every `wt-*` call is under the lock and goes through the null-throwing wrapper. `worktrees` is the `live` ∪ still-blocked `startKept` union. |
| Test coverage | ×2 | No new tests, or existing sibling-machinery tests edited to pass | Clean order and one failure branch tested | All of these are tested: clean order, lock exclusivity, the null-then-retry land, the double null, a non-clean land, drift treated as clean, final review, both sweeps, and the cross-run blocked leftover |
| Interface & readability | ×1 | `worktree.ts` commands inlined ad hoc at each call site, with schemas duplicated | One helper per command, but retries or prompts assembled inconsistently | One `wtCall` helper, one `worktreeRules`, and one lock, matching the script's existing idiom |
| Assumptions & docs | ×1 | Design notes still tell readers to sequence instead of isolate | Isolation note rewritten, but the lock or wrapper rationale is missing, or the clean-only branch has no comment | Isolation, lock, and wrapper notes each state their why in a few lines, and the clean-only branch carries its one-line comment |

## Out of scope

- Conflict rebase (`wt-rebase`), park reporting with `Worktree kept at <path>`, drift re-verify, `wt-unland`, the run-wide abort on leak, the wave-end leak check, and single-task resume in a kept worktree (`show`). Deferred: later changes in this plan replace the clean-only failure with each of these.
- `resume-point.ts` and flightdeck's `reverify` role in `fleet.ts`. Deferred, because they only matter once drift re-verify exists.
- Deleting the tree watch, deferral, requalify, `heldBack`, and `GATE_SCHEMA.deferred`. Deferred, because structure and behaviour change separately. A later change removes them once isolation is proven.
- Any SKILL.md change beyond the one `CFG.repoRoot` line. Deferred, because the user-facing autopilot docs are rewritten in one pass later.
- Changes to `worktree.ts` itself. It is already built to the contract in `../_context/worktree.md`, so report a mismatch rather than editing it.
- The OpenCode hand-driven loop, which keeps the shared tree.
