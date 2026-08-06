# ADR-0011: Split cockpit trail logs merge by record-id union, re-sorted by timestamp

- Status: Accepted
- Date: 2026-07-28

## Context

A single session whose cwd drifts can write into both a repo-root trail and a
subdirectory trail at once. Files with the same name in this situation are
not duplicates of each other — they are two complementary halves of one
history.

## Considered alternatives

- Move or overwrite one file with the other. Rejected: either operation
  discards whichever half is not kept.

## Decision

Merge per file by taking the union of records keyed by record ID (falling
back to the full line as the key when an ID is missing), then re-sort the
union by timestamp so the merged trail still reads in chronological order.
The merged trail is backed up in full before any write; a subdirectory
`.cockpit` is removed via `trash`, not `rm`; registry entries pointing at the
subdirectory are repointed to the repo root.

## Consequences

This algorithm is not visible from any single code path — a reader looking at
either trail-writing site alone would not infer that a merge step exists.
Anyone touching cockpit's log-write path in the future needs to know this
repair mechanism exists so they do not reintroduce a naive overwrite.

## Evidence

- **Split trails were measured as complementary, not duplicate** — real
  before/after counts (5+3→8, 10+4→14, 7+3→10 records; one file 0+3→3 was a
  pure move) showed no record was ever deduplicated away by ID, confirming
  the two halves genuinely didn't overlap. Full backup precedes the write;
  the subdirectory `.cockpit` is removed via `trash`.
  Session `82327df5-6355-45c3-8550-3facb7b7aac9`, entry `872f3bb1-5fc3-4e04-ad65-7358ccb0dc83`, 2026-07-28.
