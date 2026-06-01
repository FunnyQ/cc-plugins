# Changelog

All notable changes to the **dispatch** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-01

### Added

- **flightplan: every task now carries a mandatory `## Eval rubric`.** Acceptance
  criteria stays the binary gate; the rubric is the graded quality score on top of
  it — dimensions, weights, a weighted-average pass line, and an optional hard-fail
  veto. This is the bar a judge agent or a workflow loops a task against.
- `score-task.ts` — feed `{ dimension: score }` JSON and get a deterministic
  weighted-average + hard-fail verdict against the task's own rubric. Exports a pure
  `scoreTask(rubric, scores)` for the executor side.
- `parse-task.ts` — `ParsedTask` gains a `rubric` field, parsed from the
  `## Eval rubric` section. The contract is operator-anchored (`>` / `≥` pass line,
  `<dim> < N` veto, `×N` weighted table), so it works in any language with no YAML
  dependency.
- `build-readme.ts` — the generated task index gains a **Pass 線** column showing
  each task's rubric pass threshold.
- **flightplan: every plan must end with one final review task.** A terminal task
  marked `> **Final review**: true` whose `Depends on` transitively reaches every
  other task — the holistic closing gate (integration, meets-goal, consistency,
  regressions) on top of the per-task rubrics. `parse-task.ts` reads the marker;
  `lint-task.ts` enforces marker + full coverage as a whole-tree check (single-task
  plans exempt). The per-file write hook is unaffected.

### Changed

- **`lint-task.ts` is now strict about rubrics (breaking for task content).** A task
  missing `## Eval rubric`, carrying an unparseable one, or setting a pass threshold
  outside the scale now fails the linter — and the `flightplan-lint.sh` PostToolUse
  hook flags it on write. Pre-existing flightplan task trees must add a rubric to pass.
  Verified compatible against the urban-renewal-proposer 15-task tree (already
  rubric-shaped), which lints clean.

## [0.1.0] - 2026-06-01

### Added

- Initial release. Two interview-driven planning skills migrated from the odin
  plugin and renamed:
  - **preflight** (← `probe`) — lightweight interviewer that writes a single
    in-conversation plan to approve and execute.
  - **flightplan** (← `probe-deep`) — heavyweight interviewer that commits a
    multi-file blueprint to disk (`PLAN.md` + a `tasks/` tree with shared `_context/`
    files) for a different session or sub-agent to execute.
- `flightplan-lint.sh` PostToolUse hook + the bundled `scaffold` / `lint-task` /
  `build-readme` / `next-ready` scripts.
