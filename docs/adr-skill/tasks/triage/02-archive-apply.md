# TRIAGE-02: Execute an approved archive plan, safely

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: triage/01
> **Blocks**: triage/04
> **Status**: done

## Goal

The one component that writes under `.cockpit/`: it executes a previously approved archive plan, treating that plan as untrusted input and re-checking every guarantee at the moment it acts.

## Files to create / modify

- `packages/chronicle/skills/adr/scripts/archive-logs.ts` (new) — the applier and its CLI
- `packages/chronicle/skills/adr/scripts/archive-logs.test.ts` (new) — its unit tests

## Implementation notes

### This is the only thing that writes under `.cockpit/`

Every other component that touches the trail reads it. The trail collector reads. The record index
reads. The judging agent reads. The planner reads and writes one temp file. This script is the
single place where anything under `.cockpit/` moves, and that is why the guard rails below are
non-negotiable rather than nice-to-have. If a rule here feels over-cautious, remember that nothing
else in the skill can catch a mistake it makes.

(The record-writing agent also writes, but only under the record directory — a different tree with
different rules. Nothing else in the skill writes to the trail.)

### Imports

Types and the planner's vocabulary come from `archive-plan.ts` in the same directory — `ArchivePlan`,
`Move`, `Refusal`, `ArchiveTarget`, `SourceBucket`. Do not redeclare them; a field added on one side
must not silently go unread on the other.

`logRoot` and `STALE_MS` come from the shared cockpit trail reader at
`packages/chronicle/shared/scripts/cockpit-trail.ts`. Import nothing from `packages/monitor/` —
plugins install into version-pinned cache directories, so a relative path between them does not
resolve on a user machine.

```ts
import { logRoot, STALE_MS } from "../../../shared/scripts/cockpit-trail";
import type { ArchivePlan, Move, Refusal } from "./archive-plan";
```

### Export surface

```ts
export type ApplyResult = { moved: number; failed: Refusal[] };

/** Structural validation of an untrusted plan. Pure apart from lstat/realpath probes. */
export function validatePlan(plan: ArchivePlan, trustedRoot: string): string[];

/**
 * The only function that touches the trail.
 * `trustedRoot` is resolved by the CALLER from cwd — never read from the plan.
 */
export function applyArchive(plan: ArchivePlan, trustedRoot: string): Promise<ApplyResult>;
```

`validatePlan` returns the list of structural problems it found; empty means the plan is executable.
Splitting it out from `applyArchive` is what makes the hostile-input cases testable without ever
letting a move run.

**The `trustedRoot` parameter is the whole security boundary, which is why it is a parameter and not
a field.** `plan.trailRoot` arrives from a JSON file anything can edit; validating a plan against its
own declared root would let a tampered plan nominate the repository it wants to be checked against,
and every path check downstream would then pass. `trustedRoot` comes from `logRoot(cwd)`, resolved by
the CLI at call time. `applyArchive` compares `plan.trailRoot` to it and aborts on a mismatch
**before** touching anything; every path check below anchors on `trustedRoot`, never on the plan's
copy.

`applyArchive` does nothing a plan did not already authorize — it walks `plan.moves` and nothing
else. It never re-globs, never expands the list, and never discovers a new candidate.

### The plan is an input, and inputs are hostile

The plan sits at a world-writable path under `/tmp` between approval and execution. The planner only
ever emits paths inside the trail, but this script never sees the planner — it sees a JSON file. So
it re-derives the legal shape rather than trusting the one it was handed.

**Validate every move first, then create anything.** The order matters and the obvious order is
wrong: on the first apply `archive/done/` does not exist yet, so `realpathSync` on a destination
parent throws, and creating the parents first would mutate `.cockpit/` before the untrusted plan had
been checked. Anchor on what does exist instead:

1. `const root = realpathSync(trustedRoot)` — the caller resolved it from cwd; it always exists, and
   it never comes from the plan. Compare `resolve(plan.trailRoot)` to it first and abort on any
   difference.
2. Realpath the **source directories**, not the source files: `join(root, ".cockpit", "logs")` for an
   `inbox` move and `join(root, ".cockpit", "archive", "watch")` for a `watch` one. Directories
   exist; individual files may not, and that difference decides the next step.
3. For each move, validate the source **lexically against its realpathed directory**:
   `dirname(resolve(move.from))` must equal that directory, and the basename must end in `.jsonl`.
   **Do not `realpathSync` the source file here.** A file that vanished between approval and apply
   would throw, aborting the whole run — but a disappearing source is exactly the `missing` refusal
   the apply-time contract says to report per-file while the rest proceeds. Structural validation
   answers "is this path legal"; the pre-move re-stat answers "is this file still there". Keeping
   them separate is what lets one plan survive a session being cleaned up under it.
   The symlink risk that skipping realpath would otherwise reintroduce is covered at move time: the
   pre-move check `lstat`s the source and refuses a symlink, so a doctored entry cannot redirect a
   read even though its path parsed as legal.
4. The destination is **derived, never trusted**: `join(root, ".cockpit", "archive", move.target,
   basename(move.from))`. Compare it to `resolve(move.to)` and reject a mismatch. Building the path
   from the validated root and the validated basename means a doctored `to` cannot reach outside the
   archive even in principle — the comparison is a consistency check on the plan, not the security
   boundary.
5. `move.target` must be exactly `"done"` or `"watch"`, and `move.fromBucket` exactly `"inbox"` or
   `"watch"`. A `fromBucket` of `"done"` is rejected — `done` is terminal and never a source.
6. **Walk the destination ancestors and reject any symlink.** Deriving the path is not enough: a
   pre-existing `.cockpit/archive`, `archive/done`, or `archive/watch` that is a symlink still passes
   step 4 — `resolve()` is lexical and never touches the filesystem — and then `mkdir` and the move
   both follow it, writing outside the trail. So `lstat` each of `.cockpit`, `archive`, and
   `archive/<target>` in turn; if one exists and `isSymbolicLink()`, abort. A component that does not
   exist yet is fine, and will be created in step 7.
7. Only once **every** move passes every check above: `mkdir -p` the destination buckets, then move.

**Reject the whole plan, do not skip the bad move.** An out-of-shape move means this is not the
object that was approved, so the run aborts non-zero having moved nothing — unlike an apply-time
`live` refusal, which is expected, reported, and skipped while the rest proceeds. Half-executing a
doctored plan is the outcome worth engineering against.

This costs a few lines and buys the property that matters most here: the only paths this script can
ever touch are inside one repository's trail, derived from the trail root it resolved itself,
regardless of what the JSON says.

### Apply re-stats; the plan authorizes, it does not certify

The plan is computed, shown to a human, and approved. That takes time — minutes, sometimes longer. A
session that was ten minutes idle when the plan was printed can be receiving writes again by the time
anyone types `--apply`. Executing the plan blindly would then move a live log, which is the exact
failure this whole flow exists to prevent, and the guard would have been checked at the one moment it
could not matter.

So `applyArchive` re-stats immediately before each move — reusing `STALE_MS` and the same
`nowMs - mtimeMs < STALE_MS` boundary the planner used — and refuses three ways: `live`, `missing`,
`collision`. Each refusal goes into the returned `failed` array and the rest of the plan proceeds.

The asymmetry between the two failure classes is the important part and worth a comment in the code:

- The plan is a **ceiling**, never a floor. Apply may move fewer files than the plan listed; it may
  never move one the plan did not list.
- A refusal at apply time is not an error. Exit code stays `0`; the refusals are reported so the
  human can re-run triage later for the sessions that were still warm.
- A structural violation from `validatePlan` **is** an error: exit non-zero, move nothing.
- `already-archived` is not re-checked at this stage — a source that vanished between plan and apply
  surfaces as `missing`, which is the honest description of what apply saw.

### CLI shape

```
bun packages/chronicle/skills/adr/scripts/archive-logs.ts --plan <plan.json> --apply
```

`--plan` and `--apply` are both required. Omitting `--apply` is a usage error rather than a dry run:
the dry run already exists as a separate script, and a second one here would invite passing raw
assignments to this file and having it recompute a plan nobody approved.

The CLI resolves the trail root from cwd itself and hands it to `applyArchive` as `trustedRoot`. It
never reads the root from the plan.

Print one line per move and one per refusal, in a shape a human can scan. Exit `0` when the plan was
structurally valid, even if every move was refused; exit non-zero only on a structural violation or a
root mismatch.

### Layout it maintains

```
.cockpit/
├── logs/<session-id>.jsonl        the inbox
└── archive/
    ├── done/<session-id>.jsonl    promote and skip both land here
    └── watch/<session-id>.jsonl   returns when new matching evidence arrives
```

`.cockpit/archive/` does not exist yet in any repository. This script creates it, with `mkdir -p`
semantics, on the first `--apply` run that has at least one validated move.

### Nothing here deletes

Moves only. No `unlink`, no `rm`, no `rmdir`, no truncation, no overwrite.

The reason is concrete: reconstructing a decision that spans an already-processed session means
reading `archive/done/` later, and a wrong record has to be correctable from its source evidence. The
whole trail is 636K across 63 files, so there is no space pressure to trade against.

A move removes the source directory entry by definition — that is not a deletion in the sense
prohibited here. The property to preserve is that every file which left a source bucket exists
byte-identical at its destination.

## Acceptance criteria

- [x] `packages/chronicle/skills/adr/scripts/archive-logs.ts` and its `.test.ts` both exist, and the
      types come from the planner module rather than being redeclared.
- [x] `applyArchive` takes the trusted root as a parameter resolved by its caller from cwd, never
      from `plan.trailRoot`, and aborts on a mismatch before touching anything.
- [x] `validatePlan` rejects, before any directory is created: a `from` whose parent is not the
      realpathed source bucket, a non-`.jsonl` basename, a `to` disagreeing with the derived
      destination, a `target` outside `done` | `watch`, a `fromBucket` outside `inbox` | `watch`, and
      an existing `.cockpit`, `archive`, or bucket directory that `lstat` reports as a symlink.
- [x] A structural violation aborts non-zero having created no directory and moved no file; an
      apply-time refusal is reported in `failed` while the rest of the plan proceeds and the exit code
      stays `0`.
- [x] The source is validated lexically against its realpathed directory, never by realpathing the
      file, so a source that vanished between plan and apply yields a per-file `missing` refusal
      instead of aborting the run; the pre-move check `lstat`s the source and refuses a symlink.
- [x] `applyArchive` re-stats each move's source and destination immediately before moving, skipping
      any that became `live`, `missing`, or a `collision` since the plan was made, and never moving a
      path the plan did not list.
- [x] The archive directories are created only after the whole plan validates, and only when there is
      at least one move to make.
- [x] Omitting `--apply`, or passing anything other than `--plan`, is a usage error; no invocation of
      this script recomputes a plan from assignments.

## Verification

- [x] `bun test packages/chronicle/skills/adr/scripts/archive-logs.test.ts` passes with zero failures.
- [x] The suite covers a tampered plan, each case aborting non-zero, creating no directory and moving
      nothing: a `from` rewritten to `../../etc/passwd`, a `to` pointing outside the archive, a
      symlinked source parent, a pre-existing `.cockpit/archive` that is a symlink pointing outside
      the trail, a `fromBucket` of `done`, and a bucket that disagrees with `move.target`.
- [x] The suite covers the plan-then-apply seam: a source that goes live between plan and apply is
      skipped and reported in `failed` while the rest proceeds and the exit code stays `0`; a source
      deleted between plan and apply yields `missing` rather than a crash; and a plan whose
      `trailRoot` does not match the current one is refused.
- [x] `grep -nE 'unlink|rm |rmdir|\brm\(' packages/chronicle/skills/adr/scripts/archive-logs.ts`
      returns nothing — the applier has no deletion path.
- [x] End to end against a scratch fixture: build a `.cockpit/logs/` holding two `.jsonl` files, one
      touched just now and one backdated an hour; run the planner to get a plan path; run this script
      with `--plan <that path> --apply`; confirm the backdated file now sits in `.cockpit/archive/done/`
      byte-identical to its original, the freshly touched file is still in the inbox and reported
      `live`, and the exit code is `0`.
- [x] `git status --short -- packages/chronicle/skills/adr/scripts/archive-logs.ts packages/chronicle/skills/adr/scripts/archive-logs.test.ts`
      shows both paths dirty.
- [x] Do NOT run `bunx tsc --noEmit`; it floods with pre-existing unrelated errors in this repo.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4 (pass) | 5 |
|---|---|---|---|---|---|
| Correctness | ×3 | A tampered plan can move a file outside the trail, or the root is taken from the plan, or a directory is created before validation, or anything is deleted. | Validation exists but one vector slips through — an unchecked ancestor symlink, or a structural violation that skips the move instead of aborting the run. | Every listed vector rejected before any directory is created; structural violations abort while apply-time refusals skip; the re-stat boundary is exact. | Also rejects a plan carrying two moves onto the same destination. |
| Test coverage | ×2 | No tests, or none that feed a hostile plan. | The happy path plus one tampering case. | Every tampering vector and both seam cases have a test, each asserting nothing was created or moved. | The hostile cases are table-driven so a new validation rule cannot land without one. |
| Interface & readability | ×1 | Validation is inlined into the move loop, so hostile input cannot be tested without executing. | Separated, but `applyArchive` re-decides or re-globs instead of walking `plan.moves`. | `validatePlan` is callable and testable on its own; `applyArchive` executes the plan and nothing more. | The two failure classes are distinguishable from the return type alone, not just by exit code. |
| Assumptions & docs | ×1 | The path checks appear without the attack they prevent, so a later reader simplifies them away. | Noted but generic. | Each check carries the concrete failure it prevents, and the re-stat carries why the plan cannot certify freshness. | The reasoning would survive a reviewer arguing the checks are paranoid. |

## Out of scope

- Producing the plan — Deferred. Reason: a sibling task owns the planner, which is where the disposition-to-move decisions and the live-session guard first apply.
- Any dry-run mode here — Deferred. Reason: the planner is the dry run; a second one in this file would invite recomputing a plan nobody approved.
- Deciding which sessions get which target — Deferred. Reason: the judging agent produces the assignments and a human confirms them before this script is ever called.
- Any pruning, expiry, or deletion mechanic — Deferred. Reason: the whole trail is 636K, nothing fails without it, and the archive must stay readable so a decision spanning an already-processed session can still be reconstructed.
