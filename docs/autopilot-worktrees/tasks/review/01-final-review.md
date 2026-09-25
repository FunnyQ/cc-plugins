# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/models.md`
> - `../_context/worktree.md`
> - `../_context/rubric.md`
>
> **Depends on**: docs/01, docs/02
> **Status**: todo
> **Final review**: true

## Goal

Autopilot's parallel waves work for whole-target-build projects with `Max parallel` left at `unlimited`. Every pipeline role runs on the default model/effort map, and a task header can override it. After a clean run, no worktree for the plan's slug remains. Cleanup touches only paths under the slug's worktree root.

## Files to create / modify

- No new files. This task reviews the whole diff since the plan's base commit (see "Plan base commit" in `../_context/shared.md`). It fixes integration defects in whichever file holds them, then re-runs Verification.

## Implementation notes

This is the holistic gate. It does not re-score individual tasks. It checks that the pieces compose, that the plan's goal was met, and that nothing regressed.

### What shipped, end to end

- **Models header.** An optional task header, for example `> **Models**: dev=opus/high, verify=sonnet`, with the syntax and rules in `../_context/models.md`.
  - `parseTask()` in `packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts` parses it.
  - `lint-task.ts` rejects bad roles, models, and efforts, duplicate roles, and `fix` on a non-final task.
  - `next-ready.ts` ready items carry `modelsRaw`: the header value with only its outer whitespace trimmed (inner text untouched), or `null` when it is absent. There is no parsed map on the ready item.
  - The autopilot scout returns `modelsRaw` as a required structured field for each ready item. A missing field, a value that disagrees with the scout's verbatim stdout, or a value the in-script parser rejects is a `(scout)` failure, never a fallback to defaults.
  - The orchestrator parses `modelsRaw` with a small in-script copy of the parser, then applies each override over the default map.
- **Default role map and escalation.** These live in `packages/dispatch/skills/autopilot/references/orchestrator.md`. The last Claude dev rung raises the dev effort one step; `max` stays `max`. Scout, mark-done, and park have their own haiku entry, no longer sharing verify's.
- **Per-task worktrees.** `packages/dispatch/skills/flightplan/scripts/worktree.ts` provides `create`, `land --expect --op`, `unland --op`, `rebase --op`, `fingerprint [--expect]`, `show`, `remove`, and `sweep [--keep]`. Each prints one JSON object. `land` prints every field for every status, following the land result-field table in `../_context/worktree.md`. The orchestrator drives every call through a haiku agent with a schema, labelled `wt-*:` or `reverify:`. Every call is safe to repeat: `land`, `unland`, and `rebase` take an `--op <id>` built from the attempt and step (`a<attempt>-land`, `a<attempt>-unland`, `a<attempt>-rebase`), record their result in `state.json` under that id, and return it on a repeat with the same id. A new id always acts, so a later attempt's land is never answered from an earlier one. The orchestrator retries a missing structured result once through `resilient(...)`. Because `resilient` retries only on a throw, each `wt-*` call and `reverify` goes through a `make` that throws on a `null` result. A second `null` is an infrastructure failure for the task.
  - **Pipeline isolation** (worktree bucket, second task). One main-tree lock covers every `worktree.ts` call and the drift re-verify. The orchestrator keeps a `live` map from ref to worktree path, set on `create` or resume `show`, cleared on `remove`. Dev, verify, and judge run inside the worktree and write every source file there; only `flightlog.ts log`, the task file's Status line, and the judge's `/tmp` scratch files are written outside it. The start and end sweeps run.
  - **Land integration** (worktree bucket, third task). A clean land is followed by mark-done and `remove`. A conflict rebases the worktree and fails the attempt. A park keeps the worktree.
  - **Kept-worktree reports.** Every report of kept worktrees, at a clean end or an abort, lists the `live` map plus each `{ref, path}` the start sweep kept whose Status is still `blocked`. No report reads the end sweep's result.
  - **Failure paths.**
    - Drift (worktree bucket, fourth task, with `resume-point.ts` and `fleet.ts`): a clean land with `drift: true` runs `reverify:<ref>#<attempt>` in the main tree while the lock is held. A failure runs `unland` and then `rebase`, and fails the attempt.
    - Leak (worktree bucket, fifth task, with single-task resume): a leak sets the run-wide abort, which every task checks before its slot, before each attempt, and before each land. An aborted run skips the end sweep and reports kept worktrees by the rule above. A task whose land was clean before the abort still finishes mark-done and `remove`; the abort keeps only worktrees with unlanded work.
    - Single-task resume: it takes its own baseline `fingerprint` and resolves the kept worktree with `show`. A resume from `dev` runs `show` first and reuses an existing worktree; it runs `create` only when the worktree is missing.
    - `flightplan/scripts/lib/resume-point.ts`: a failed `reverify` supersedes the judge's passing verdict, so resume starts from `dev`.
    - `autopilot/scripts/fleet.ts`: `reverify` is a gate role in the role list, `REF_ATTEMPT`, the role order, and `gateOutcome()`.
  - The Final review task (this one) runs in the main tree.
- **Sibling-interference machinery deleted** (worktree bucket, sixth task). That is the tree watch, the writer windows, the deferral predicate, the sibling marker, the requalify-on-defer path, `GATE_SCHEMA.deferred`, and `heldBack` in the commit instructions. `makeSlots` stays, because `Max parallel` still uses it.
- **Docs, per file.**
  - `flightplan/references/plan-template.md` and flightplan `SKILL.md` Step 6.4 carry the narrowed `Max parallel` rule (external live resources under Claude Code) and its OpenCode exception (a shared build target still needs 1 there).
  - `task-template.md` documents the `Models` header in its own `### Models` section, outside the header template block, and requires Verification commands relative to the repo root.
  - `interview-guide.md` asks about per-task models, with omitting the header as the default.
  - autopilot `SKILL.md` carries the model table, isolation, the abort, resume in a kept worktree, and the cleanup rule.
  - `autopilot/references/opencode.md` carries the shared-tree note.
  - `deckplan/references/authoring.md` lists the `reverify` label.
  - The repo `CLAUDE.md` names `worktree.ts`.
  - `rg "one build target" packages/dispatch` returns nothing.

### Cross-checks to make

1. **Models flow.** Trace one header from a task file to the `agent()` call options. Name each hop and confirm its field names match: the ready item's `modelsRaw`, the scout schema's required `modelsRaw`, the stdout cross-check, the in-script parse, and the orchestrator lookup. The in-script parser must accept and reject exactly what `lint-task.ts` does: both implement the four-step grammar in `../_context/models.md`, and both test files pin the same nine parity fixtures, including `judge = opus / xhigh`, `dev=opus,`, and ` dev=sonnet/low , verify=haiku `.
2. **CLI contract.** Every `worktree.ts` invocation in `orchestrator.md` must match the script. Check subcommand names, flags (`--repo`, `--slug`, `--expect`, `--op`, `--keep`), and the JSON fields read back (`path`, `base`, `exists`, `status`, `drift`, `files`, `paths`, `fingerprint`, `previous`, `conflicted`, `removed`, `kept`, `restored`). For `land`, check every status against the land result-field table. Check that each schema the orchestrator passes to those agents mirrors the printed object.
3. **One role map.** Compare three sources: the defaults in `orchestrator.md`, the Model policy table in autopilot `SKILL.md`, and the table in `../_context/models.md`. They must agree on every role, model, and effort.
4. **No remnants.** Check for prompt text that still tells agents the wave shares one working tree. Check for tests that still exercise deferral or `heldBack`.
5. **Lock, retry, and abort.** Confirm every `worktree.ts` call and the drift re-verify go through the one lock. Confirm a repeated `land`, `unland`, or `rebase` with the same `--op` id returns the recorded result instead of acting twice (a repeated `land` must not report its own first write as a leak), and that each attempt passes a new id. Confirm each `wt-*` call and `reverify` retries a `null` result exactly once through a throwing `make`. Confirm the abort flag is checked at all three points and stops every land that comes after it, while a task that landed cleanly before the abort still finishes mark-done and `remove`.
6. **Cleanup.** Confirm the start sweep keeps `blocked` refs, a clean land runs `remove`, and the end sweep keeps every ref in the `live` map plus every start-kept ref whose Status is still `blocked`, and reports their paths. Confirm the start sweep deliberately removes this slug's previous-run leftovers except `blocked` refs, and that every sweep touches only paths under the slug's worktree root. Confirm kept-worktree reports, at a clean end and at an abort, list the `live` map plus the still-blocked start-kept `{ref, path}` entries, and never read the end sweep's result. Confirm the test suite removes every temp worktree it creates.

## Acceptance criteria

- [ ] A task header `> **Models**: dev=sonnet/low` reaches `agent()` as sonnet/low on the early dev rungs and sonnet/medium on the last Claude rung. A covering test in `orchestrator-script.test.ts` shows this.
- [ ] Every `worktree.ts` subcommand, flag, and JSON field that `orchestrator.md` uses exists in `worktree.ts` with the same name and meaning.
- [ ] The default role map agrees across three places: `orchestrator.md`, autopilot `SKILL.md`, and `../_context/models.md`.
- [ ] `packages/dispatch` contains no sibling-interference code, tests, or prompt text. `fleet.ts` and `resume-point.ts` may still parse `requalify` rows from past flightlogs.
- [ ] A failed drift re-verify leads `resume-point.ts` to `dev`, and `fleet.ts` shows a `reverify` row with a PASS or FAIL outcome. Covering tests exist in `packages/dispatch/skills/flightplan/scripts/lib/resume-point.test.ts` and `packages/dispatch/skills/autopilot/scripts/fleet.test.ts`.
- [ ] Each doc file listed under "Docs, per file" carries exactly the items listed for it there, and the docs describe the shipped behaviour.
- [ ] (human) Q runs autopilot on a plan with a two-task-wide wave in a whole-target-build repo (for example janus-hud). Q confirms that both tasks' dev steps overlap in time, notes whether the cloned build cache rebuilt incrementally, and confirms that `git worktree list` shows no path under `<repo-parent>/.<repo-name>-autopilot/<slug>/` afterwards.

## Verification

- [ ] `bun test packages/dispatch/` passes.
- [ ] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch` prints nothing.
- [ ] `rg -n "SIBLING_MARKER|makeTreeWatch|deferralAccepted|heldBack|one build target" packages/dispatch` returns nothing.
- [ ] After the test run, `git worktree list | grep -- "-autopilot/autopilot-worktrees/"` prints nothing. The suite leaves no worktree for this slug registered on this repo. Unrelated worktrees may remain.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Integration < 4 and No regressions < 4 are each an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration | ×3 | Models or worktree calls break at a hop, for example a field name mismatch or a schema that does not mirror the CLI | Pieces connect on the happy path, but a branch (conflict, drift, park, resume) calls the CLI wrongly | Every hop and every branch composes, including conflict, drift, leak abort, and resume, and the CLI contract matches exactly |
| Meets the PLAN goal | ×3 | Parallel waves still need `Max parallel: 1` for a whole-target build, or overrides are ignored | Isolation works, but cleanup leaves worktrees, or escalation ignores the override | Waves run isolated in parallel, overrides and escalation apply, and a clean run leaves no worktree for the slug |
| Consistency | ×2 | The role map or the CLI differs across code and docs | Minor drift in one doc | Code, `SKILL.md` files, templates, `opencode.md`, and `CLAUDE.md` all agree |
| No regressions | ×2 | `bun test packages/dispatch/` fails, or tsc reports new errors in `packages/dispatch` | Tests pass but a pre-existing behaviour (Max parallel slots, external engines, resume) silently changed | The full suite and typecheck are clean, and existing behaviour is preserved outside the planned changes |
| Leanness | ×1 | Abstractions with one caller, options nobody sets, or a hand-rolled version of a git primitive | Some avoidable indirection | Minimal additions; obsolete code deleted |

## Out of scope

- A version bump or `CHANGELOG.md` entry. Deferred because releases go through `/chronicle:release` separately.
- Porting worktree isolation to the OpenCode hand-driven loop. Deferred because that loop has no parallel waves.
