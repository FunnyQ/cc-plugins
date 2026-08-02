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

<Everything an executor needs that isn't already in `_context/`. Inline signatures, schemas, sample data, key decisions specific to this task. Refer to the *thing* (the API client, the user schema), never another task id — `frontend/01`-style refs fail the linter.>

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
- The bullet phrase "do not need to open other files" is the contract. Never list another task file or PLAN.md here.

### `Depends on`

- Use the form `<bucket>/NN` — same shorthand as the task index.
- For foundation tasks with no deps, write `none — foundation task`.
- If a dependency is cross-bucket, that is fine. Make it explicit.

### `Status`

- `todo` — not started
- `in-progress` — someone is actively working on it
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

Status is mutated in-place. Sub-agents update this when they pick up or finish a task.

**Write the value bare.** The line must read exactly `> **Status**: <value>`, where `<value>` is one of the four words above and nothing else follows it. `parseTask()`, `lint-task.ts`, `next-ready.ts`, and `mark-done.ts` all read this one rule, and a decorated value is not a status — it is an unparseable task that fails lint and stalls readiness.

- ❌ `> **Status**: in-progress (attempt 3)`
- ❌ `> **Status**: done — pending review`
- ✅ `> **Status**: in-progress`

Put run notes on their own line, outside the Status line.

**`done` also means every gate box is ticked.** A task is validly complete only when its Status is `done` **and** every checkbox in `## Acceptance criteria` and `## Verification` is `[x]`. `Status: done` with an unticked gate box is a malformed completion state: lint reports it, readiness refuses to unlock dependents, and the dashboard counts it as invalid. Do not repair it by hand-ticking the boxes. Reset Status to `in-progress` or `todo` and rerun the gates. `mark-done.ts` writes both halves in one step, so the two never drift when the pipeline does the work.

### `Final review` (the closing gate, exactly one per plan)

Every plan ends with **one terminal task that reviews the whole deliverable**. Mark it `> **Final review**: true`. Make its `Depends on` reach every other task, directly or transitively. Then it cannot start until all the work is done. `lint-task.ts` enforces both rules. If no task is marked, or a marked task misses some branch, the whole-tree lint fails.

This is the holistic gate. Per-task rubrics catch per-task quality. The final review catches integration, consistency, regressions, and whether the plan's overall goal was actually met. Its `## Eval rubric` should score *those* axes, for example **Integration / does it compose**, **Meets the PLAN goal**, **Consistency**, and **No regressions**. It does not re-score individual tasks.

A plan with a single task is exempt. That task is its own terminal. Don't mark more than one task. Keep one unambiguous closing gate.

If any task in the tree runs a test suite, the closing review task's `## Verification` must run one too. This requirement belongs on the closing task because it is the last writer: it applies edits after every other task has run, and only its own `## Verification` gates those edits. Recognized runners are `bun test`, `npm test` / `pnpm test` / `yarn test`, `cargo test`, `go test`, `rspec`, `make test`, and `pytest`. A docs-only tree that runs no tests anywhere needs nothing and triggers nothing. The linter enforces presence, not reach, so a narrow test path satisfies the rule; read the advisory report to judge whether the suite is broad enough.

### `Eval rubric` (required, machine-parseable)

Every task must carry an `## Eval rubric`. Acceptance criteria is the **binary gate** (pass or fail). The rubric is the **graded quality score** on top of that gate. A judge agent, or you, uses the rubric to decide "good enough". A workflow loops against the rubric until the task passes.

`lint-task.ts` enforces a parseable shape. `score-task.ts` consumes that shape. The contract is **operator-anchored**, so it works in any language:

- **Threshold line**: a `>`-quoted line that carries the pass operator and a number. `> 4.0`, `≥ 4`, and `>= 4` all parse. State the scale (`0–5`) on the same line. This lets the linter range-check the threshold.
- **Hard-fail veto** (optional): write `<dimension> < N`, using `<` or `≤`, anywhere on the threshold line. For example: `Correctness < 4 is an automatic veto`. The named dimension must match a row in the table.
- **Dimension table**: the header must include a `Weight` column. Each row's weight is written `×N`. Rows without a positive weight, or the `|---|` separator row, are ignored.

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–scaleMax scale. A task passes when the average meets the threshold **and** no veto fires. Customize the anchors for each task. Keep the threshold line and the weighted table shape.

## Referring to other tasks: name the thing, not the id

The most common lint failure is this: writing a sibling task id, such as `frontend/01`, into the body out of habit. This happens because you just used the id in `Depends on`. Don't do it. The dependency graph lives in the header. The body must never make the executor open another task.

- ❌ `Built on the client from frontend/01.`
- ✅ ``Built on the API client (`apiFetch(path): Promise<Res>` — signature below).``
- ❌ `See ui/02 for the validation rules.`
- ✅ Inline the rules here, or put them in `../_context/validation.md` and list that file in Required reading.

`lint-task.ts` rejects any `bucket/NN`, `bucket/NN-slug`, or `bucket/NN-slug.md` reference in the body. Your own file is excluded. If it's a real dependency, capture it in `Depends on`, not in prose.

## Self-containment checklist

Before finalizing a task file, verify each:

- [ ] All function signatures, schemas, or interfaces the executor will write are inline.
- [ ] If behavior is non-obvious, sample inputs and outputs are inline.
- [ ] File paths are absolute from project root (no "in the auth folder" hand-waving).
- [ ] Every acceptance criterion is verifiable (no "looks good").
- [ ] Verification steps are concrete commands or manual checks, not vague QA notes.
- [ ] Every `git status` gate carries a `--` pathspec and claims nothing about other paths. See "Always narrow a `git status` gate to a pathspec" below.
- [ ] `## Eval rubric` is present with a threshold line and weighted dimension table, anchors filled in for this task (not the template placeholders).
- [ ] Nothing in this file requires opening PLAN.md or another task file to understand.
- [ ] If duplication with `_context/` is needed for clarity, duplicate it. Don't make the executor cross-reference.

## Always narrow a `git status` gate to a pathspec

A gate that reads `git status` without a `--` pathspec reads the **whole working tree**, and no task owns that tree. Write the pathspec:

- ❌ `` Run `git status --short` — expect `README.md` as the only modified path. ``
- ❌ `` `git status --short` shows nothing else modified. ``
- ❌ `` Run `git status --short` and quote it. Expect `README.md`, plus at most this task file. Any OTHER path is a real scope violation. ``
- ✅ `` Run `git status --short -- README.md docs/<slug>/tasks/<bucket>/NN-<slug>.md` and confirm both paths are dirty. ``

Two separate failures made every whole-tree form unusable.

**The runner edits the task file.** The dev step sets `Status: in-progress`, and `mark-done.ts` ticks every `## Acceptance criteria` and `## Verification` box. So an exclusivity claim is false from the first attempt. Worse, a dev agent under a failing gate reverts the runner's own `Status` edit to make the check pass — observed live, with the agent reporting "task file correctly restored". A reverted `Status` un-schedules the task: `next-ready.ts` only offers `todo`, and `mark-done.ts` validates the header before it writes.

**Sibling tasks share the tree.** Autopilot dispatches every ready task of a wave in parallel into one working tree, and forbids each of them to commit. So a correct task sees its siblings' correct, uncommitted edits in `git status` and reports them as its own violation. Observed live: a task passed all 7 acceptance criteria and 245 tests, then failed three attempts and parked, on four paths that were the declared file list of a task running beside it. The exemption `plus at most this task file` only ever covered the runner's self-edits; it never covered siblings.

You cannot recover the missing information by rewording. In a shared tree a dirty path looks identical whether your task dirtied it or a sibling did.

**What the pathspec form buys, and what it doesn't.** It asserts your own declared paths changed, which still catches a dev engine that implemented nothing. It cannot detect edits outside your declared list — treat that as a weak signal, not a scope gate, and let the acceptance criteria and tests carry correctness.

`lint-task.ts` enforces this as the `scope-git-status` rule: a `git status` in `## Acceptance criteria` or `## Verification` with no `--` pathspec fails, and a pathspec-limited one still fails if it claims exclusivity. Option flags such as `--short` and `--porcelain` do not count as a pathspec.

## Sizing

Aim for 1 task = 1 commit or 1 PR. Concretely:

- A task that lists more than ~8 acceptance criteria probably wants splitting.
- A task touching more than ~6 files probably wants splitting.
- A task that says "and also..." in the goal is two tasks.

## Naming

`<bucket>/NN-<kebab-slug>.md`

- `<bucket>` matches a directory under `tasks/`. It must be a single kebab token, with no internal dashes that resemble `NN`.
- `NN` is two-digit, zero-padded, locally sequential within the bucket (`01`, `02`, … `19`, `20`, …).
- `<kebab-slug>` is 3–6 words, lowercase, hyphen-separated, describing the task outcome.

## H1 shape (strict)

The H1 line must be `# BUCKET-NN: Title`. `BUCKET` is an all-caps single token, for example `UI`, `BACKEND`, `API`, or `WORK`. `NN` is two-digit zero-padded. A single dash separates `BUCKET` from `NN`. The `lint-task.ts` and `build-readme.ts` scripts parse this exact shape. A deviation fails validation.

Examples:

- `ui/01-fixture-shell.md`
- `backend/03-course-serializer-with-sections.md`
- `api/04-server-proxy-askr-passthrough.md`
