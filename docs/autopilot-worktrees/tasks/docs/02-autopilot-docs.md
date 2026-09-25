# DOCS-02: Autopilot docs for worktrees, models, and cleanup

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/models.md`
> - `../_context/worktree.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/06
> **Blocks**: review/01
> **Status**: done

## Goal

A reader of autopilot's user-facing docs learns that each non-final task runs in its own worktree, which role runs on which model and effort, how park and resume work with a kept worktree, and that a clean run leaves only the main tree behind.

## Files to create / modify

- `packages/dispatch/skills/autopilot/SKILL.md` (modify): the wave description and pipeline diagram, the `[serial-undeclared]` guidance, the Step 2 brief, the Model policy table, the park and resume paragraphs, and a new Cleanup subsection.
- `packages/dispatch/skills/autopilot/references/opencode.md` (modify): a short shared-tree note.
- `packages/dispatch/skills/deckplan/references/authoring.md` (modify): in rule 7's label list, add `reverify:<ref>#<attempt>` beside `verify` and `judge`. Keep `requalify:`, because `fleet.ts` still parses it for flightlogs from past runs.
- `CLAUDE.md` at the repo root (modify): the dispatch plugin summary bullet and the Architecture tree comment under `flightplan/scripts/`.

## Implementation notes

The shipped orchestrator (`packages/dispatch/skills/autopilot/references/orchestrator.md`) and `../_context/worktree.md` are the source of truth. Describe what they do; invent nothing. If the shipped orchestrator disagrees with `_context/`, do not document either version. Fail this task's Verification with the disagreement named (file, behaviour, the `_context/` rule), so the run parks it and a person fixes the upstream code first.

Doc style for every edit:
- Write one instruction per sentence.
- Start each instruction with a verb.
- Put the condition before the instruction.
- Use one term per thing: say "worktree" for the per-task tree and "main tree" for the repo checkout. Never mix in "sandbox", "clone", or "copy".

### SKILL.md — "How orchestration works" and Step 3's wave description

- Section `## Step 3 — Call Workflow with the wave-loop orchestrator` has a paragraph starting "The orchestrator runs a **wave loop**". State there that each non-final task runs its whole pipeline (dev, verify, judge) in its own git worktree at `<repo-parent>/.<repo-name>-autopilot/<slug>/<bucket>-<NN>`. State that the Final review task (`> **Final review**: true`) runs in the main tree.
- Update the ASCII pipeline diagram under that paragraph:
  - Replace `Dev (Sonnet)` with the dev role's default from `models.md` (opus / medium, and opus / high on the last Claude rung).
  - Replace `Binary gate (Haiku)` with opus / low.
  - Replace `Rubric judge (Opus)` with opus / medium.
  - Add `create worktree` before dev.
  - Add a `land (main-tree lock)` step between the score gate pass and `done → mark-done.ts`.
  - Add `remove worktree` after mark-done.
- Add a short paragraph on land outcomes, one sentence each:
  - Clean: the merged result lands in the main tree.
  - Conflict: the worktree is rebased with conflict markers, and the attempt counts as failed.
  - Drift: when something else landed since this task started, the task's Verification re-runs in the main tree as `reverify:<ref>#<attempt>`. If it fails, the land is undone, the worktree is rebased, and the attempt counts as failed. That failure supersedes the judge's passing score for the attempt.
  - Leak: when the main tree changed outside a land, the run aborts. Every task stops before its next slot, attempt, or land. No inter-wave commit runs, the end sweep is skipped, and the run lists the leaked paths, every worktree still in the `live` map, and every still-blocked leftover the start sweep kept. Nothing is reverted. A task whose land was clean before the abort still finishes mark-done and `remove`, because its work is already in the main tree; the abort keeps only worktrees with unlanded work.
- Add one sentence on the lock: one main-tree lock covers every `worktree.ts` call and the drift re-verify, including the snapshot a new worktree starts from, so no worktree starts from a half-applied land and no two calls rewrite `state.json` at once.
- Add one sentence on retries: every `worktree.ts` call is safe to repeat, because `land`, `unland`, and `rebase` take an `--op <id>` built from the attempt and step (`a<attempt>-land`, `a<attempt>-unland`, `a<attempt>-rebase`), record their result under it, and return it on a repeat with the same id. The orchestrator retries a missing structured result once: its `resilient(...)` wrapper retries only on a throw, so each `worktree.ts` call and `reverify` is made through a wrapper that throws on a `null` result. A second `null` is an infrastructure failure for the task.
- Add one sentence on the worktree prompt rule: an agent writes every source file under its worktree, and only three writes are exempt — `flightlog.ts log` into the main-tree flightlog, the task file's Status line, and the judge's scratch files under `/tmp`.
- Change the wave-loop sentence "at most `maxParallel` at a time" to add that the `Max parallel` slot covers the whole pipeline, land included.

### SKILL.md — `[serial-undeclared]` guidance and the brief

- Step 1 has the paragraph starting "**Act on a `[serial-undeclared]` advisory before flying.**". Rewrite it so that, under Claude Code, `> **Max parallel**: 1` is for an external live resource a worktree cannot isolate: a device, a LaunchAgent or service a verification reinstalls, a local database. Say explicitly that a shared build target is no reason under Claude Code, because each task builds in its own worktree. Add that under OpenCode's hand-driven loop tasks share one tree, so a shared build target still needs `> **Max parallel**: 1` there. Use the same wording as the flightplan `plan-template.md` paragraph.
- Step 2's brief paragraph starts "Then show the user a one-screen brief". Add these two sentences to it:
  - State that non-final tasks run in isolated worktrees and where they live.
  - State the per-role model map, and name any task whose `> **Models**:` header overrides it.

### SKILL.md — Model policy table

- Section `## Model policy` holds the table. Make every row match `../_context/models.md`: model plus effort per role, and scout, mark-done, park, and the external-dev driver on haiku.
- Add one sentence saying a task's `> **Models**:` header overrides dev, verify, judge, and fix. Say that the last Claude dev rung raises the effort one step.
- Edit only the rows that differ. If an earlier change already brought a row in line, leave it alone.
- Keep the "Why" column's reasoning where it still holds.
- Rewrite the dev row's "Why". Escalation now raises effort on the same model instead of switching Sonnet to Opus.

### SKILL.md — Escalation, park, and resume

- Delete the paragraph starting "**A parked task's source edits are uncommitted.**" in `## Escalation — park & continue, then resume`. It describes the removed held-back commit logic. Replace it with a paragraph that says:
  - A parked task's work is not in the main tree. It stays in the task's kept worktree, and the escalation's `reason` carries that worktree's path.
  - To inspect or hand-fix a parked task, work inside that worktree.
  - `--task <ref> --from verify|judge` looks the kept worktree up and runs there. If the worktree is gone, it halts with a message naming the missing path.
  - A resume takes its own main-tree baseline at start, so its land has a valid leak check.
  - When a drift re-verify failed after a passing judge, the resume point is `dev` on the next attempt, not `verify` or `judge`.
  - A resume from `dev` looks the worktree up first and reuses it when it exists, because it may hold unlanded work, for example after a failed drift re-verify. It creates a fresh worktree from the current main tree only when none exists.
  - The run that finally passes the task is the one that lands its work.
- Update the "Re-enter at a step" bullet: "the work below that step already landed and is on disk" must now say the work is in the kept worktree.
- In `## Resume one task at a chosen step`, amend the sentence "a task parked with its expensive work already correct and on disk" to say the work is in the kept worktree. The Final review is the exception: it runs in the main tree.

### SKILL.md — new Cleanup subsection

Add `### Worktree cleanup` inside `## Escalation — park & continue, then resume`, after the resume bullets. List these as rules:

1. At run start, the orchestrator sweeps the slug's worktree root. It deliberately removes this slug's leftovers from a previous run, except those whose task `Status` is `blocked`.
2. After each clean land, it removes that task's worktree.
3. At run end, it sweeps again. It keeps the worktree of every task still in the `live` map, such as a parked task, plus every worktree the start sweep kept whose task `Status` is still `blocked`. A blocked task this run never touched keeps its worktree.
4. If the run aborted on a leak, it skips the end sweep and keeps every worktree with unlanded work for inspection. A task that landed cleanly before the abort still removes its worktree.
5. The run result lists every kept worktree path, clean end or abort alike. The list is the orchestrator's `live` map (set on create or resume, cleared on remove), plus each `{ref, path}` the start sweep kept whose task `Status` is still `blocked`. The run never reads the kept list from the end sweep. Report each path to the user.
6. After a clean run, no worktree for the slug remains, so `git worktree list` shows no path under `.<repo-name>-autopilot/<slug>/`.
7. Every sweep touches only paths under the slug's worktree root, `<repo-parent>/.<repo-name>-autopilot/<slug>/`. Worktrees outside that root are never touched.
8. If the first scout fails, the run sweeps nothing and lists every worktree under the root instead. If a later scout fails, the end sweep is skipped.
9. A landed task whose worktree removal could not be confirmed is listed in the run result's `cleanupFailures`, not in the kept list. The task still counts as completed, but the run is not clean. Report each path so the user can delete it.
10. To discard a kept worktree by hand, run `git worktree remove --force <path>`, then `git worktree prune`.

### opencode.md

Add a short note (two to four sentences) under `## The wave loop` in `packages/dispatch/skills/autopilot/references/opencode.md`. It says:
- The OpenCode hand-driven loop keeps one shared working tree.
- Worktree isolation, the main-tree lock, drift re-verify, and the leak abort do not apply.
- A plan with a whole-target build therefore still needs `> **Max parallel**: 1` under OpenCode.
- The per-role model map is Claude Code only.
- Use the same wording as the flightplan `plan-template.md` paragraph for the shared-build-target cap.

### CLAUDE.md (repo root)

- The dispatch bullet under `### Plugin summaries` starts "**dispatch** — a ladder". Append one clause: autopilot runs each non-final task in its own git worktree, managed by `flightplan/scripts/worktree.ts`, and lands it under a mutex, and every pipeline role runs on an explicit model and effort map that a task's `> **Models**:` header can override.
- The `## Architecture` tree has the comment block starting `# flightplan/scripts/ also hosts autopilot's shared tools:`. Add `worktree` to the listed tools (`next-ready / score-task (--log) / flightlog / worktree`).

## Acceptance criteria

- [x] `rg -n "held back|heldBack" packages/dispatch/skills/autopilot/SKILL.md` prints nothing.
- [x] `rg -n "git worktree list" packages/dispatch/skills/autopilot/SKILL.md` hits the cleanup rule that a clean run leaves no worktree for the slug.
- [x] `rg -n "Worktree cleanup" packages/dispatch/skills/autopilot/SKILL.md` hits the new subsection.
- [x] `rg -n "Models\*\*:" packages/dispatch/skills/autopilot/SKILL.md` hits the override sentence in the Model policy section.
- [x] Every row of the SKILL.md Model policy table names the same model and effort as `../_context/models.md`.
- [x] `rg -n "Sonnet" packages/dispatch/skills/autopilot/SKILL.md` shows no dev-role default of Sonnet. Sonnet may appear only as a user-chosen or task-override option.
- [x] `rg -n "shared working tree" packages/dispatch/skills/autopilot/references/opencode.md` hits the new note.
- [x] `rg -n "worktree" CLAUDE.md` hits both the dispatch summary bullet and the Architecture tree comment, and `rg -n "worktree\.ts" CLAUDE.md` hits the summary bullet.
- [x] Autopilot `SKILL.md` covers each item the plan requires of it, one per `rg` hit: the model table (`rg -n "opus / medium"`), isolation (`rg -n "own git worktree"`), the abort (`rg -n "abort"`), resume in a kept worktree (`rg -n "kept worktree"`), and the cleanup rule (`rg -n "Worktree cleanup"`).
- [x] `rg -n "reverify:" packages/dispatch/skills/deckplan/references/authoring.md` hits rule 7's label list, and `rg -n "requalify:" packages/dispatch/skills/deckplan/references/authoring.md` still hits.

## Verification

- [x] Run `rg -n "held back|heldBack" packages/dispatch/skills/autopilot/SKILL.md` and confirm it prints nothing.
- [x] Run `rg -n "worktree" packages/dispatch/skills/autopilot/SKILL.md` and confirm the hits include the Cleanup subsection and the park paragraph.
- [x] Run `rg -n "shared working tree" packages/dispatch/skills/autopilot/references/opencode.md` and confirm one hit.
- [x] Run `rg -n "worktree" CLAUDE.md` and confirm the dispatch bullet and the tree comment both hit.
- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` and confirm it passes. Some tests read the docs, so a broken anchor fails here.
- [x] Run `rg -n "reverify:" packages/dispatch/skills/deckplan/references/authoring.md` and confirm one hit in rule 7.
- [x] Run `git status --short -- packages/dispatch/skills/autopilot/SKILL.md packages/dispatch/skills/autopilot/references/opencode.md packages/dispatch/skills/deckplan/references/authoring.md CLAUDE.md` and confirm all four paths are modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Docs describe held-back commits, describe the Claude Code orchestrator as running tasks in a shared tree (the OpenCode note saying its hand-driven loop shares one tree is required and correct), or give a Sonnet dev default; or they state behaviour the orchestrator does not have | Main flow right, but park/resume, drift, the leak abort, or cleanup is missing or wrong | Every described behaviour matches the shipped orchestrator and `_context/worktree.md`; model table matches `_context/models.md` |
| Consistency with _context and the shipped orchestrator | ×2 | Terms and numbers conflict across SKILL.md, opencode.md, authoring.md, and CLAUDE.md | Minor drift in one place, e.g. a path shape or role name | One term per thing across all four files; paths, labels, and rules identical to `_context/` |
| Clarity | ×1 | Rules buried in long paragraphs; conditions after instructions | Readable but mixes several instructions per sentence | One instruction per sentence, verb first, condition first; Cleanup is a scannable list |
| Scope | ×1 | Rewrites unrelated sections or edits files outside the four named | Small unrelated rewording | Only the named sections change; nothing else touched |

## Out of scope

- The design notes below the script in `orchestrator.md`. Deferred. Reason: the code changes that alter the orchestrator own those notes, so they stay next to the code they explain.
- `flightplan` docs (`plan-template.md`, `task-template.md`, flightplan `SKILL.md`, `interview-guide.md`). Deferred. Reason: a separate docs task in this bucket covers the planning side.
- `CHANGELOG.md` and version bumps. Deferred. Reason: `/chronicle:release` owns them.
