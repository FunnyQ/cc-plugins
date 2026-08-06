# ADR-0022: ADR triage state is filesystem location, not a JSON ledger

- Status: Accepted
- Date: 2026-08-05

## Context

Without any state tracking, every triage pass would re-judge the same
(then-)352 records, and previously-skipped candidates would resurface
forever.

## Considered alternatives

- A JSON ledger (e.g. `docs/adr/.adr-index.json`) mapping entry ID to
  disposition. Rejected: a ledger drifts from reality over time, and
  duplicates something the filesystem can already express on its own.

## Decision

The filesystem location itself is the state:

- `.cockpit/logs/` — inbox, not yet triaged.
- `.cockpit/archive/done/` — judged, does not resurface on its own.
- `.cockpit/archive/watch/` — judged, but resurfaces for re-judgment when a
  new candidate cluster matches it; a `watch` entry without a wake condition
  is just `skip` under a different folder name.

`promote` and `skip` share `done/` — whether a record became an ADR is
answered by grepping each ADR's `## Evidence` section, so a fourth bucket
would only duplicate a fact the ADRs themselves already carry. Three
constraints shape this: archiving is never deletion (promote must read back
through already-processed sessions to reconstruct cross-session decisions,
and a wrongly-written ADR must be traceable back — the whole directory is
616K, cheap to keep); granularity is file-level, not record-level (splitting
a file would touch an append-only source, and per-record tracking would
reintroduce the rejected ledger — the cost is that triaging a session means
judging every record in it, with unpromoted records defaulting to skip);
live sessions are never moved (`cockpit.ts:472`/`:587` recompute their write
path on every append, so moving a live log would cause the next write to
recreate the file at its old path, splitting one session into two — files
with an mtime inside `STALE_MS`, 10 minutes, are skipped). Verified safe:
`cockpit prune`'s replacement only scans `.cockpit/logs/` non-recursively
(`cockpit.ts:1091`) and never touches the archive.

## Consequences

This is the literal architecture the current triage run operates under.
Adding a fourth bucket, or reintroducing any ledger-style tracking, would
violate the specific reasoning above (duplicated state, drift risk) and
should be treated as a regression unless a genuinely new requirement forces
it.

## Evidence

- **A JSON ledger was rejected specifically because it would drift from
  reality** — filesystem location was chosen instead: inbox (`logs/`), done,
  and watch (with a required wake condition, or it degrades to `skip` under
  a different name) as the three buckets, with three constraints (archive ≠
  delete; file-level not record-level granularity; live sessions, mtime <
  `STALE_MS`, are never moved) shaping the exact shape. Verified against the
  code that `cockpit prune`'s replacement only scans `logs/` non-recursively.
  Session `7597db5d-c42a-4043-997f-47359b3e2a19`, entry `974611f3-9ec0-4f1b-b3f8-6a1769608903`, 2026-08-05.
