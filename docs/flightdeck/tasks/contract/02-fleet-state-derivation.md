# CONTRACT-02: fleet and task state derivation

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Blocks**: server/04, wiring/04
> **Status**: done

## Goal

Pure functions that turn a parsed task tree plus a flightlog into the three things the UI actually
renders: derived task state, parsed agent identities, and a fleet of agent rows.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (new) — the exported pure functions. This is
  the first file in autopilot's new `scripts/` directory.
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (new) — `bun test` over every function.

## Implementation notes

This module is **pure**. It reads no files, touches no clock, and prints nothing. Everything it needs
arrives as arguments. That is what makes the derivation testable without fixtures on disk.

All three exported functions, the full type list, the agent-label taxonomy table, and the derivation
precedence rules are specified in the data model context file listed in Required reading. Implement
exactly those signatures. The notes below cover only what that file does not.

### Import surface

```ts
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { refToString } from "../../flightplan/scripts/lib/parse-task";
import type { FlightlogEntry, ScoreEntry } from "../../flightplan/scripts/lib/flightlog";
```

Nothing else. Do not import from `packages/monitor`.

### `parseAgentLabel` — order matters

Match the engine-prefixed dev form **before** the bare dev form. A regex alternation that puts `dev:`
first will consume the prefix of an engine-prefixed label and drop it to `unknown`.

A single regex per shape is clearer than one combined pattern:

```ts
// dev-codex:<ref>#<n>  and  dev-opencode:<ref>#<n>
const DEV_ENGINE = /^dev-([a-z]+):(.+)#(\d+)$/;
// dev:<ref>#<n>
const DEV = /^dev:(.+)#(\d+)$/;
```

The ref segment is `.+` deliberately: a ref contains a slash, so a stricter character class invites a
mistake. Attempt is always the trailing `#<digits>`.

Labels an agent writes itself, rather than the orchestrator generating them, must not throw:

- an engine delegate label of the form `<engine>-delegate`
- anything an agent substituted for its prompt's label placeholder

Return `{ role: "unknown", raw: label }` for those. Also return that for an empty string.

### `deriveTaskViews` — the ordering trap

Apply the six precedence rules in the order the data model states them. The one that is easy to get
wrong is rule 4: a task whose file still says `todo` but which has an unmatched start entry is
**in-progress**, not ready. Autopilot writes `Status: done` only at the very end of a task, so during
the entire dev → verify → judge loop the file says `todo`. Getting this wrong makes every running task
render as idle.

"Unmatched start" is defined per `(ref, role, attempt)` triple, not per ref. A task on its second
attempt has a finished first-attempt dev entry and an open second-attempt one; only the open one counts.

`blockedBy` lists dependency refs whose upstream task is not `done`. It must be empty for every state
other than `blocked`. A dependency that does not exist in the tree counts as not done, and its ref
still appears in `blockedBy` — a dangling dependency should be visible, not silently treated as
satisfied.

`attempts` is the highest attempt number seen for that ref across all entries, or `0` when the log has
nothing for it. `latestScore` is the score entry with the highest attempt for that ref, or `null`.

### `aggregateFleet` — pairing and ordering

Pair a start with its end on `agentLabel` when both carry one. When `agentLabel` is absent, fall back
to the `(task, role, attempt)` triple. An unpaired start stays `in-flight` with `elapsedMs` undefined.

Compute `elapsedMs` as the difference between the two ISO timestamps. Never read the wall clock — a
function that calls `Date.now()` cannot be tested deterministically and would drift between the server
and the browser.

Attach a score entry to a row when it shares that row's ref and attempt. A judge row therefore carries
the verdict it produced.

Ordering is specified in the data model file listed in Required reading. The part that is easy to get
wrong: the fixture trail on disk has **no start entries**, so every row sorts on the `endedAt` fallback.
A sort keyed on `startedAt` alone leaves that entire fixture in an arbitrary order, and two executors
would produce different output from the same input.

### Tolerance

Every function must survive a malformed log. The parser upstream already drops unreadable lines, but an
entry can still be structurally valid and semantically odd: a note with no `agentLabel`, a score for a
ref that is not in the tree, an end with no matching start. None of these may throw. An end with no
start produces a `finished` row with no `startedAt` and no `elapsedMs`.

## Acceptance criteria

- [x] `parseAgentLabel` returns the documented shape for every label form in the taxonomy table, and
      `{ role: "unknown" }` for an unrecognised or empty label, without throwing.
- [x] An engine-prefixed dev label parses as role `dev` with the ref and attempt intact.
- [x] `deriveTaskViews` returns `in-progress` for a `todo` task with an unmatched start entry.
- [x] `deriveTaskViews` returns `blocked` with a populated `blockedBy` for a task with an unfinished
      dependency, and lists a dangling dependency ref rather than ignoring it.
- [x] `blockedBy` is empty for every task whose state is not `blocked`.
- [x] `aggregateFleet` pairs start and end entries, computes `elapsedMs` from the timestamps only, and
      leaves an unpaired start `in-flight`.
- [x] In-flight rows sort ahead of finished rows.
- [x] Rows with no `startedAt` sort deterministically on `endedAt`, with first-appearance order breaking
      exact ties. A log of completion-only entries produces the same order on every run.
- [x] Row keys are unique, including for entries with no agent label.
- [x] No function in this module reads a file, calls the clock, or writes to stdout.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts` — all green.
- [x] Confirm purity mechanically: `rg -n "Date\.now|new Date\(\)|readFile|console\." packages/dispatch/skills/autopilot/scripts/fleet.ts` returns nothing.
- [x] Confirm no cross-plugin import: `rg -n "packages/monitor|\.\./\.\./\.\./monitor" packages/dispatch/skills/autopilot/scripts/fleet.ts` returns nothing.
- [x] Feed a real trail through `aggregateFleet` in a scratch script and confirm it returns rows
      without throwing: use `docs/chronicle/.flightlog/run.jsonl`, which contains real score and note
      entries and no start entries at all.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A label form parses wrong, or a running task derives as ready | Common cases right but the engine-prefixed label, the dangling dependency, or the per-attempt pairing is wrong | Every taxonomy form parses, all six precedence rules apply in order, pairing is per-attempt, malformed entries never throw |
| Test coverage | ×2 | No tests | Happy path per function only | Every label form, each of the four states, unpaired start, end-without-start, several completion-only rows ordering deterministically, key collision, score for an unknown ref, empty log |
| Interface & readability | ×1 | Functions read files or call the clock | Pure but signatures drift from the specified types | Exactly the specified signatures, no I/O, no clock, composable |
| Assumptions & docs | ×1 | The dev-prefix ordering trap is undocumented | Noted but not explained | Comments explain *why* the engine form matches first and *why* elapsed comes from timestamps |

## Out of scope

- Serving any of this over HTTP. Deferred to the server bucket, which imports these functions.
- Reading the task tree or the log file from disk. This module receives already-parsed inputs; the
  loading happens in the server layer.
- A staleness ceiling on in-flight rows. Deferred. Reason: v1 accepts that an agent which dies without
  an end entry reads as in flight until the run ends.
