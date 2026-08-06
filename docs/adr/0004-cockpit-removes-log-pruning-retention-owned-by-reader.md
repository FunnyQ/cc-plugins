# ADR-0004: Cockpit removes log pruning; retention becomes the reader's responsibility

- Status: Accepted
- Date: 2026-08-05

## Context

`cockpit prune` deleted `.cockpit/logs/*.jsonl` files older than a default
threshold. Registry entries were separately reaped on every write, independent
of file deletion, which had already produced 53 orphaned log files with no
matching registry entry. Once `.cockpit/logs/` became the inbox for the
`chronicle:adr` triage pipeline, this same directory gained a second owner
with an incompatible mental model: prune wanted to delete on a schedule,
triage needed the raw material to survive until judged.

## Considered alternatives

- Fix the immediate bug (registry reaps entries but never reaps orphaned
  files) and leave `prune` in place on its 14-day schedule. Implemented first,
  as a genuine bug fix: two passes, one that scans each project root's files
  (tracked or orphaned) and trashes stale ones, one that drops dangling
  registry entries whose file is already gone.
- Do nothing and let triage race the 14-day window. Rejected: one missed
  triage pass means permanent, silent data loss.
- Extend the default retention window or require confirmation before pruning.
  Rejected: preserves monitor's self-sufficiency but the directory still has
  two owners with different mental models.
- Remove `cockpit prune` entirely. Adopted, in a second decision made after
  the bug fix landed and the triage pipeline was designed.

## Decision

`cockpit prune` was fixed once (closing the orphan-file gap with a two-pass
planner, `prune-plan.ts`, plus 9 tests), then removed entirely a month later
once the triage inbox design made the ownership conflict explicit. Cockpit now
only ever writes to `.cockpit/logs/`; retention is a reader's decision, owned
today by `chronicle:adr`. Removal deleted `prune-plan.ts`, its tests,
`commands/prune-logs.md`, and `cmdPrune` / `trashFiles` / `scanLogFiles` /
`PRUNE_USAGE` plus their dispatch case and usage string in `cockpit.ts`, a net
124-line reduction. The CHANGELOG's historical `prune-logs` entry is left
untouched — it records what genuinely shipped at the time.

## Consequences

`cockpit prune` now exits 1 as an unknown subcommand; no other subcommand is
affected (403 tests pass across 30 files). The old prune command scanned every
registered project root globally, a cross-repo cleanup; its replacement (the
triage pipeline) only ever processes the current repo, so logs in repos that
are never triaged will accumulate indefinitely with no tool to manage them.
At ~10K/session and 616K across 61 files at time of removal, this is not yet
a practical concern. Removing a previously-shipped CLI subcommand is a
breaking change and required a monitor version bump via `/chronicle:release`.

## Evidence

- **Registry reaped entries but never reaped the files behind them** — the
  registry auto-reaps entries older than 14 days on every write, but the
  underlying `.cockpit/logs/*.jsonl` files never disappeared on their own;
  combined with entries already reaped, this produced 53 orphaned log files.
  A two-pass planner (scan disk, then drop dangling entries whose file is
  gone) closed the gap; deletion goes through `trash`, never `rm`.
  Session `dae771b2-621b-4070-8660-6753ffc50367`, entry `3a0b9fff-08d8-4cfa-97fa-14143ed4aff0`, 2026-07-07.
- **The fixed prune command still had two incompatible owners of one directory** —
  once `.cockpit/logs/` became the triage inbox, a 14-day auto-delete could
  destroy records before they were ever judged. `cmdPrune` and its supporting
  code were removed outright (net -124 lines in `cockpit.ts`); cockpit now only
  writes logs, and retention is entirely the triage pipeline's call. Verified
  with 403 passing tests; `cockpit prune` now exits 1 as unknown.
  Session `7597db5d-c42a-4043-997f-47359b3e2a19`, entry `b451614c-7b74-4488-aac2-285b3fdc6dc2`, 2026-08-05.
