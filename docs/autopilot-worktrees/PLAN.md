# Autopilot per-task worktrees and per-role models

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-09-25
> **Max parallel**: unlimited

Run options: review engine **Codex**, depth **Deep** (re-cut from Standard at pass 5: the written tree is ~2,100 lines; 11 tasks, 4 buckets).

## Overview

Autopilot plans keep declaring `> **Max parallel**: 1`. Every task runs in one shared working tree, so a sibling's half-written file breaks any whole-target build (SwiftPM, `tsc`, Rust, Go). This plan gives each task its own git worktree for its whole dev→verify→judge pipeline, lands the result back into the main tree under a mutex, and moves every pipeline role onto an explicit `{model, effort}` map that a task can override.

## Goals

- A plan for a whole-target-build project runs its waves in parallel with `Max parallel` left at `unlimited`.
- Every task pipeline role runs on the model and effort in the new default map, and a task header can override dev, verify, judge, and fix.
- When a run ends cleanly, no autopilot worktree for the slug remains. Cleanup touches only paths under the slug's worktree root. Only a task whose work has not landed keeps a worktree: a parked task, a still-blocked task from a previous run, or, after a leak abort, every task that had not landed. A landed task whose worktree removal could not be confirmed is reported separately in `cleanupFailures`, and the run does not count as clean. The run report lists each kept path.

## Non-goals

- No change to the OpenCode hand-driven loop (`autopilot/references/opencode.md`). It has no parallel waves, so it keeps the shared tree. Document the difference; do not port the isolation.
- No per-task override for run-wide roles (scout, commit, reviewLens).
- No isolation of external live resources (a device, a LaunchAgent, a local DB). `Max parallel` stays for those.
- No opt-out flag for worktree isolation.
- No version bump or CHANGELOG entry. `/chronicle:release` does that separately.

## Context

- Evidence: `janus-hud/docs/memory-item/PLAN.md:65` declares 1 because "one SwiftPM target compiles every file". `flightplan/references/plan-template.md:126` recommends 1 for "one build target", which covers nearly every compiled project.
- Workflow `agent()` has no `cwd` option. It supports `model` and `effort` (`low | medium | high | xhigh | max`). A worktree therefore has to be owned by the orchestrator, and every prompt has to carry its path. `orchestrator.md:1430` rejects `isolation: 'worktree'` for exactly this reason: isolation must wrap the whole pipeline.
- relay and the `codex-run.ts` / `opencode-run.ts` wrappers use `process.cwd()`, so an external engine follows a driver that has run `cd <worktree>` first.
- `packages/guard/hooks/comment-sweep.ts:44-75` (`worktreeTree`) already snapshots the worktree, untracked files included, through a throwaway `GIT_INDEX_FILE`. dispatch cannot import from guard, so copy the technique; it depends only on `node:fs`, `node:os`, and `node:path`.
- git 2.55 is installed. `git merge-tree --write-tree` needs 2.38 or later.
- The code that exists only to handle sibling interference is listed in `orchestrator.md`: `makeTreeWatch`/`withWriter` (L711–732), `SIBLING_MARKER`/`deferralAccepted` (L752–766), the defer/requalify block (L853–867), `GATE_SCHEMA.deferred` (L272), the verifyPrompt defer text (L537–544), and `heldBack` in `commitInstructions` (L974–976, L1303–1306). `makeSlots` stays, because `Max parallel` still uses it.

## Requirements (MVP)

1. **`> **Models**:` task header.** Syntax: `role=model[/effort]`, comma-separated. Roles are `dev`, `verify`, `judge`, and `fix`; `fix` is legal only on a `Final review: true` task. Models are `haiku`, `sonnet`, `opus`, and `fable`. Efforts are `low`, `medium`, `high`, `xhigh`, and `max`.
   - Acceptance: `parse-task.ts` returns the parsed map, `lint-task.ts` rejects a bad role, model, or effort and a misplaced `fix`, and `next-ready.ts` ready items carry `modelsRaw` (the header value as written, or `null`). The scout carries it as a required structured field, and the orchestrator parses it.
2. **Default role map.** Every value is `{model, effort}`.

   | Role | Default |
   |---|---|
   | dev, first to second-to-last attempt | opus / medium |
   | dev, last Claude rung | the dev entry with effort raised one step (so opus / high by default) |
   | verify, and the drift re-verify (`reverify`) | opus / low |
   | judge | opus / medium |
   | fix | opus / high |
   | commit | opus / low |
   | structuredRetry | opus / medium |
   | devExternal, scout, mark-done, park | haiku (no effort set) |
   | reviewLens | unchanged (`CFG.reviewLensModel`) |

   - Acceptance: orchestrator tests assert the model and effort passed to `agent()` for each role.
3. **Per-task override.** A task's `Models` entry replaces that role's default. The last dev rung raises the task's dev effort one step, and `max` stays `max`. `lastShotEngine` and `devEngine` behave as they do today.
   - Acceptance: a test with `dev=sonnet/low` produces sonnet/low, sonnet/low, then sonnet/medium.
4. **`worktree.ts`** in `flightplan/scripts/` has these subcommands:
   - `create <ref>` snapshots the main tree (tracked plus untracked, without `docs/<slug>/`) into a commit, runs `git worktree add --detach` at `<repo-parent>/.<repo-name>-autopilot/<slug>/<bucket>-<NN>`, and clones every ignored path with `cp -c -R` except `.flightlog`. It prints `{path, base}`.
   - `land <ref>` does a three-way merge with `git merge-tree --write-tree`: the task snapshot is the base, the current main tree is "ours", and the worktree is "theirs". It writes the result into the main working tree without touching the real index, and prints `{status: clean | conflict | leak, drift: bool, files, paths, fingerprint, previous}`, with every field present for every status.
   - `rebase <ref>` checks out the conflicted merge result, markers included, into the worktree and moves its base to the current main tree.
   - `unland <ref>` restores the main tree to its state before this ref's last land, for a failed drift re-verify.
   - `fingerprint [--expect <tree>]` prints the main tree hash, excluding `docs/<slug>/`, plus the paths that differ from `--expect`. `land` takes the same `--expect` and returns `status: "leak"` without touching the main tree.
   - Every call runs through a haiku agent with a JSON schema, because a Workflow script has no process API. `land`, `unland`, and `rebase` take an `--op <id>` built from the attempt and step, and record their result under it, so a repeated call returns it instead of acting twice.
   - `show <ref>` prints `{path, base, exists}` for a single-task resume.
   - `remove <ref>` removes one worktree.
   - `sweep --keep <refs>` removes every worktree for the slug except the kept ones, then runs `git worktree prune`. `sweep --keep-all` only lists them.
   - Acceptance: real-git tests in temp repos cover a clean land, an overlapping-hunk conflict, drift, untracked file carry-over, ignored-dir cloning, and sweep keeping only the named refs.
5. **Pipeline isolation.** Each non-final task runs create → dev → verify → judge → land → mark-done → remove.
   - Every prompt carries `WORKTREE`, `cd`s there first, and writes only paths under it. The task file and flightlog stay at their main-tree absolute paths.
   - One main-tree lock covers every `worktree.ts` call and the drift re-verify, because each call reads or rewrites the main tree or the shared `state.json`. It is taken while the task still holds its `Max parallel` slot.
   - A leak sets a run-wide abort that every task checks before its slot, each attempt, and each land.
   - Conflict: `rebase`, and the next attempt's feedback lists the conflicted files. This consumes an attempt.
   - Drift (the main tree changed since the snapshot): while still holding the mutex, re-run the task's Verification in the main tree with the verify role. If it fails, revert the land, run `rebase`, and consume an attempt.
   - Park: keep the worktree, do not land, and put its path in the escalation.
   - `review/01` runs in the main tree. The wave-end leak check skips its wave, and its resume skips every worktree step.
   - The drift re-verify is labelled `reverify`. `requalify` survives only in `fleet.ts` and `resume-point.ts`, to parse flightlogs from past runs.
   - `--from verify|judge` resume runs in the kept worktree. A fresh resume recreates the worktree.
   - Acceptance: orchestrator tests cover each branch above and the order of labels.
6. **Leak guard.** Record the main-tree fingerprint after every land. Compare it before the next land and at wave end. On a mismatch, halt the run as an infrastructure failure, list the changed paths, and revert nothing.
   - Acceptance: a test that mutates the main fingerprint mid-wave halts with those paths.
7. **Cleanup.** Run `sweep` at run start and keep tasks whose Status is `blocked`. `remove` each worktree after its task lands. Run `sweep` again at run end and keep the parked tasks. The run report lists every kept path.
   - Acceptance: after a clean orchestrator test run, the recorded commands leave no worktree for the slug.
8. **Delete the sibling-interference machinery** (the Context list), in a change separate from requirement 5. Rewrite the L1430 note.
   - Acceptance: `rg "SIBLING_MARKER|makeTreeWatch|deferralAccepted|heldBack" packages/dispatch` returns nothing, and the orchestrator tests pass.
9. **Docs.** Narrow `Max parallel` to external live resources: `plan-template.md:126`, flightplan `SKILL.md` Step 6.4, and autopilot `SKILL.md`.
   - Document the `Models` header in `task-template.md` and in interview guidance (omit it unless the task is unusually hard or easy).
   - Require Verification commands to be relative to the repo root.
   - Update autopilot `SKILL.md`: the model policy table, the brief, escalation, park, resume, and cleanup.
   - Add a shared-tree note to `opencode.md`.
   - Update the dispatch line in the repo `CLAUDE.md`.
   - Acceptance, per file:
     - `plan-template.md` and flightplan `SKILL.md` Step 6.4 carry the narrowed `Max parallel` rule and its OpenCode exception.
     - `task-template.md` documents the `Models` header outside the header template block, and requires relative Verification commands.
     - `interview-guide.md` asks about per-task models, with omit as the default.
     - autopilot `SKILL.md` carries the model table, isolation, the abort, resume, and the cleanup rule.
     - `opencode.md` carries the shared-tree note.
     - `deckplan/references/authoring.md` lists the `reverify` label.
     - The repo `CLAUDE.md` names `worktree.ts`.
     - `rg "one build target" packages/dispatch` returns nothing.

## Tech decisions

- Bun + TypeScript, no runtime deps, `type` over `interface`. Tests use `bun test`, with real git in `mkdtemp` repos for `worktree.ts`.
- The orchestrator logic stays in `autopilot/references/orchestrator.md`'s script block. Tests go in `autopilot/scripts/orchestrator-script.test.ts`, which uses the existing label-routed `agent()` stub; extend it to record `effort`.
- `worktree.ts` lives in `flightplan/scripts/` beside `next-ready.ts`, so the orchestrator reaches it through `${S}`.
- Commits go through `chronicle:commit`. Executors do not commit.
- Typecheck: `bunx --bun tsc --noEmit | grep packages/dispatch` must print nothing new.

## Architecture

```
wave ─┬─ task A: create → dev(WT_A) → verify(WT_A) → judge ─┐
      └─ task B: create → dev(WT_B) → verify(WT_B) → judge ─┤
                                                            ▼
                        land mutex: leak check → merge-tree → (drift? re-verify in main)
                          clean  → mark-done (main) → remove WT
                          conflict/drift-fail → rebase WT → next attempt
      wave end: leak check → inter-wave commit (main tree, no heldBack)
run start/end: sweep (keep blocked/parked)
```

## Bucketing

- **Strategy**: by feature. `models/` and `worktree/` advance in parallel. Tasks that edit `orchestrator.md` are chained so they never share a wave.
- **`models/`**: header parsing, then the role map.
- **`worktree/`**: the script; pipeline isolation (the lock, create/remove, worktree prompts, the `live` map, sweeps); land integration (clean land, conflict rebase, park); drift re-verify with `resume-point.ts` and flightdeck `reverify`; the run-wide abort on leak and single-task resume; then the deletion.
- **`docs/`**: flightplan docs, then autopilot docs.
- **`review/`**: final review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| models | 01 | models-header | todo | > 4.0 | — |
| models | 02 | role-map | todo | > 4.0 | models/01 |
| worktree | 01 | worktree-script | todo | > 4.0 | — |
| worktree | 02 | pipeline-isolation | todo | > 4.0 | worktree/01, models/02 |
| worktree | 03 | land-integration | todo | > 4.0 | worktree/02 |
| worktree | 04 | drift-reverify | todo | > 4.0 | worktree/03 |
| worktree | 05 | leak-abort-resume | todo | > 4.0 | worktree/04 |
| worktree | 06 | remove-sibling-machinery | todo | > 4.0 | worktree/05 |
| docs | 01 | flightplan-docs | todo | > 4.0 | models/01 |
| docs | 02 | autopilot-docs | todo | > 4.0 | worktree/06 |
| review | 01 | final review 🏁 | todo | > 4.0 | docs/01, docs/02 |

Engine **Codex**, depth **Deep** (re-cut once, at pass 5).

## Cross-bucket dependencies

```
models/01 → models/02 ──┐
worktree/01 ────────────┴→ worktree/02 → … → worktree/06 → docs/02 ─┐
models/01 → docs/01 ────────────────────────────────────────────┴→ review/01
```

Wave 1 runs models/01 and worktree/01. Wave 2 runs models/02 and docs/01.

## Verification

- Each task runs only its own test files by name. A sibling's half-written test file must not fail it, because this plan still runs on today's shared-tree autopilot.
- `review/01` runs `bun test packages/dispatch/`, `bunx --bun tsc --noEmit | grep packages/dispatch`, and the `rg` checks above.
- `(human)`: Q runs autopilot on a two-task-wide plan in a whole-target-build repo (for example janus-hud) and confirms that both tasks' dev steps overlap in time, and that `git worktree list` shows only the main tree afterwards.

## Open questions

None blocking.

## Known gaps

- A cloned SwiftPM `.build` embeds absolute paths and may rebuild fully inside a worktree. Q skipped the spike. Measure it during the `(human)` check.
- Semantic conflicts are caught only on drift. Two tasks that each land onto an unchanged base cannot conflict, so this is complete.
- An agent that edits through an absolute main-tree path is detected by the leak guard, not prevented.

## Assumptions resolved by guessing

- The Workflow model alias `opus` resolves to Opus 5.5.
- The Bash cwd of a Workflow agent persists after `cd`, as it does in the main session.
- A parked task's worktree survives until a person resumes it or deletes it. The next run's start-sweep keeps it only while its Status is `blocked`.
