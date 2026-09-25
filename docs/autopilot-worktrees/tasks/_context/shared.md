# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`q-lab-marketplace` (`/Users/funnyq/Projects/q-lab/cc-plugins`) ships Claude Code / Codex plugins. This plan changes the **dispatch** plugin: `flightplan` writes a task tree to disk, and `autopilot` executes it through a Workflow script. Today every autopilot task shares one working tree, so plans for whole-target-build projects declare `> **Max parallel**: 1` and lose all parallelism. This plan gives each task its own git worktree (see `worktree.md`) and moves every pipeline role onto an explicit model + effort map a task can override (see `models.md`).

## Tech stack

- **Runtime**: Bun with TypeScript, no transpile step, no runtime npm dependencies.
- **Git**: 2.55 installed; `git merge-tree --write-tree` (needs ≥ 2.38) is allowed.
- **Platform**: macOS / APFS. `cp -c` (clonefile) is the copy primitive for seeding worktrees.

## Code style

- Use `type` over `interface`.
- Follow the surrounding file's idiom. Comments say why, one line. No indirection with one caller; no option nobody sets.
- Scripts under `flightplan/scripts/` export a tested pure function where they can and keep I/O in a thin `main`.
- The orchestrator is a **plain JavaScript** Workflow script inside the first ```` ```javascript ```` fence of `packages/dispatch/skills/autopilot/references/orchestrator.md`. No TypeScript syntax there, and no `Date.now()`, `Math.random()`, or argless `new Date()` (they throw in Workflow scripts).

## File / directory layout

- `packages/dispatch/skills/flightplan/scripts/` — `next-ready.ts`, `lint-task.ts`, `mark-done.ts`, `flightlog.ts`, and the new `worktree.ts`. Tests sit beside each script as `<name>.test.ts`.
- `packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts` — `parseTask()` reads a task file's header (`dependsOn`, `blocks`, `status`, `finalReview`, `rubric`, …). Test: `lib/parse-task.test.ts` if present, otherwise the parse cases in `lint-task.test.ts`.
- `packages/dispatch/skills/autopilot/references/orchestrator.md` — the canonical Workflow script plus design notes below it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` — extracts the script from `orchestrator.md` and runs it with a stub `agent()` routed by label prefix (`scout-wave-`, `commit-`, `verify:`, `requalify:`, `judge:`, `done:`, `block:`, `dev:` / `dev-`). Tests assert on returned `{completed, escalations, needsHuman}` and on the recorded labels, prompts, and options.
- `packages/dispatch/skills/autopilot/SKILL.md`, `packages/dispatch/skills/flightplan/SKILL.md`, `flightplan/references/{plan-template,task-template,interview-guide}.md` — user-facing docs.

## Commit & branching style

- Executors do **not** commit, stage, stash, restore, or check out. The run commits between waves.
- Commits land on `main` (GitHub Flow) through `chronicle:commit`, gitmoji + conventional type.
- No version bump and no `CHANGELOG.md` entry in this plan.

## Plan base commit

Commit this plan tree on its own, before autopilot runs. That commit is the plan's base: autopilot records it as `CFG.baseRef` (`git rev-parse HEAD` before the flight), and no work of this plan precedes it. An independent reviewer finds it with `git log --diff-filter=A --format=%H -- docs/autopilot-worktrees/PLAN.md | tail -1`. The whole diff of this plan's work is `git diff <base>..HEAD`, plus `git diff` for uncommitted tracked changes, plus every untracked file listed by `git ls-files --others --exclude-standard`, read in full.

## Verification baseline

- Run only the test files your task names: `bun test <path/to/file.test.ts>`. This plan itself runs on the current shared-tree autopilot, so a sibling's half-written test file must never be able to fail you.
- Typecheck: `bunx --bun tsc --noEmit 2>&1 | grep <path-you-touched>` must print nothing. The repo-wide run has pre-existing errors elsewhere; a clean grep is the bar, not a zero count. Never pass file names to `tsc` — that drops the root `tsconfig.json`.
- Verification commands are written relative to the repo root.

## Decisions frozen during interview

- **Isolation is always on** for non-final tasks under Claude Code. No opt-out flag.
- **`review/01` (the Final review task) runs in the main tree**, never in a worktree.
- **`Max parallel` stays**, narrowed to external live resources a worktree cannot isolate (a device, a LaunchAgent, a local DB). Its slot still spans the whole task pipeline, land included.
- **The OpenCode hand-driven loop (`autopilot/references/opencode.md`) keeps the shared tree.** Document the difference only.
- **Sibling-interference machinery is deleted in its own task**, after isolation lands — never in the same change (structure and behaviour change separately).
