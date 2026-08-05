# TRIAGE-01: Plan an archive move set

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: foundation/01
> **Blocks**: triage/02, triage/03
> **Status**: todo

## Goal

Turn a list of per-session dispositions into a serialized, human-reviewable archive plan — deciding what may move and what may not, and writing nothing to the trail.

## Files to create / modify

- `packages/chronicle/skills/adr/scripts/archive-plan.ts` (new) — the planner, its types, and the planning CLI
- `packages/chronicle/skills/adr/scripts/archive-plan.test.ts` (new) — its unit tests

## Implementation notes

### This script has no apply path, by construction

The archive flow is two scripts on purpose. This one decides; a separate one executes. There is no
`--apply` flag here, no `rename`, no `mkdir` under `.cockpit/` — not gated behind a check, simply
absent. An agent that is supposed to be read-only can be handed this script and the guarantee is
structural rather than a promise in its instructions.

The consequence for testing is the good kind: nearly everything in this file is a pure function over
injected facts, so the whole decision matrix is a table test with no temp directory.

### Imports

It imports `logRoot` and `STALE_MS` from the shared cockpit trail reader at
`packages/chronicle/shared/scripts/cockpit-trail.ts`:

```ts
import { logRoot, STALE_MS } from "../../../shared/scripts/cockpit-trail";
```

It must not re-derive either value, and it must not import anything from `packages/monitor/` —
plugins install independently into version-pinned cache directories, so a relative path between them
does not resolve on a user machine.

### The live-session guard is the reason this task exists

Cockpit resolves the log path on **every single write**. Moving an active session's log makes the
very next write recreate an empty file at the original path, splitting one session across two
files — silently, with no error, and invisibly afterwards. Nothing reports it and nothing repairs it.

So: refuse any file whose mtime is within `STALE_MS` (`10 * 60 * 1000`, ten minutes) of now.

The boundary is `nowMs - mtimeMs < STALE_MS` → refuse. A file exactly `STALE_MS` old is stale enough
to move. Both `mtimeOf` and `nowMs` are injected, so a test drives the boundary directly instead of
sleeping.

This guard runs again at apply time, in the other script, because the plan sits waiting for a human.
Checking it here is not redundant — a session that is live now should never reach a human's screen as
a proposed move.

### Export surface

```ts
export type ArchiveTarget = "done" | "watch";

/** Where the session sits now. Watched sessions are legal sources — see the wake path below. */
export type SourceBucket = "inbox" | "watch";

export type Assignment = {
  sessionId: string;
  target: ArchiveTarget;
  from: SourceBucket;   // defaults to "inbox" when the caller omits it
};

export type Move = {
  from: string;
  to: string;
  target: ArchiveTarget;
  fromBucket: SourceBucket;
};

export type Refusal = {
  sessionId: string;
  reason: "live" | "missing" | "collision" | "already-archived" | "no-op";
  detail: string;
};

export type ArchivePlan = { trailRoot: string; moves: Move[]; refused: Refusal[] };

export type PlanDeps = {
  nowMs: number;
  mtimeOf: (path: string) => number | null;   // null when the file is absent
  exists: (path: string) => boolean;
};

/** Pure. No filesystem access — everything comes through deps. */
export function planArchive(
  trailRoot: string,
  assignments: Assignment[],
  deps: PlanDeps,
): ArchivePlan;

/** Writes the plan to a temp path and returns it. The only write this module performs. */
export function writePlan(plan: ArchivePlan): Promise<string>;
```

These types are the shared vocabulary for the whole archive flow. The applier imports them from
here rather than redeclaring them, so a field added on one side cannot silently go unread on the
other.

### Refusal cases

Every refused session carries one of these five reasons. None of them throws; a refusal is data,
returned in `plan.refused`, so the caller can show a human what was skipped and why.

- `live` — mtime within `STALE_MS` of `nowMs`. The common case, and the one that matters. `detail`
  should carry the age in seconds so a human can see how close it was.
- `missing` — no file for that session id in its declared source bucket (`mtimeOf` returned `null`).
- `collision` — a file of that name already exists at the destination. Refuse; **never overwrite**.
  A destination collision means two different sessions share an id, or a previous partial run landed
  a file there. Either way, silently clobbering loses an append-only source.
- `already-archived` — the session is already sitting in `archive/done/` and absent from both the
  inbox and the watched bucket. `done/` is terminal, so this is a **no-op, not an error**: re-running
  triage over the same assignments must be safe, because the judging step is allowed to be retried.
- `no-op` — the source is already in the bucket it was assigned to. A watched session re-judged
  `watch` stays put; there is nothing to move and nothing wrong.

### Watched sessions are a legal source, because the wake path needs them to move

The obvious model — every source lives in `.cockpit/logs/` — cannot express the one transition the
watched bucket exists for. A session parked in `watch/` returns when fresh matching evidence
arrives, gets re-judged against the combined evidence, and may then be settled. Settling it means
moving it to `done/`. If the planner only ever reads from the inbox, that move has no representation
and the watched bucket becomes a one-way trip — exactly the "`skip` with a nicer name" failure the
design set out to avoid.

So `Assignment.from` names the current bucket, defaulting to `"inbox"`. The legal transitions:

| From | To | Meaning |
|---|---|---|
| `inbox` | `done` | dispositioned `promote` or `skip` |
| `inbox` | `watch` | promising, not yet stable |
| `watch` | `done` | woken, re-judged, now settled |
| `watch` | `watch` | woken, re-judged, still unsettled — a `no-op` refusal, not a move |

`done` is terminal and never a source. Nothing re-queues from it, and nothing needs to: the drafting
path reads it in place.

The live-session guard applies to both sources. A watched file's mtime is normally old, but the
check is unconditional — cheap, and the one time it matters is the time nobody predicted.

### The plan is an artifact, not a printout

```
bun packages/chronicle/skills/adr/scripts/archive-plan.ts --assignments <assignments.json>
```

Writes the `ArchivePlan` JSON to a path under `/tmp/chronicle/adr/`, creating that directory if
absent, and prints the path — the way the branch analyzer already hands large payloads to an agent.
Exit code `0`.

Serialization is the `ArchivePlan` type verbatim — `trailRoot`, `moves`, `refused` — with **no
envelope**. A human can read the file, and a test can round-trip it through `JSON.parse` and compare
structurally.

It has to persist rather than merely print, because the object a human approves must be the same
object that later executes. A plan recomputed after approval is a different plan, and the
confirmation gate would be decorative.

`trailRoot` comes from `logRoot(cwd)` and is written into the plan. The applier does **not** trust
that field — it resolves its own root and compares — but recording it is what makes the mismatch
detectable at all.

### The no-write rule is scoped to the trail, and the scope is the point

This script writes exactly one thing: the plan artifact under `/tmp/chronicle/adr/`, plus that
directory if it is absent. It never creates, moves, or touches anything under `.cockpit/` — not
`archive/`, not `done/`, not `watch/`, not a single log file.

"The planner writes nothing at all" is the wrong sentence for this, and stating it that way would
force whoever implements it into a contradiction. Assert the real guarantee instead: **nothing under
`.cockpit/` changes.**

### Layout it plans against

```
.cockpit/
├── logs/<session-id>.jsonl        the inbox
└── archive/
    ├── done/<session-id>.jsonl    promote and skip both land here
    └── watch/<session-id>.jsonl   returns when new matching evidence arrives
```

`.cockpit/archive/` does not exist yet in any repository. This script does not create it — it plans
moves into it, and the applier creates it on first use.

### Nothing here deletes, and nothing downstream does either

Moves only. No `unlink`, no `rm`, no `rmdir`, no truncation. The reason is concrete: reconstructing a
decision that spans an already-processed session means reading `archive/done/` later, and a wrong
record has to be correctable from its source evidence. The whole trail is 636K across 63 files, so
there is no space pressure to trade against.

## Acceptance criteria

- [ ] `packages/chronicle/skills/adr/scripts/archive-plan.ts` and its `.test.ts` both exist, and the
      file contains no `--apply` flag, no `rename`, and no `mkdir` targeting `.cockpit/`.
- [ ] `planArchive` performs no filesystem access — every fact about the disk arrives through the
      injected `PlanDeps`.
- [ ] A session whose mtime is within `STALE_MS` of `nowMs` is refused `live` and never appears in
      `plan.moves`; one exactly `STALE_MS` old is planned.
- [ ] A destination collision is refused `collision`; the plan never proposes overwriting a file.
- [ ] Each bucket state resolves to its own outcome: a session in `archive/done/` is refused
      `already-archived`; one in `archive/watch/` re-assigned `watch` is refused `no-op`; one in
      `archive/watch/` assigned `done` is **planned as a move**, because that is the wake path
      settling a session.
- [ ] Running the CLI writes a plan file under `/tmp/chronicle/adr/`, prints its path, exits `0`, and
      leaves everything under `.cockpit/` byte-identical.
- [ ] The written plan round-trips: `JSON.parse` of the file deep-equals the `ArchivePlan` returned
      by `planArchive`, with no wrapper object.
- [ ] No code path calls `unlink`, `rm`, `rmdir`, or any other deletion primitive.

## Verification

- [ ] `bun test packages/chronicle/skills/adr/scripts/archive-plan.test.ts` passes with zero
      failures, covering: mtime exactly at the `STALE_MS` boundary and one millisecond either side, a
      missing session id, a destination collision, all four rows of the transition table, a repeated
      run over the same assignments, and a plan that round-trips through JSON.
- [ ] `grep -nE 'unlink|rmdir|renameSync|--apply' packages/chronicle/skills/adr/scripts/archive-plan.ts`
      returns nothing — the planner has no execution path at all.
- [ ] Build a temporary fixture trail in a scratch directory (a `.cockpit/logs/` holding two `.jsonl`
      files, one touched just now and one backdated an hour). Record `md5` of both, run the script
      against it, then confirm both sums are unchanged, both files are still in the inbox, no
      `.cockpit/archive/` was created, and the printed plan path holds valid `ArchivePlan` JSON
      listing exactly one move and one `live` refusal.
- [ ] `git status --short -- packages/chronicle/skills/adr/scripts/archive-plan.ts packages/chronicle/skills/adr/scripts/archive-plan.test.ts`
      shows both paths dirty.
- [ ] Do NOT run `bunx tsc --noEmit`; it floods with pre-existing unrelated errors in this repo.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4 (pass) | 5 |
|---|---|---|---|---|---|
| Correctness | ×3 | Any execution path exists, or a live session is planned as a move, or something under `.cockpit/` changes. | The guard exists but the boundary is off by one, or a transition-table row is wrong, or a repeated run errors instead of no-opping. | All five refusal reasons produced correctly, the boundary exact on both sides, every transition row right, and `.cockpit/` provably untouched. | Also handles an assignment naming a session id that appears in two buckets at once. |
| Test coverage | ×2 | No tests, or none that exercise a refusal. | Only "a live file is refused" — the boundary asserted from one side. | The boundary from both sides plus the exact-`STALE_MS` case; every refusal reason and every transition row covered; the JSON round-trip asserted. | Table-driven over the transition matrix so a new row cannot be added without a case. |
| Interface & readability | ×1 | `planArchive` reaches the filesystem, so the decision logic needs a temp directory to test. | Pure, but the refusal reasons are strings rather than a closed union, or `PlanDeps` leaks a concrete `fs` type. | `planArchive` pure over `PlanDeps`; refusal reasons a closed union; the types read as the shared vocabulary the applier will import. | A reader can reconstruct the whole decision matrix from the types alone. |
| Assumptions & docs | ×1 | `STALE_MS` appears as a bare number with no source. | Imported, but the reason for the guard is not written down. | A comment states why moving a live log splits a session, and the ported constant names its source of truth. | Also records why the guard is re-checked downstream rather than trusted from here. |

## Out of scope

- Executing the plan — Deferred. Reason: a sibling task owns the applier, along with the untrusted-input hardening that only matters once a plan is being executed rather than produced.
- Deciding which sessions get which target — Deferred. Reason: the judging agent produces the assignments and a human confirms them; this script only turns an approved list into a legal move set.
- Any pruning, expiry, or deletion mechanic — Deferred. Reason: the whole trail is 636K, nothing fails without it, and the archive must stay readable so a decision spanning an already-processed session can still be reconstructed.
- Splitting a session file per entry — Deferred. Reason: archiving granularity is the whole session file; splitting would mutate an append-only source, and per-entry tracking would reintroduce the ledger the inbox model exists to remove.
