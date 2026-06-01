# Task File Template

Each task file is `docs/<topic>/tasks/<bucket>/NN-<slug>.md`. NN is two-digit zero-padded.

**The non-negotiable property**: an executor who opens this file and the `_context/` files it lists can finish the task without opening PLAN.md or any other task file.

## Template

```markdown
# <BUCKET>-NN: <Short Title>

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/<other>.md`  ← only what's actually needed
>
> **Depends on**: <bucket>/NN, <bucket>/NN  (or "none — foundation task")
> **Blocks**: <bucket>/NN  (optional — useful for parallel planning)
> **Status**: todo | in-progress | done | blocked
> **Final review**: true  (ONLY on the one closing review task — omit on every other task)

## Goal

<One sentence. The outcome a user / system / reader gets after this task is done.>

## Files to create / modify

- `path/to/file.ext` (new) — <one-line purpose>
- `path/to/other.ext` (modify) — <what changes>

## Implementation notes

<Everything an executor needs that isn't already in `_context/`. Inline signatures, schemas, sample data, key decisions specific to this task.>

### <Sub-heading per area>

<Specific guidance, code snippets, type signatures, edge-case behavior.>

```ts
// Inline real signatures rather than referring to a file
export function foo(bar: Bar): Baz
```

## Acceptance criteria

- [ ] <Verifiable claim 1>
- [ ] <Verifiable claim 2>
- [ ] <Verifiable claim 3>

## Verification

- [ ] <Concrete command, manual step, or test the executor runs>
- [ ] <Concrete command, manual step, or test the executor runs>

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | <wrong result / doesn't match spec> | <happy path works but edge cases drift> | <fully matches, edge cases handled> |
| Test coverage | ×2 | <no tests> | <happy path only> | <covers edges + failure paths> |
| Interface & readability | ×1 | <smuggles I/O / messy naming> | <usable but types unclear> | <pure function, clear types, easy to compose> |
| Assumptions & docs | ×1 | <unmarked magic numbers> | <assumptions made, not explained> | <assumptions flagged TODO, sources clear> |

## Out of scope

<Optional. List things tempting to include but explicitly deferred. Inline the deferral reason — do not point at PLAN.md or other task files.>

- <Tempting thing> — Deferred. Reason: <one-line summary the executor needs to know>.
- <Tempting thing> — Deferred to a follow-up task in the same bucket.
```

## Header rules

### `Required reading`

- List only files the executor actually needs. Don't include `_context/` files that aren't relevant to this task.
- Use relative paths (`../_context/shared.md`), not absolute.
- The bullet under the header phrase "do not need to open other files" is the contract: never list other task files or PLAN.md here.

### `Depends on`

- Use the form `<bucket>/NN` — same shorthand as the task index.
- For foundation tasks with no deps, write `none — foundation task`.
- If a dependency is cross-bucket, that's fine — make it explicit.

### `Status`

- `todo` — not started
- `in-progress` — someone is actively working on it
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

Status is mutated in-place. Sub-agents update this when they pick up or finish a task.

### `Final review` (the closing gate — exactly one per plan)

Every plan ends with **one terminal task that reviews the whole deliverable**. Mark it `> **Final review**: true`, and make its `Depends on` reach every other task (directly or transitively) so it cannot start until all the work is done. `lint-task.ts` enforces both: a plan with no marked task, or a marked task that misses some branch, fails the whole-tree lint.

This is the holistic gate — per-task rubrics catch per-task quality; the final review catches integration, consistency, regressions, and whether the plan's overall goal was actually met. Its `## Eval rubric` should score *those* axes (e.g. **Integration / does it compose**, **Meets the PLAN goal**, **Consistency**, **No regressions**), not re-score individual tasks.

A plan with a single task is exempt (it's its own terminal). Don't mark more than one task — keep one unambiguous closing gate.

### `Eval rubric` (required, machine-parseable)

Every task must carry an `## Eval rubric`. Acceptance criteria is the **binary gate** (pass/fail); the rubric is the **graded quality score** on top of it — what a judge agent (or you) uses to decide "good enough", and what a workflow loops against until it passes.

`lint-task.ts` enforces a parseable shape; `score-task.ts` consumes it. The contract is **operator-anchored**, so it works in any language:

- **Threshold line** — a `>`-quoted line carrying the pass operator + number. `> 4.0` / `≥ 4` / `>= 4` all parse. State the scale (`0–5`) on the same line so the linter can range-check the threshold.
- **Hard-fail veto (optional)** — `<dimension> < N` (`<` or `≤`) anywhere on the threshold line, e.g. `Correctness < 4 is an automatic veto`. The named dimension must match a row in the table.
- **Dimension table** — header must include a `Weight` column; each row's weight is written `×N`. Rows without a positive weight (or the `|---|` separator) are ignored.

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–scaleMax scale. A task passes when the average meets the threshold **and** no veto fires. Customize the anchors per task; keep the threshold line + weighted table shape.

## Self-containment checklist

Before finalizing a task file, verify each:

- [ ] All function signatures, schemas, or interfaces the executor will write are inline.
- [ ] Sample inputs / outputs are inline if behavior is non-obvious.
- [ ] File paths are absolute from project root (no "in the auth folder" hand-waving).
- [ ] Every acceptance criterion is verifiable (no "looks good").
- [ ] Verification steps are concrete commands or manual checks, not vague QA notes.
- [ ] `## Eval rubric` is present with a threshold line + weighted dimension table, anchors filled in for this task (not the template placeholders).
- [ ] Nothing in this file requires opening PLAN.md or another task file to understand.
- [ ] If duplication with `_context/` is needed for clarity, duplicate — don't make the executor cross-reference.

## Sizing

Aim for 1 task = 1 commit or 1 PR. Concretely:

- A task that lists more than ~8 acceptance criteria probably wants splitting.
- A task touching more than ~6 files probably wants splitting.
- A task that says "and also..." in the goal is two tasks.

## Naming

`<bucket>/NN-<kebab-slug>.md`

- `<bucket>` matches a directory under `tasks/`. Must be a single kebab token (no internal dashes that resemble `NN`).
- `NN` is two-digit, zero-padded, locally sequential within the bucket (`01`, `02`, … `19`, `20`, …).
- `<kebab-slug>` is 3–6 words, lowercase, hyphen-separated, describing the task outcome.

## H1 shape (strict)

The H1 line must be `# BUCKET-NN: Title` where `BUCKET` is all-caps single token (`UI`, `BACKEND`, `API`, `WORK`), `NN` is two-digit zero-padded, separated by a single dash. The `lint-task.ts` and `build-readme.ts` scripts parse this exact shape — deviations will fail validation.

Examples:

- `ui/01-fixture-shell.md`
- `backend/03-course-serializer-with-sections.md`
- `api/04-server-proxy-askr-passthrough.md`
