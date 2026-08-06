# ADR-0018: Flightplan write boundary keeps PLAN.md and _context on the main agent

- Status: Accepted
- Date: 2026-08-02

## Context

The original request was to write both `PLAN.md` and the `tasks/` tree
entirely via forked subagents.

## Considered alternatives

- Fork every write, including `PLAN.md` and `_context/*.md`. Rejected on two
  grounds: `_context/` is a contract every task file jointly relies on, and a
  single author avoids it drifting between forks; `PLAN.md` is already
  finalized by the time plan mode ends, so writing it is pure transcription
  with no benefit from outsourcing. A fork also only inherits parent context
  at the moment it is spawned — if a fork wrote the contract, its content
  would exist only on disk, and the next wave's forks would need to open and
  read the file themselves instead of receiving it for free via spawn-time
  context inheritance.

## Decision

Split into three waves: the main agent writes `PLAN.md` and `_context/*.md`
directly; only `tasks/<bucket>/NN-*.md`, one file per fork, fans out to
parallel forks; lint and `build-readme` return to the main agent. A fallback
to fully sequential main-agent writing applies when task count is ≤3 (spawn
cost exceeds benefit) or when flightplan itself is running inside a subagent
(a fork is a leaf node and cannot spawn further). Batches greater than ~10
tasks fan out per bucket.

## Consequences

Every task-file fork receives the `_context/` contract for free at spawn
time, since the main agent wrote it before any fork launches — no fork needs
to read it from disk separately. This is the core file-writing architecture
for every flightplan run; any future change to what gets forked must
re-justify itself against the same two constraints (contract drift, and
context inheritance timing).

## Evidence

- **Forking the contract file would have made it invisible to later waves** —
  a fork inherits parent context only at spawn time; if `_context/` were
  fork-written, its content would exist only on disk and the next wave's
  forks would need to read it themselves rather than receive it automatically.
  Main agent now writes `PLAN.md` and `_context/*.md`; only per-task files
  fan out, with an explicit fallback to sequential writing at ≤3 tasks or
  when flightplan itself runs inside a subagent.
  Session `9d4e34b8-d8b4-423e-b99d-b2a707742389`, entry `0b4cbdf8-d8b2-461a-b85c-6e8605ea0d67`, 2026-08-02.
