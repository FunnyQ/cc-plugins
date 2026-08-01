# LINT-01: test-runner detection and the final-review regression-net rule

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/lint-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none
> **Status**: done

## Goal

`lint-task.ts` fails a plan tree whose tasks run a test suite but whose closing Final review task does
not, removing the case where the last edits of an execution run are gated by no test at all.

This is a **presence** guarantee and nothing more. A closing gate that runs one narrow test satisfies the
rule while covering little; that is accepted, because reach is not mechanically decidable from a command
string. Do not add a criterion here that implies coverage.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lint-task.ts` (modify) — add a test-command detector and
  a tree-level check, and wire the check into `main()`.
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — cover the rule's fire,
  silent, and scoped cases.

## Implementation notes

### Why this rule exists at all, and why it is conditional

Each task in a plan verifies only itself. Nothing re-runs another task's `## Verification`. Cross-task
coverage happens incidentally, because test commands are path-scoped — a late `bun test <dir>` sweeps up
earlier code for free. That incidental net is real but unreliable.

The case incidental coverage cannot reach is the **closing review's fixer**: it applies review findings
with Edit/Write *after* every other task has already finished and been verified. Its edits are gated only
by the closing task's own `## Verification`. With no test command there, the run's last code changes are
never tested, and no earlier task can help — they already ran.

So the rule is **conditional on the tree**: a tree that has proven it owns a test suite must run it at the
closing gate. A docs-only tree that never runs a test triggers nothing and stays silent. A blanket "must"
would be wrong, and was rejected.

Do **not** try to re-execute other tasks' verification items. Items are written as *a backticked command
plus a prose assertion* — `` `grep -c foo file` is ≥ 2 ``, `` `git status` shows X unmodified `` — where the
assertion lives in the prose and the exit code alone is meaningless (`grep -c` exits 0 on one match;
`git status` always exits 0). Mechanical re-execution would report **false greens**, which at a closing
gate is worse than no re-verification at all.

### The detector

Add near the other module-level regexes:

```ts
// Test-runner commands, matched at the head of a backticked span. The trailing
// boundary keeps `bun testify` and `make tested` from counting as a suite.
// It does NOT reject `pytest-cov`: `\b` matches between `t` and `-`, so a
// hyphen-suffixed runner still counts. Left as-is — the false positives are
// all plausible test invocations, and tightening it would reject `go test ./...`.
const TEST_RUNNER_REGEX =
  /^(bun test|(?:npm|pnpm|yarn) (?:run )?test|cargo test|pytest|go test|rspec|make test)\b/;
```

Then a small exported helper:

```ts
/**
 * Backticked commands in a task's `## Verification` section that invoke a known
 * test runner. Returns the command strings as written, in document order.
 */
export function testCommandsIn(task: ParsedTask): string[]
```

Implementation shape:

1. `const section = extractSection(task.body, "Verification")` — **reuse the private `extractSection`
   already in this file**. Do not add a third section parser, and do not export
   `extractHeadingSection` from the parser module: it is private there, stricter, and widening it for
   one caller is the kind of layer this repo rejects.
2. **Reassemble complete checklist items first, then filter.** Walk the section's lines and start a new
   item on `/^\s*[-*]\s+\[[ x]\]\s/`; append any following line that is *not* itself a new bullet and
   is not blank to the item currently open. Text before the first item, and text after a blank line that
   is not a bullet, belongs to no item.

   Line-by-line filtering is wrong, and this tree's own task files prove it. Verification items wrap:

   ```markdown
   - [ ] `bun -e "JSON.parse(...)"`
         exits 0, and both `git diff --stat <base>..HEAD -- <paths>`
         and the same command without a revision range print nothing.
   ```

   Here the second and third backtick spans live on continuation lines. A per-line test drops them, so a
   task that genuinely runs a suite on a wrapped line reads as running none — under-detecting in exactly
   the direction that lets a closing gate with no net pass.
3. Keep only the reassembled items. This is the other half of the detector's correctness: a Verification
   section also contains prose, and a sentence such as "do not run `bun test` here, it is too slow" is not
   an executed suite. Counting it would both trigger the rule on a tree that owns no tests and satisfy the
   rule at a gate that runs nothing — wrong in both directions.
4. For each item, pull out every backtick-delimited span with a global `` /`([^`]+)`/g `` scan over the
   whole reassembled item. One item can carry several spans; collect all of them.
5. Trim each span and keep those matching `TEST_RUNNER_REGEX`.

Edge cases the tests must pin:

- A missing `## Verification` section yields `[]` — `extractSection` returns `""`, never throws.
- A test command mentioned only in **prose** inside the Verification section yields `[]`. Both the
  ticked (`- [x]`) and unticked (`- [ ]`) item forms count as executable.
- A command on an item's **continuation line** is found. A command in prose that follows a blank line
  after an item is not — the blank line closes the item.
- Only the `## Verification` section is scanned. A test command that appears only in
  `## Acceptance criteria` or `## Implementation notes` does not count. This is a deliberate narrowing:
  Verification is the section whose items are actually executed.
- Case-sensitive. Commands are written lowercase in this repo; a case-insensitive match would start
  catching prose.

### The tree-level check

Add beside `checkFinalReview`, with the same signature:

```ts
export function checkFinalReviewTestNet(
  tasks: ParsedTask[],
  label: string,
): Violation[]
```

Logic:

1. Partition on `task.finalReview`. Collect the tasks that carry at least one test command.
2. If **no** task in the tree has a test command → return `[]`. Silent.
3. Find the final-review-marked task. If none is marked, return `[]` — the missing marker is already
   reported by the existing final-review check, and emitting a second violation for one cause would
   report two problems where there is one.
4. If the marked task has at least one test command → return `[]`.
5. Otherwise return one violation with `file: label`, `rule: "final-review-test-net"`, and a `detail`
   that names the rule, the marked task's ref, and **the refs of the tasks whose suites it is missing**
   plus their commands. A bare "no test net" tells the planner nothing actionable.

Single-task trees: `checkFinalReview` exempts `tasks.length <= 1`. Mirror that exemption here — a lone
task is its own terminal and there is nothing to cross-cover.

### Wiring

Add the call inside the existing whole-tree branch of `main()`, immediately after the current
final-review check:

```ts
if (treeRoots.length > 0) {
  reportAll(checkFinalReview(parsed, treeRoots[0]));
  reportAll(checkFinalReviewTestNet(parsed, treeRoots[0]));
}
```

Placing it here is what scopes the rule to whole-tree mode. A cherry-picked file list is too partial to
judge a closing gate, and — importantly — an execution run's dev driver lints a **single file**
(`lint-task.ts <path>`), so a tree-level rule can never fail a task mid-run.

### Out of scope for this task

- The informational report of test-command path arguments. That is a separate, exit-code-neutral concern
  and is handled elsewhere in this plan.
- Any change to `references/task-template.md` or the flightplan `SKILL.md`.
- Any change to `parse-task.ts`.
- Judging test *reach*. Breadth is not mechanically decidable from a command string; this rule enforces
  presence only.

## Acceptance criteria

- [x] `testCommandsIn` is exported and returns the backticked test-runner commands from a task's
      `## Verification` section, in document order. Each of these twelve command forms has its own
      test — this list is authoritative, so do not infer the set from a count:
      `bun test`, `npm test`, `npm run test`, `pnpm test`, `pnpm run test`, `yarn test`,
      `yarn run test`, `cargo test`, `pytest`, `go test`, `rspec`, `make test`.
- [x] All three `<pm> run test` forms are covered, not only the bare `<pm> test` forms — the regex's
      optional `run ` group makes both valid, so testing one shape leaves the other unproven.
- [x] These near-misses have tests proving they do NOT match: `bun testify`, `make tested`, `rspecs`,
      and `npm testx` — each blocked by the trailing word boundary.
- [x] `testCommandsIn` returns `[]` for a task with no `## Verification` section, and for a task whose
      only test command appears outside that section.
- [x] `checkFinalReviewTestNet` is exported and returns exactly one violation, with rule
      `final-review-test-net`, when some task carries a test command and the final-review-marked task
      carries none.
- [x] That violation's `detail` names the rule, the final-review task's ref, and the refs plus commands
      of the tasks whose suites are missing from the closing gate.
- [x] A tree with no test command in any task produces no violation from this rule.
- [x] A non-final-review task with no test command never produces a violation from this rule, even when
      other tasks have one.
- [x] A tree with no final-review marker produces no violation from this rule (the missing marker is
      already reported once by the existing final-review check).
- [x] A single-task tree produces no violation from this rule.
- [x] Running the linter on an individual task **file** never evaluates this rule, only a directory
      argument does.
- [x] `extractSection` in `lint-task.ts` is reused; no new section parser is added and nothing new is
      exported from `parse-task.ts`.

- [x] A test command appearing only in Verification **prose** (not in a `- [ ]` / `- [x]` item) yields
      `[]`, with a test proving it neither triggers the rule nor satisfies it.
- [x] Both `- [ ]` and `- [x]` item forms are recognised as executable.

- [x] A checklist item whose backticked test command sits on a **continuation line** is detected, and a
      multi-span wrapped item yields every one of its test commands.
- [x] A blank line closes an item, so a prose test-command mention after one is not attributed to it.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` green.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/` green — no regression in the sibling
      script suites.
- [x] Build a temp tree where a non-final task carries `` `bun test some/dir` `` and the final-review task
      carries none, then run `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts <tmp>/tasks`:
      it exits 1 and stderr contains `final-review-test-net`.
- [x] Run the linter on that same tree's single final-review **file** rather than the directory: it exits
      0 and stderr contains no `final-review-test-net`.
- [x] Strip every test command from that temp tree and re-run against the directory: no
      `final-review-test-net` text appears in the output.
- [x] `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/autopilot-graph-v2/tasks`
      reports no `final-review-test-net` violation — this tree's own closing gate already runs a suite.
- [x] `grep -n "extractHeadingSection" packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts`
      shows it is still unexported (no `export` on its declaration).

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The rule fires on a silent tree, misses a real gap, or evaluates for a single-file argument. | Fires correctly on the main case but mishandles a scoped case (no marker, single task, command outside Verification). | Every listed case behaves as specified, including the whole-tree-only scoping. |
| Test coverage | ×2 | No test, or tests that would pass without the change. | Happy path only. | Fire, silent, scoped, single-task, and file-vs-directory cases all tested, and the exit-code behaviour is proven by driving the CLI. |
| Interface & readability | ×1 | A duplicated section parser, or a widened parser export. | Works but drifts from the file's existing check style. | Mirrors `checkFinalReview`'s shape and reuses `extractSection`; the detector regex is commented with why its boundary exists. |
| Assumptions & docs | ×1 | The Verification-only narrowing is left silent. | Noted somewhere. | The Verification-only scope and the no-double-violation choice are both recorded as *why* comments next to the code. |
