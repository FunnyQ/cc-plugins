# ADR-0017: herd wait keeps its idle default, adds done and array support

- Status: Accepted
- Date: 2026-08-02

## Context

A proposal considered changing `wait()`'s default status from `idle`-only to
align with herdr's own bare `agent wait` default of `idle|done|blocked`. This
was sent to `/codex review` and rejected there, with each rejection reason
independently verified against the actual code, not accepted at face value.

## Considered alternatives

- Change the default to `idle|done|blocked`. Rejected: today, this is a
  no-op — all three call sites already pass `idle` explicitly
  (`herd.ts:473` spawn's settle-before-send, `relay/live.ts:539`, and the CLI
  at `herd.ts:643`). Changing it affects no existing caller and only lays a
  trap for future callers who omit the argument.
- Include `blocked` in a completion-semantics default. Rejected: `blocked`
  means the agent is stopped waiting on human approval; returning on
  `blocked` would treat a pane that cannot advance on its own as "done," to
  an unattended caller.
- Split out a separate `finished` verb (codex's suggestion). Rejected by Q;
  relay keeps its existing `collect`, which additionally validates a
  result-file marker that a status-only wait cannot replace.

## Decision

Keep the `idle` default unchanged. Add `done` to the status union type, add
array support so `status` accepts a list expanded into repeated `--until`
flags, and add `REPEATABLE_FLAGS` to `parseArgs` to support it.

## Consequences

`wait()`'s default behavior is unchanged for every existing caller;
`herd.ts`, `relay/live.ts`, and the CLI keep working exactly as before. Any
future caller that wants completion-inclusive semantics must pass status
explicitly (including the new `done`) — the default will never silently
include it. This is herdr's public API contract, consumed directly by relay
and dispatch.

## Evidence

- **All three real call sites already pass `idle` explicitly** — changing the
  default today would be a no-op for existing code and only a trap for future
  callers; `blocked` was rejected from any completion default because it
  represents a pane stalled on human approval, not one that has finished.
  Scope actually shipped: `done` added to the type union, array support for
  `status` expanded to repeated `--until`, and `parseArgs`'s new
  `REPEATABLE_FLAGS`.
  Session `0a5b24d4-1e03-4f37-bf99-ef39614c6dbc`, entry `46d084de-922d-4237-9275-b45cd20a555e`, 2026-08-02.
