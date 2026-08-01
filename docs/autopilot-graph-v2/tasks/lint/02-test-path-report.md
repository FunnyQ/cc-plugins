# LINT-02: informational test-path report

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/lint-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: lint/01
> **Status**: todo

## Goal

`lint-task.ts` prints an advisory map of which paths each task's test commands cover, so a planner can
eyeball whether the closing gate's regression net actually reaches the tree — without that report ever
being able to change the verdict.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lint-task.ts` (modify) — add a pure report builder, a
  formatter, and the whole-tree print site.
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — cover the builder, the
  crude path extraction, and the exit-code neutrality.

## Implementation notes

### Why this is a report and not a rule

The tree-level regression-net check enforces **presence** only: a closing gate satisfies it with
`bun test one/narrow/dir` while missing most of the tree. Reach cannot be decided mechanically from a
command string — an argument may be a directory, a single file, a glob, or absent entirely, and a bare
`bun test` with no argument is the *widest* possible net rather than the narrowest. Any attempt to score
breadth would be guessing with a straight face.

So the countermeasure is advisory: print the path arguments side by side and let a human judge. That is
the entire contract. This output is **never** a gate, and the design below makes that structural rather
than a promise.

### The report builder

Add beside the tree-level check:

```ts
export type TestNetReportRow = {
  ref: string;          // "bucket/NN"
  finalReview: boolean;
  commands: string[];   // the test commands as written, in document order
  paths: string[];      // path-ish arguments across those commands; empty means "no argument given"
};

/**
 * Advisory view of which paths each task's test commands touch. One row per task
 * that runs at least one test; the final-review task sorts last so a reader
 * compares the closing gate against the tree above it. Returns [] when no task
 * in the tree runs a test at all.
 */
export function testNetReport(tasks: ParsedTask[]): TestNetReportRow[]
```

Build each row from the exported test-command detector — the helper that returns a task's backticked
`## Verification` commands matching a known test runner. Do not re-derive commands here.

Tasks with **no** test command are omitted. A row with nothing in it adds no signal to a reach
comparison, and listing every task would bury the two or three rows that matter.

Then a separate formatter, so the rows stay assertable without string matching:

```ts
/** Render the rows as an indented, human-scannable block. Pure. */
export function formatTestNetReport(rows: TestNetReportRow[]): string
```

The formatter labels the final-review row distinctly (it is the row the reader is comparing *against*)
and renders an empty `paths` array as `(all)` — an argument-less runner sweeps everything, and printing
a blank there would read as "no coverage", the exact opposite of the truth.

### Extracting path arguments — crude on purpose

```ts
// Path-ish arguments of a test command. Crude by design: split on whitespace,
// drop the runner tokens and any flag. A command string is not a shell AST, and
// this output is advisory for a human — never a gate — so a wrong guess costs one
// confusing line, not a false verdict.
```

The rules, in order:

1. Split the command on whitespace.
2. Drop the leading runner tokens — exactly the words the runner pattern consumed. The count is **not**
   uniform, and the three-token `run` forms are the trap:

   | Command form | Tokens consumed |
   |---|---|
   | `bun test`, `cargo test`, `go test`, `make test`, `npm test`, `pnpm test`, `yarn test` | 2 |
   | `npm run test`, `pnpm run test`, `yarn run test` | **3** |
   | `pytest`, `rspec` | 1 |

   Consuming two tokens from `npm run test` leaves the literal `test` sitting in `paths`, which reads
   as a covered directory named `test`. Derive the count from what the pattern matched rather than
   hardcoding 2.
3. Drop any remaining token beginning with `-`.
4. Keep everything else verbatim.

Explicitly do **not**: resolve, normalize, `stat`, or glob-expand. The builder must stay pure with no
filesystem access, which is also what keeps it trivially unit-testable.

### Where it prints, and the ordering trap

Print inside the existing whole-tree branch of `main()`:

```ts
if (treeRoots.length > 0) {
  // ...the tree-level checks already reported here...
  const rows = testNetReport(parsed);
  if (rows.length > 0) console.log(formatTestNetReport(rows));
}
```

Two properties are load-bearing, and both come from placement rather than from discipline:

- **`console.log` writes to stdout.** Violations go to stderr and are what drive the exit code. A report
  on stdout is therefore structurally incapable of changing the verdict — there is no code path from it
  to `process.exit`.
- **It must print before the failing-exit block.** `main()` ends with
  `if (total > 0) { ...; process.exit(1) }`. A print placed after that never runs on a failing tree —
  which is exactly the tree where a planner most needs to see reach. Print it while both outcomes are
  still ahead.

The report must appear on a clean tree too. Its purpose is routine review, not error decoration.

### Out of scope for this task

- Any change to the exit code, to violation severity, or to the tree-level regression-net rule itself.
- A `--report` / `--quiet` / `--no-report` flag. No current requirement needs one, and an option added
  without a failing requirement is the kind of layer this repo rejects.
- Resolving or validating path arguments against the filesystem.
- Judging or scoring reach. The report shows; a human decides.
- Any change to `references/task-template.md` or the flightplan `SKILL.md`.

## Acceptance criteria

- [ ] `testNetReport` is exported and returns one row per task carrying at least one test command, with
      the final-review task's row last.
- [ ] `testNetReport` returns `[]` when no task in the tree runs a test, and omits tasks that have no
      test command.
- [ ] Path extraction drops the runner tokens and every token beginning with `-`, and keeps the
      remaining tokens verbatim.
- [ ] A command with no argument (for example a bare `bun test`) yields an empty `paths` array, and the
      formatter renders that as `(all)`.
- [ ] `formatTestNetReport` is exported, is pure, and marks the final-review row distinctly from the
      others.
- [ ] Neither function touches the filesystem.
- [ ] The report is written to **stdout** in whole-tree mode, and is not printed at all when the linter
      is given individual task files.
- [ ] The exit code is unchanged by the report: a clean tree still exits 0 and a violating tree still
      exits 1.
- [ ] The report is printed for a violating tree as well as a clean one.

- [ ] Every recognised runner form has its prefix fully consumed, including the three-token
      `npm run test` / `pnpm run test` / `yarn run test` forms and the single-token `pytest` / `rspec`
      forms; no form leaves a literal `test` or `run` in `paths`.

## Verification

- [ ] `bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` green.
- [ ] `bun test packages/dispatch/skills/flightplan/scripts/` green — no regression in the sibling
      script suites.
- [ ] Drive the CLI as a subprocess with `Bun.spawn` over a clean temp tree that runs tests: exit code is
      0 and stdout contains the report block. Calling the exported function alone cannot prove the exit
      code was untouched, so the subprocess check is required, not optional.
- [ ] Drive the CLI as a subprocess over a temp tree that has a real violation: exit code is 1, stderr
      carries the violation, and stdout **still** carries the report block.
- [ ] Drive the CLI as a subprocess with a single task file rather than a directory: stdout contains no
      report block.
- [ ] `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/autopilot-graph-v2/tasks` prints
      a report block naming this tree's own test paths, and still exits 0.
- [ ] A temp tree whose tasks run no tests at all prints no report block.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The report changes the exit code, is swallowed on a failing tree, or prints for a single-file argument. | Prints correctly on a clean tree but mishandles the failing-tree or argument-less-command case. | Report content, stdout placement, both exit codes, and the `(all)` case all behave as specified. |
| Test coverage | ×2 | No test, or tests that would pass without the change. | Builder tested in isolation only, so exit-code neutrality is unproven. | Builder and formatter unit-tested, plus subprocess checks pinning exit 0 and exit 1 with the report present in both. |
| Interface & readability | ×1 | Report building and formatting tangled together, or path extraction reaching for the filesystem. | Works but drifts from the file's existing style. | Pure builder, pure formatter, crude extraction kept crude, all matching the file's existing check style. |
| Assumptions & docs | ×1 | The crudeness of path extraction is left unstated. | Noted somewhere. | The advisory-not-a-gate intent, the crude extraction, and the print-before-exit ordering are each recorded as *why* comments next to the code. |
