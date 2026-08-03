# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

This repo is `q-lab-marketplace`, a Claude Code / Codex plugin marketplace. The work in this
plan is entirely inside the **`dispatch`** plugin's **`autopilot`** skill, which executes a
flightplan task tree end-to-end: for each task it runs a dev → verify → judge → score loop,
then a closing multi-lens final review.

Autopilot dispatches every ready task of a wave **in parallel into one shared working tree**,
and forbids each of them to commit. That one fact is the source of the problem this plan fixes:
a verifier running whole-suite commands sees a sibling task's half-written files.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Tests are `bun test`.
- **The orchestrator itself**: plain **JavaScript**, not TypeScript — it lives as a fenced
  ` ```javascript ` block inside a markdown reference file and is passed to the `Workflow` tool
  as source. Type annotations there are a syntax error.
- **Dashboard**: hand-written browser ES modules under `dashboard/dist/`. There is **no build
  step and no source tree** — `dist/` is the real source, and it is tested directly with
  `bun test`.
- **No external npm dependencies.** Vendor libraries are committed.

## Code style

- Use `type` over `interface` in TypeScript.
- **Comment why, never what.** The orchestrator file's existing comments are unusually dense
  and explain the reasoning behind non-obvious choices, often naming the live run where a
  failure was observed. Match that register when you add one; do not narrate mechanics.
- Change only the lines the task requires. Do not reformat, reorder, or "tidy" neighbouring
  code — several files in this plan are edited by more than one task in sequence, and gratuitous
  reflow turns a later task's small edit into a conflict.
- Follow the surrounding code's idiom rather than importing a new pattern.

## File / directory layout

Paths below are from the repo root.

- `packages/dispatch/skills/autopilot/references/orchestrator.md` — the canonical Workflow
  script. Its single ` ```javascript ` fence **is** the program.
- `packages/dispatch/skills/autopilot/scripts/` — the Bun/TypeScript tooling and its tests,
  including `fleet.ts` (flightlog → dashboard rows) and `orchestrator-script.test.ts` (the
  deterministic fixture that extracts and runs the fence).
- `packages/dispatch/skills/autopilot/dashboard/dist/` — `modules/fleet.js`, `style.css`, and
  their `bun test` suites.
- `packages/dispatch/skills/flightplan/scripts/` — shared task tooling the orchestrator shells
  out to: `next-ready.ts`, `mark-done.ts`, `score-task.ts`, `lint-task.ts`, `flightlog.ts`.

## Commit & branching style

- This repo runs **GitHub Flow**: `main` is the only long-lived branch.
- **Do not commit.** Autopilot's own commit agents commit each wave; a task that commits itself
  splits the wave's atomic history and can sweep a parallel task's half-finished edits into its
  commit. Leave every change unstaged.
- Never run `git checkout`, `git restore`, `git reset` or `git clean`. Tasks run in parallel in
  one shared tree, so restoring any path to its HEAD version destroys a sibling's finished work.
  If your own edit went wrong, fix it forward by editing the file.

## Verification baseline

- **Full suite**: `bun test packages/dispatch/skills/autopilot/scripts/` — **198 pass, 0 fail,
  10 files** before any task in this plan runs. Every task must leave it green.
- **Dashboard suite**: `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/`
- The orchestrator script is a doc, not an importable module, so there is no `import` to
  typecheck. Its correctness gate is `orchestrator-script.test.ts`, which reads the markdown,
  extracts the fence, and runs it with stubbed `agent` / `parallel` / `log` / `phase`.

## Decisions frozen during interview

- **Scope the ban by tool access, not by role.** Every Workflow agent holds Bash, so every
  prompt whose agent could plausibly run git gets the restore-family ban — not only the three
  that write source.
- **A verifier may postpone a verdict; it may never waive one.** A non-zero exit is always a
  failure. Deferral re-runs the same commands later; it never reclassifies a red result as a
  pass. This is a direct response to a live run where a verifier reported `PASS` over two
  failing tests by attributing them to a sibling on its own initiative.
- **Quiet means "no writer right now", detected as a zero-crossing of a live count** — not a
  one-shot barrier. A task that fails its gate retries dev and writes again, so "all first devs
  returned" is not a stable notion of quiet.
- **A deferral must be evidenced by a live sibling writer.** Without that, a verifier whose
  siblings have all finished wins a free re-run of a red command, and a flaky failure passes on
  the second roll. That would be weaker than simply failing.
- **The defer state never escapes a task.** The task pipeline still returns pass/fail, so wave
  reconciliation, the held-back path list, the commit agents and the divergence detector are
  all untouched.
- **The rubric judge is not a tree writer.** Its scorer only reads the task file and appends to
  the self-gitignored flightlog directory, so it is deliberately not counted as a writer.
