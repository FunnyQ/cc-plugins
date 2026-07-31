# Fix plan — the silent-gate defects

> **Status**: ready to execute
> **Owner**: Q
> **Written**: 2026-08-01
> **Source**: review of `docs/handoff-mark-done-silent-strand.md` plus findings from three
> `/dispatch:autopilot flightdeck` runs on 2026-07-31.

## Why these are one plan

Every defect below is the same shape: **a gate reports success while doing nothing.** A caller cannot
tell "checked, all clear" from "skipped". Two separate safety layers were present when a flightplan
tree stranded, and both were silent, so nothing surfaced.

Fix the two silent gates first. They prevent recurrence. Everything else is cleanup.

## Scope crosses two repos

| Repo | What lives there |
|---|---|
| `cc-plugins` (this repo) | the plugin source — the hook, `mark-done.ts`, `lint-task.ts`, and the handoff doc |
| `herdr-workbench` | the stranded `docs/rust-rewrite` tree that the handoff doc describes |

The handoff doc sits in this repo but narrates work done in `herdr-workbench`. Read a path in that doc
as `herdr-workbench`-relative unless it names `packages/`.

## Blocking constraint — read before starting

A `/dispatch:autopilot flightdeck` run may still be in flight. Its `wiring/01` task edits
`packages/dispatch/skills/autopilot/references/orchestrator.md`, and later tasks edit
`packages/dispatch/skills/autopilot/`. **Confirm that run has landed before touching
`packages/dispatch/`:**

```bash
rg -n "^> \*\*Status\*\*" docs/flightdeck/tasks/*/*.md | rg -v ": done"   # expect no output
git -C . status --porcelain                                              # expect clean
```

Items 1, 2, and 5 touch `packages/dispatch/`. Item 4 is in another repo and item 3 is docs-only, so
both can proceed regardless.

---

## 1. `flightplan-lint.sh` never runs — fix the content sniff

**Severity: highest.** This is dead code across every flightplan tree and every harness.

`packages/dispatch/hooks/flightplan-lint.sh:31` is gate 2 of 2:

```bash
if ! grep -q "^> \*\*Required reading\*\*:" "$file_path" 2>/dev/null; then
  exit 0
fi
```

The pattern demands a colon immediately after `**`. Every file `flightplan` scaffolds writes:

```
> **Required reading** (read before starting; do not need to open other files):
```

Measured, not inferred:

| Tree | Task files | Pass gate 2 |
|---|---|---|
| `cc-plugins` `docs/*/tasks/` (7 trees) | 65 | **0** |
| `herdr-workbench` `docs/rust-rewrite/tasks/` | 30 | **0** |

The hook clears its path filter, then exits 0 at the sniff for all 95 files. `lint-task.ts` behind it
is unreachable.

This matters because `lint-task.ts` **does** catch the defect in item 2. Verified on a fixture: given
`> **Status**: in-progress (attempt 3)` it reports `[status] Status missing or not one of
todo/in-progress/done/blocked` and exits 1. The detector worked. The gate in front of it never opened.

### Do

1. Drop the trailing colon from the pattern so it matches the marker regardless of what follows.
2. Add a case to `packages/dispatch/hooks/flightplan-lint.test.ts` using a **real** scaffolded header —
   copy the exact line from a live task file, do not hand-write a simplified one. A test that asserts
   against an invented header is what let this survive.
3. Re-measure. Expect 65 of 65 to pass gate 2 in this repo.

### Verify

```bash
bun test packages/dispatch/hooks/flightplan-lint.test.ts
rg -l '^> \*\*Required reading\*\*' docs/*/tasks/*/[0-9][0-9]-*.md | wc -l   # expect 65
```

---

## 2. `mark-done.ts` silently skips a decorated Status line

`packages/dispatch/skills/flightplan/scripts/mark-done.ts:41`:

```js
const status = /^(>\s*\*\*Status\*\*\s*:\s*)([A-Za-z-]+)\s*$/.exec(line);
```

`[A-Za-z-]+` is anchored to end-of-line, so the value must be a bare token. A dev agent that wrote
`> **Status**: in-progress (attempt 3)` made the match fail. The script then left the Status line
untouched, ticked every gate checkbox anyway, and **exited 0**.

The consequence is not cosmetic. `next-ready.ts` derives the ready set from Status, so a task that
passed its rubric still read as unfinished, its dependents stayed blocked, and the wave loop exited on
an empty ready set — reporting a clean successful run with 6 of 15 tasks never started.

Its fingerprint: **every checkbox ticked, Status unchanged.**

### Design constraints — do not skip these

Two traps, both surfaced in review of the handoff doc:

- **`markDone` is a single forward pass, and the Status line precedes the gate sections.** So "also skip
  the checkbox pass when the Status never matched" is not a small edit. It needs a pre-validation pass
  over the lines, or buffered writes. Decide which before coding.
- **Exiting non-zero when no Status line matched changes behaviour for a file that has no Status line at
  all.** `mark-done.test.ts` covers idempotence only for files that have one. Decide explicitly whether
  a missing Status line is an error or a no-op, and add the test either way.

### Do

1. Match the status token leniently — capture the leading word, allow trailing text.
2. Fail loudly when no Status line matched at all: non-zero exit plus a message naming the file.
3. Resolve both design constraints above, with a test for each.
4. Keep `markDone` pure and idempotent; that contract is documented at `mark-done.ts:22-25`.

### Verify

```bash
bun test packages/dispatch/skills/flightplan/scripts/mark-done.test.ts
```

Plus a fixture round-trip: a file with `> **Status**: in-progress (attempt 3)` must come out `done`, and
a file with no Status line must produce the decided behaviour, not a silent pass.

---

## 3. Correct the handoff document

`docs/handoff-mark-done-silent-strand.md`. Its core diagnosis is right and reproduces exactly. Seven
defects, most severe first:

| # | Line | Defect | Correct fact |
|---|---|---|---|
| 1 | 133–135 | Claims the hook filters on path and marker, "**both of which the failing files satisfied**", and that the detector "already works" | 0 of 30 files satisfied gate 2. The hook is dead for all of them. §C's conclusion survives; its stated reason does not. Rewrite the section, and note the hook as its own defect |
| 2 | 178 | Path `packages/dispatch/hooks/flightplan-lint.ts` | The file is `flightplan-lint.sh`. (`flightplan-lint.test.ts` on 179 is correct) |
| 3 | 61 | "31 tasks" | 30. The `_context/` directory holds 4 non-task files, the likely source of the miscount |
| 4 | 65 | The `picker/01` status string appears in no commit on any branch; the file is now `done` | Mark it as reconstructed. Its context corroborates it, but the table presents it with the same authority as the fully reproducible `cutover/01` row |
| 5 | 103–104 | "Also skip the checkbox pass in that case" | Not achievable as a small edit — see the single-forward-pass constraint in item 2 |
| 6 | 102 | Proposes exiting non-zero with no Status line matched | Unstated new failure mode for files with no Status line at all — see item 2 |
| 7 | 6 vs 79 | "twice in one autopilot run" against "cost a whole extra autopilot run" | Internally inconsistent. Not resolvable from the append-only `run.jsonl`; pick one and say which is uncertain |

Do this **after** items 1 and 2, so §C can describe the fixed hook rather than the broken one.

---

## 4. Unstrand the `rust-rewrite` tree (`herdr-workbench`)

Current state:

```
cutover/02-docs.md:9   > **Status**: in-progress
cutover/03-final-review.md:9   > **Status**: todo
```

`cutover/02` reads a **bare** `in-progress`, so this is **not** the item-2 defect. It is an interrupted
run — `next-ready` only offers `todo`, so nothing is ready and the final review can never start.

### Do

1. Establish whether `cutover/02` actually completed. Check its gate checkboxes and the flightlog, not
   its Status line.
2. Set it to `done` if it passed, `todo` if it did not.
3. Re-run autopilot so `cutover/03`, the Final review, can close the tree.

### Verify

```bash
cd /Users/funnyq/Projects/q-lab/herdr-workbench
bun <scripts>/next-ready.ts docs/rust-rewrite/tasks --json    # expect a non-empty array
```

---

## 5. Deferred from the flightdeck runs

Both were held back to keep the pending final-review diff clean. Neither is urgent; both are real.

- **Global "never touch another task's files" rule.** Currently only in
  `docs/flightdeck/tasks/_context/shared.md`, so it protects one tree. It belongs in
  `packages/dispatch/skills/autopilot/references/orchestrator.md` where every flight inherits it. Written
  after a dev driver ran `rm -rf` on a sibling task's verified, uncommitted work.
- **A completeness check in the wave loop.** The loop exits when nothing is ready and cannot distinguish
  *drained* from *stalled*. Compare `completed.length` against the tree size before returning success,
  and report a stall as an escalation. This is what would have caught item 2 on the day.

---

## Suggested order

1. Item 1 — the hook. One line plus a test; unblocks the detector for every future run.
2. Item 2 — `mark-done.ts`. Needs the two design decisions made first.
3. Item 4 — unstrand `rust-rewrite`. Independent of the others; can run in parallel.
4. Item 3 — correct the doc, now that §C has a true story to tell.
5. Item 5 — the two deferred orchestrator changes.

## What is already done

- Both stranded flightdeck tasks corrected to `done` (commit `7792026`).
- `docs/flightdeck/tasks/_context/shared.md` gained the bare-Status rule and the no-delete rule.
- `docs/flightdeck/tasks/server/01-static-serving.md` verification rescoped off a sibling task's output.
- Seven cockpit decision-trail entries recorded across both defect families.
