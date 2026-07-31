# WIRING-03: fixture flight verification

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: wiring/01, wiring/02, ui/03, ui/04
> **Status**: todo

## Goal

Prove the whole chain works by flying a real, tiny plan end to end and watching it in the browser —
because static checks cannot catch the failures this integration actually has.

## Files to create / modify

- `docs/flightdeck-fixture/` (new, temporary) — a minimal plan tree used only for this flight, removed
  afterwards and never committed.
- `docs/flightdeck/FIXTURE-FLIGHT.md` (new, committed) — the durable record of what the flight showed.
- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify, only for a wiring defect)
- `packages/dispatch/skills/autopilot/SKILL.md` (modify, same condition)

This task owns fixes to **its own bucket's two files only**. See "If the flight exposes a defect" below
for what happens to anything else it finds.

## Implementation notes

### Why a live flight and not more static checks

The two failure modes this integration is most likely to have cannot be seen in a diff. First, the log
path: an agent that changes directory into the tasks tree and resolves a relative path writes the trail
into a nested directory, splitting it in two. The symptom is a viewer that shows nothing while the run
clearly progresses. Second, the pairing: a start and its end must share an agent label, and only a real
run shows what labels the agents actually write when they substitute their own.

Both look completely correct in the source.

### Building the fixture

The fixture is a three-task plan in two buckets. Build it with the flightplan bundled scripts, which
live beside the ones this repository already uses:

```bash
FP=packages/dispatch/skills/flightplan/scripts
bun $FP/scaffold.ts flightdeck-fixture core,close
```

That creates `docs/flightdeck-fixture/tasks/_context/`, `tasks/core/`, and `tasks/close/`.

Then write **five** files by hand, following the same shapes this plan's own tree uses — two context
files and three task files:

1. **`tasks/_context/shared.md`** — a few lines: the work is throwaway, the runtime is Bun, output goes
   under `/tmp/flightdeck-fixture/`.
2. **`tasks/_context/rubric.md`** — the 0–5 scale and the four generic dimensions.
3. **`tasks/core/01-write-a-file.md`** — H1 `# CORE-01: write a file`, no dependencies, status `todo`.
   The work: create `/tmp/flightdeck-fixture/one.ts` exporting `add(a, b)`, plus a `bun test` file with
   one assertion.
4. **`tasks/core/02-write-another-file.md`** — H1 `# CORE-02: write another file`, depends on the first
   task in its own bucket, status `todo`. The work: a second file exporting `double(n)`, plus one test.
   Its dependency on a sibling is what makes the wave loop run twice rather than once.
5. **`tasks/close/01-final-review.md`** — H1 `# CLOSE-01: final review`, marked `> **Final review**: true`,
   depending on both core tasks. The linter requires exactly one such task reaching every other.

Every task needs a real `## Eval rubric` with a threshold line and a weighted table, so the judge and the
scoring script run for real. A fixture that skips scoring would not produce the score entries the fleet
table is supposed to render.

Keep the work genuinely trivial. The point is exercising the pipeline, not the code. The whole flight
should finish in a few minutes.

Validate the fixture before flying it, or the run will fail for reasons that have nothing to do with
this task:

```bash
bun $FP/lint-task.ts docs/flightdeck-fixture/tasks
bun $FP/build-readme.ts docs/flightdeck-fixture/tasks
```

Do not commit this tree. It exists for one run. Remove it afterwards with the repository's `trash`
command rather than a hard delete.

### Recording what the flight showed

The fixture gets deleted, but the evidence must not. The closing review of this plan runs later and
needs to know this gate actually passed, so write `docs/flightdeck/FIXTURE-FLIGHT.md` and commit it.
Keep it short and factual:

- the date, the dev engine chosen, and how many waves the run took
- each live observation from the checklist below, marked confirmed or not
- these four explicitly, because the closing review scores its goal dimension directly against them:
  1. an agent's role, task ref, attempt, and rising elapsed value all visible **at the same moment**
  2. a task card observed changing state during the run, with no reload
  3. a rubric score on the page whose weighted value matches the verdict the run recorded
  4. the page opened by the skill, not by hand
- the output of the post-run verification commands, pasted
- every wiring defect fixed here: what was wrong, which file changed, and whether a re-flight followed
- every defect belonging to another component: the symptom, the owning file, and what a fixer needs to
  know. These are handed to the closing review, not fixed in this task.
- anything noticed about the Workflow runtime's own journal files, for the deferred layer

Without this file the later review has no way to distinguish a gate that passed from one that was
skipped.

### Running it

Fly the fixture with the autopilot skill as a user would, choosing the Claude dev engine so the run does
not depend on an external CLI being installed. Watch the browser for the whole run rather than checking
at the end — the in-flight states are exactly what a post-hoc log inspection cannot show.

### What to confirm during the flight

- The browser opens once, on its own, after the confirmation step.
- The page shows the fixture's tasks, not a previous plan's.
- A start entry appears for the scout, the dev agent, the verifier, and the judge, each with a pulsing
  in-flight row and a ticking elapsed value. The closing round adds review rows, plus a fix row only if
  the review found something to fix.
- Each of those rows moves to finished with a fixed elapsed value.
- A task's card moves from ready to in-flight to done as the run progresses, without a reload.
- A score meter appears on the judged task with a numeric value matching the run's own verdict.
- The dependency graph recolours as tasks land, and no node moves.
- The closing review round produces review rows for its lenses.

### What to confirm afterwards

- Exactly one flightlog directory exists under the fixture plan. A second one nested inside the tasks
  tree means the path trap fired and the start-log lines need fixing.
- Every start entry has a matching end entry, paired on the agent label.
- The rendered run log is unchanged in character by the new start entries — they must not appear in it.
- The daemon is still running and still serving the fixture after the flight ends.

### If the flight exposes a defect

Finding defects is the point of this task, not a failure of it. But fixing *everything* they touch is
not this task's job, and treating it that way would let one task quietly absorb half the plan.

Split what you find:

- **A wiring defect** — a wrong role, an unbalanced marker pair, a split trail, a launch that does not
  fire. These live in this bucket's own two files. Fix them here and re-fly until the flight is clean.
  That loop is expected and bounded; the edits are small and textual.
- **A defect in any other component** — the derivation layer, an endpoint, a view. **Do not fix it here.**
  Record it in the evidence file with the symptom, the owning file, and enough detail to act on. The
  closing review of this plan reads that file and owns the remediation, where the fix sits beside the
  rest of the integration judgement.

If a non-wiring defect is severe enough that the flight cannot complete at all, say so plainly in the
evidence file and stop rather than repairing another component's work from inside this task.

## Acceptance criteria

- [ ] The three-task fixture is built as specified, passes lint, is flown to completion, and is removed
      afterwards with `trash`.
- [ ] `docs/flightdeck/FIXTURE-FLIGHT.md` is written and committed, recording every observation, the
      pasted verification output, and any defects with their fixes.
- [ ] The browser opened once, unprompted, after the confirmation step.
- [ ] Start entries were observed live for the scout, dev, verify, and judge agents during the work
      waves, and for the review agents during the closing round.
- [ ] If the closing review requested remediation, a fix agent was observed too. If it did not, the
      evidence file records that no fixer ran and why — a clean flight producing no fixer is a pass.
- [ ] Every observed in-flight row transitioned to finished with an elapsed value.
- [ ] Task cards advanced through their states without a page reload.
- [ ] A score meter rendered with a value matching the run's actual verdict.
- [ ] The graph recoloured without any node moving.
- [ ] Exactly one flightlog directory exists under the fixture plan when the run ends.
- [ ] Every start entry has a matching end entry paired on the agent label.
- [ ] The rendered run log contains no start entries.
- [ ] Every wiring defect was fixed in this bucket's files and the flight repeated until clean.
- [ ] Every non-wiring defect was recorded in the evidence file with its symptom and owning file, and
      was **not** fixed here.
- [ ] The fixture tree is not committed.

## Verification

- [ ] Confirm a single trail directory:
      `find docs/flightdeck-fixture -type d -name .flightlog` → exactly one path.
- [ ] Confirm start entries were written for **every** instrumented role. The balance check below cannot
      catch a role that emitted neither a start nor an end, so assert presence separately:
      ```bash
      jq -r 'select(.phase == "start") | .role' docs/flightdeck-fixture/.flightlog/run.jsonl | sort -u
      ```
      → must include all five of `scout`, `dev`, `verify`, `judge`, `review`. The fixture's closing review
      round is what produces `review`, which is why the fixture needs a real final-review task rather than
      two work tasks alone.
      **`fix` is conditional**, not required: the fixer only runs when the closing review actually finds
      something to fix, so a clean flight legitimately has no `fix` row. Do not manufacture a defect to
      force one. If the review did request remediation, then `fix` must appear and must balance; if it did
      not, record that in the evidence file and move on.
- [ ] Assert start and end pairing mechanically. This must **fail** on an orphan, not merely print rows
      for eyeballing:
      ```bash
      jq -e -s '
        map(select(.kind == "note"))
        | group_by(.agentLabel)
        | map({
            label: .[0].agentLabel,
            starts: (map(select(.phase == "start")) | length),
            ends:   (map(select(.phase != "start")) | length)
          })
        | map(select(.starts != .ends))
        | if length == 0 then true else (., false) end
      ' docs/flightdeck-fixture/.flightlog/run.jsonl
      ```
      Exit status `0` means every label balanced. A non-zero exit prints the offending labels with their
      counts; an unbalanced label is an agent that will render as permanently in flight.
- [ ] Confirm the run log excludes start entries:
      `bun packages/dispatch/skills/flightplan/scripts/flightlog.ts report docs/flightdeck-fixture/.flightlog/run.jsonl --out /tmp/fd-fixture-runlog.md`
      then `rg -c "phase" /tmp/fd-fixture-runlog.md` returns no matches.
- [ ] Confirm the daemon still answers after the flight:
      `curl -s localhost:5757/api/tree | jq '.slug'` → the fixture slug.
- [ ] Confirm the evidence record exists and is staged before the fixture is removed:
      `git status --porcelain docs/flightdeck/FIXTURE-FLIGHT.md` shows it added.
- [ ] Confirm the fixture is untracked and then removed:
      `git status --porcelain docs/flightdeck-fixture` shows it untracked, then `trash docs/flightdeck-fixture`.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/ packages/dispatch/skills/flightplan/scripts/` — all green after any fix.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | No real flight was run, or the trail split and was not fixed | Flew but only checked the log afterwards, or repaired another component's code from inside this task | A real flight was watched live, every observation confirmed, wiring defects fixed and re-flown clean, other defects recorded and handed on |
| Test coverage | ×2 | No post-run checks | Ran one or two checks | Every Verification command run, plus the full suites green afterwards |
| Interface & readability | ×1 | Fixture is elaborate or left behind | Fixture removed but the evidence record is thin | Fixture minimal and removed, evidence record short, factual, and complete |
| Assumptions & docs | ×1 | No evidence record was committed | Record exists but omits defects or verification output | Record carries observations, pasted output, and each defect with cause, fix, and whether a re-flight followed |

## Out of scope

- Committing the fixture tree or turning it into a permanent test. Deferred: a live flight costs model
  calls, so it stays a manual gate rather than something that runs on every change.
- Investigating the Workflow runtime's own journal files. That layer was excluded from this version;
  note anything observed about them for later rather than building on it.
- Fixing defects outside this bucket's two files. Record them for the closing review instead; letting
  this task repair other components would make its scope unbounded.
- Fixing anything unrelated that the flight happens to reveal. Report it and leave it.
- Performance tuning of the viewer. A fixture flight is too small to say anything useful about load.
