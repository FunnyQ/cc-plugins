# LINT-03: template guidance and the existing-tree sweep

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/lint-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: lint/01, lint/02
> **Status**: todo

## Goal

New plans are *written* with a closing regression net rather than corrected by the linter afterwards, and
every existing plan tree under `docs/` has been linted with each real finding recorded instead of quietly
accepted.

## Files to create / modify

- `packages/dispatch/skills/flightplan/references/task-template.md` (modify) — the
  `### \`Final review\`` section states the regression-net requirement.
- `packages/dispatch/skills/flightplan/SKILL.md` (modify) — the **Final review** bullet in the
  required-dimensions list gains one sentence.
- `docs/autopilot-graph-v2/tasks/README.md` (modify) — record the sweep's findings under "Known gaps".

## Implementation notes

### Why guidance, not just enforcement

By this point the linter rejects a tree whose tasks run a test suite while its closing review task runs
none. A rule that only rejects teaches nothing at write time: the planner discovers the requirement as a
failure, after the tree is already written. Fixing that is the cheaper half of the work — state the
requirement where plans are authored, so lint becomes a backstop instead of the teacher.

### What to add to the task template

The `### \`Final review\`` section already covers the marker, the transitive-coverage rule, and the fact
that the closing rubric scores integration / goal / consistency / regressions rather than re-scoring
tasks. Extend it with the regression net. Cover four things, briefly:

1. **The requirement.** If any task in the tree runs a test suite, the closing review task's
   `## Verification` must run one too.
2. **Why it is that task specifically.** The closing review's fixer is the last writer in a run: it
   applies findings with Edit/Write after every other task has already been verified. Its edits are gated
   only by that task's own `## Verification`, and no earlier task can help — they already ran.
3. **What satisfies it.** Name the recognized runners so a planner is not guessing: `bun test`,
   `npm` / `pnpm` / `yarn test`, `cargo test`, `pytest`, `go test`, `rspec`, `make test`.
4. **The exemption.** A tree that runs no test anywhere — a docs-only plan — needs nothing and triggers
   nothing.

Also note that the linter enforces **presence, not reach**: a narrow path argument satisfies the rule, and
the advisory report the linter prints alongside it is what a human reads to judge breadth. Setting that
expectation in the template stops a planner from believing the closing gate is proven complete.

Match the section's existing voice and length. It is prose guidance, not a spec dump.

### What to add to the flightplan skill

The required-dimensions list in `SKILL.md` has a **Final review** bullet describing the closing gate.
Append **one sentence**: when the tree runs tests anywhere, the closing task's `## Verification` must run
a suite too, and the linter enforces it. One sentence is the budget — that list is deliberately terse and
a paragraph there would crowd out the dimensions around it.

### The sweep

Run from the repo root:

```bash
for t in docs/*/tasks; do
  echo "== $t"
  bun packages/dispatch/skills/flightplan/scripts/lint-task.ts "$t"
done
```

Expect non-zero exits. That is the intended outcome, not noise: each failure of the regression-net rule is
a real closing gate that never ran the suite its own tree owns.

**Do not retro-fit a tree whose tasks are already marked `done`.** This is a hard constraint with a
mechanical cause, not a preference:

- `taskValidity` returns `invalid` with rule `completion-state` when a task's status is `done` while any
  checkbox in `## Acceptance criteria` or `## Verification` is still unticked.
- So adding an unticked test-command item to a completed task makes that task invalid, which is strictly
  worse than the gap it was meant to close — an invalid tree cannot be trusted at all.
- And ticking the new box by hand is forbidden by `COMPLETION_STATE_FIX`: a ticked box asserts a gate that
  actually ran, and hand-ticking fabricates a result the tree then trusts forever.

There is no third option that preserves honesty, so historical trees are **reported and left alone**.

For every failing tree, capture: the tree path, the rule that fired, the closing review task's ref, and
which tasks' suites the closing gate is missing. The violation's own detail already carries the last two —
copy it rather than paraphrasing.

### Where the findings go

Write them into this tree's `tasks/README.md` under its "Known gaps" section. `build-readme.ts`
regenerates the index and dependency graphs between its own markers and **preserves human-authored prose
outside them**, so entries placed in Known gaps survive a regeneration. Re-run `build-readme.ts` against
this tree after editing and confirm the entries are still present — that check is what proves they were
placed outside the generated block rather than inside it.

**Record a per-tree ledger, not just the failures.** Write one row per `docs/*/tasks` tree with its exit
status, under the "Sweep results" heading in `tasks/README.md`:

```markdown
| Tree | Exit | Finding |
|---|---|---|
| `docs/waypoints-skill/tasks` | 0 | — |
| `docs/some-tree/tasks` | 1 | closing task runs no suite; two other tasks run `bun test …` |
```

A failures-only list cannot distinguish "this tree passed" from "this tree was never swept", and a mixed
pass/fail sweep is the normal case. The ledger settles both: every tree appears exactly once, passes show
`0` with an em-dash, and each failure carries the rule, the closing task's ref, and the tasks whose suites
are missing. If every tree passes, the ledger is still written in full — that *is* the explicit "no
findings" statement, and it is checkable rather than a claim.

Put a one-line summary in "Known gaps" only when at least one tree fails, pointing at the ledger. Do not
duplicate the ledger's contents there.

### This tree must stay clean

`bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/autopilot-graph-v2/tasks` must still
exit 0 when this task finishes. This tree's own closing gate runs a suite, so the rule is satisfied — the
check guards against an accidental edit, not against a known gap.

### Out of scope for this task

- Editing any task file in any other tree. The sweep reports; it never repairs.
- Ticking or unticking any checkbox anywhere, in any tree.
- Any change to `lint-task.ts` — both the rule and the advisory report already exist by the time this task
  runs, and changing severity or output here would undo a decision already made.
- Downgrading the rule to a warning to make a historical tree pass.
- Any version bump or `CHANGELOG.md` entry.

## Acceptance criteria

- [ ] The `### \`Final review\`` section of `references/task-template.md` states the regression-net
      requirement, why it applies to the closing task specifically, the recognized runner commands, and
      the docs-only exemption.
- [ ] That section also states that the rule enforces presence rather than reach, and points the reader at
      the advisory report for breadth.
- [ ] The **Final review** bullet in `SKILL.md` gains exactly one sentence covering the requirement and
      naming the linter as its enforcer.
- [ ] Every `docs/*/tasks` tree in the repo appears exactly once in the "Sweep results" ledger in this
      tree's `tasks/README.md`, with its observed exit status — passing trees included.
- [ ] Every failing row carries the rule, the closing task's ref, and the tasks whose suites are missing.
- [ ] "Known gaps" carries a one-line pointer to the ledger when at least one tree fails, and does not
      duplicate the ledger's rows.
- [ ] A fully-passing sweep still produces a complete ledger — that is how "no findings" is stated, so no
      separate prose claim is needed or accepted in its place.
- [ ] No task file outside `docs/autopilot-graph-v2/` is modified.
- [ ] No checkbox anywhere is hand-ticked or unticked.
- [ ] `lint-task.ts` is unchanged by this task.

## Verification

- [ ] `grep -n "Final review" packages/dispatch/skills/flightplan/references/task-template.md` locates the
      section, and reading it shows all four points plus the presence-not-reach note.
- [ ] `grep -c "test" packages/dispatch/skills/flightplan/SKILL.md` increases relative to the pre-task
      count, and the **Final review** bullet reads as one added sentence rather than a new paragraph.
- [ ] Run the sweep loop above and confirm the ledger matches reality row for row: every tree the glob
      matches has a row, every row's exit status is the one observed, no row records a finding the sweep did
      not produce, and no failure is missing.
- [ ] `ls -d docs/*/tasks | wc -l` equals the number of ledger rows — the check that catches a tree the
      sweep skipped entirely.
- [ ] `bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/autopilot-graph-v2/tasks` exits 0.
- [ ] `bun packages/dispatch/skills/flightplan/scripts/build-readme.ts docs/autopilot-graph-v2/tasks` then
      `grep -n "Known gaps" -A 12 docs/autopilot-graph-v2/tasks/README.md` still shows every recorded
      entry, proving they sit outside the generated markers.
- [ ] `git status --short docs/` lists changes only under `docs/autopilot-graph-v2/`.
- [ ] `git diff --stat packages/dispatch/skills/flightplan/scripts/` is empty — no script was touched.
- [ ] `bun test packages/dispatch/skills/flightplan/scripts/` green, guarding against an accidental code
      edit while working in the same package.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | A historical tree was edited or a box hand-ticked, or the sweep was not actually run. | Docs updated and sweep run, but a finding is unrecorded or a recorded finding is paraphrased away from the real violation. | Both docs updated as specified, every tree swept, every finding recorded verbatim, nothing outside this tree touched. |
| Test coverage | ×2 | No check that the guidance landed or that the sweep ran. | Greps confirm the docs, but the sweep results are unverified against what was recorded. | Docs confirmed by grep, sweep output reconciled item-by-item with Known gaps, and the regeneration check proves the entries survive `build-readme.ts`. |
| Interface & readability | ×1 | Guidance dumped as a spec list, or the skill bullet bloated into a paragraph. | Correct content but drifting from the surrounding voice. | Template prose matches its section's voice and length; the skill bullet is one sentence. |
| Assumptions & docs | ×1 | The no-retro-fit decision is applied without stating why. | Mentioned in passing. | The `completion-state` mechanism and the forbidden hand-tick are both stated as the reason historical trees are reported rather than repaired. |
