# Handoff: `mark-done.ts` stranded a whole task subtree without an error

> **Status**: fixed — see "What was fixed"
> **Reporter**: Q (via Claude)
> **Found in**: dispatch 3.15.4, `skills/flightplan/scripts/`
> **Observed**: 2026-07-31, twice in one autopilot run of `herdr-workbench` `docs/rust-rewrite`
> **Severity when open**: high — an autopilot run reported success while silently skipping remaining work

## Summary

A dev agent appended a note to a task's `Status` line. `mark-done.ts` then failed to flip
that status and exited `0` with no output. The task stayed unready, every dependent stayed
blocked, and the autopilot wave loop ended **reporting a clean finish with zero
escalations**.

Nothing in the run surfaced the problem. Only a hand comparison of the workflow's
`completed` array against the on-disk statuses revealed it.

## The defect

`markDone()` matched the Status line with a pattern that required a single bare word ending
the line:

```ts
const status = /^(>\s*\*\*Status\*\*\s*:\s*)([A-Za-z-]+)\s*$/.exec(line);
```

A decorated line did not match. The function then left the status untouched and returned
normally. `extractStatus` in `lib/parse-task.ts` anchored the same way, **on purpose** — so
that trailing junk like `todo maybe` is rejected rather than silently read as `todo`.

The anchoring was correct. The bug was that **no consumer reported the rejection at the
moment it mattered**, and the rule lived in two separate copies that could drift.

## Why it was silent — the full chain

1. A dev agent wrote `> **Status**: in-progress (attempt 3)`.
2. The task passed the binary gate and the rubric judge.
3. `mark-done.ts` ran. The Status regex missed, so the status was never flipped. **The
   checkbox loop still ran**, because it was independent of the status match. The file ended
   up half-finalized: every gate checkbox ticked, status still `in-progress`. Exit code `0`,
   no stdout, no stderr.
4. The orchestrator appended the task to `completed`. It gated on the judge verdict and
   never re-read the file.
5. The next wave called `next-ready.ts`. `extractStatus` returned `null`, so the task itself
   was skipped (readiness offers only `todo`), and every dependent was held back (a
   dependency counts only when it is `done`).
6. The ready set was `[]`. The wave loop broke on the empty set and returned
   `escalations: []`.

Step 3 is the deceptive part. A half-finalized file reads as finished at a glance.

## Evidence

Both cases come from one plan, `herdr-workbench` `docs/rust-rewrite` (**30** tasks —
an earlier draft of this document said 31).

| Task | Status line written by the dev agent | Score | Stranded |
|---|---|---|---|
| `picker/01` | `in-progress (retry 3: …)` — **reconstructed**, see below | 4.86 pass ✓ | `picker/02`, `polish/04` |
| `cutover/01` | `in-progress (attempt 3)` ✓ | 5.00 pass ✓ | `cutover/02`, `cutover/03` (the Final review) |

✓ = verified against the repo on 2026-08-01. The `picker/01` status line is **reconstructed
from the original report**: no commit in `herdr-workbench` contains that string, so the exact
wording cannot be reproduced. Its score and its stranding are verified.

The `cutover/01` half-finalized state is reproducible from history:

```zsh
git show 0b96d52:docs/rust-rewrite/tasks/cutover/01-manifest-flip.md | rg -c '^- \[x\]'
# 19
git show 0b96d52:docs/rust-rewrite/tasks/cutover/01-manifest-flip.md | rg '^> \*\*Status\*\*'
# > **Status**: in-progress (attempt 3)
```

Nineteen ticked boxes, status never flipped.

The `cutover/01` case cost a whole extra autopilot run. It stranded `cutover/03`, the
Final review, so the closing cross-vendor gate never ran in that first pass.

## Recovery status: complete

`herdr-workbench` `docs/rust-rewrite` is fully recovered and needs no further work:

```
counts: total 30, todo 0, inProgress 0, done 30, blocked 0, invalid 0
```

The stranded closing tasks did run, and their verdicts are retained here as evidence that
the recovery was gated, not hand-waved (from `docs/rust-rewrite/.flightlog/run.jsonl`):

| Task | Attempt | Weighted | Passed |
|---|---|---|---|
| `cutover/01` | 3 | 5.00 | yes |
| `cutover/02` | 2 | 4.43 | yes |
| `cutover/03` (Final review) | 1 | 4.71 | yes |

Do not re-run that plan. It is evidence, not remaining work.

## Related: agents decorate task headers freely

The same run produced `> **Retry attempt**: 2` in
`docs/rust-rewrite/tasks/agent/05-dashboard.md`. That one is harmless — it sits on its
own line, so the `Status` line still parses. It is the same impulse, one line away from
the same outcome.

At the time, nothing told a dev agent that the Status line takes exactly one word.

## Why the lint hook never fired — two blind spots, not one

The original diagnosis named only the second of these. Both were real.

**1. The hook's content signature did not match the header flightplan scaffolds.** The hook
sniffed for `> **Required reading**:` — a colon immediately after the label. But flightplan
scaffolds the annotated form, and every failing file carried it:

```markdown
> **Required reading** (read before starting; do not need to open other files):
```

So the hook skipped **every current task file**, silently, on every Edit and Write. This was
not diagnosed at the time; the original document asserted the marker matched.

**2. A `PostToolUse` hook cannot see an external engine's writes.** The hook reads
`.tool_input.file_path`, so it only ever sees Claude's own Write/Edit calls. The run that
produced both failures used `CFG.devEngine: 'codex'`. Codex edits the working tree from its
own subprocess, and those writes never pass through a Claude tool call. That blind spot
covers every external dev engine — `codex` and `opencode` alike.

Fixing (1) makes the hook work again for Claude-written task files. Fixing (2) is not
possible inside a `PostToolUse` hook at all, so it is covered elsewhere: the external-engine
dev driver now runs `lint-task.ts` on the task file itself, and the execution boundary does
not depend on the hook.

## What was fixed

1. **Hook content signature** — `flightplan-lint.sh` accepts the annotated header and the
   legacy bare-colon header, and still rejects near misses like `**Required reading later**`.
   `flightplan/SKILL.md` documents both forms and states plainly that the hook observes
   harness `Edit|Write` calls only.
2. **`mark-done.ts` is one atomic transition** — it validates the header *first* (exactly one
   Status line in the header blockquote, holding one of the four bare values), and only then
   rewrites Status and the gate checkboxes together. On a malformed header it exits non-zero,
   names the file on stderr, and writes nothing. The half-finalized file is now unreachable.
3. **One shared Status rule** — `matchStatusLine()` and `parseStatusValue()` live in
   `lib/parse-task.ts`; `mark-done.ts` and the parser both call them. The duplicated regex is
   gone.
4. **Malformed completion is a first-class state** — `taskValidity()` treats `Status: done`
   with any unticked `## Acceptance criteria` / `## Verification` box as invalid. `lint-task.ts`
   reports it as a `completion-state` violation, `next-ready.ts` exits non-zero instead of
   unlocking dependents, and the flightdeck counts it as `invalid` rather than `done`.
5. **The orchestrator confirms both status transitions** — `markDonePrompt` and
   `markBlockedPrompt` each return `{ ok, status, error }` and each must reopen the file and
   read the Status line back. A task joins `completed` only after a reread shows a bare
   `Status: done`; a park counts as `parked: true` only after a reread shows a bare
   `Status: blocked`. An unconfirmed transition parks and escalates.
6. **Whole-tree completion is resume-safe** — `next-ready.ts --summary` returns
   `{ ready, counts, unfinished, invalid, errors }`, and the wave loop terminates on
   `counts.done === counts.total` instead of on its own current-run `completed` array. It
   checks `errors` **first**: an unparseable file never enters the task map, so it never
   enters `counts`, and `done === total` would otherwise hold over a tree that still contains
   task files nobody could read.
7. **The agents are told the rule** — `references/task-template.md` states that the Status
   value is bare, that run notes go on their own line, and that a `done` task must carry every
   gate box ticked. It explicitly forbids repairing a malformed completion by hand-ticking.

### Rejected alternatives, kept for the record

- **Make `mark-done.ts` tolerant** — accept a decorated line, take the first word, rewrite to
  a bare `done`. Rejected: it silently discards text an agent wrote, and it hides the agent
  behaviour instead of correcting it.
- **Skip only the checkbox pass on a status miss** — an earlier draft of this document
  suggested leaving the single rewrite pass in place and skipping the checkbox half when the
  status did not match. That is the wrong shape: it still treats one state change as two
  independent edits, so any future miss can still half-apply. The implemented fix validates
  before it writes anything, which removes the partial-write path entirely.

## How the fix is verified

```bash
bun test packages/dispatch
bun packages/dispatch/skills/flightplan/scripts/lint-task.ts docs/flightdeck/tasks
bun packages/dispatch/skills/flightplan/scripts/next-ready.ts docs/flightdeck/tasks --summary
```

Targeted coverage:

- `mark-done.test.ts` — decorated / missing / duplicate Status headers all throw; a body
  Status line is not a duplicate; the CLI exits non-zero and leaves the file byte-for-byte
  unchanged.
- `lib/parse-task.test.ts` — `taskValidity` across done-with-all-ticked, unticked acceptance,
  unticked verification, unticked non-gate, and decorated / unknown Status.
- `next-ready.test.ts` — a dependent is never offered behind a malformed dependency; the CLI
  fails loudly; `summarizeTree` across fresh, complete, resumed, stalled, blocked, mixed, and
  malformed trees.
- `flightplan-lint.test.ts` — the annotated header invokes lint; the near-miss marker stays a
  silent no-op.
- `autopilot/scripts/orchestrator-script.test.ts` — runs the canonical orchestrator block from
  `references/orchestrator.md` against stubbed agents, covering the termination rules, the
  quality-vs-infrastructure split, and the "every task lands in `completed` XOR `escalations`"
  invariant.

## Found by cross-vendor review, after the tests were green

A `codex review` pass over the finished diff found two P1 defects that the whole test suite had
just passed over. Both were in the new orchestrator logic, and both are fixed:

1. **The scout dropped `errors`.** `--summary` reports unparseable files separately from
   `counts`, because such a file never enters the task map. The first scout schema omitted the
   field, so a tree whose only readable task was `done` satisfied `done === total` and reported
   clean completion. `errors` is now a required scout field, checked before the completion test.
2. **`parkBlocked()` trusted the agent's word.** It returned `true` whenever the agent returned
   any text, without rereading the file — precisely the wrong assumption, since a task is often
   parked *because* its header is malformed. So a failed park could report `parked: true`, and
   the user would never be told to reset the Status by hand. The park step now returns a
   structured verdict confirmed by a reread, exactly like `mark-done`.

The lesson worth keeping: a green suite proves the cases you thought of. Both defects were
*omissions* in the new code's own contract, which is the class of bug a test written by the
same author cannot see.
