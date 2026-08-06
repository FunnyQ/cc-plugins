# ADR-0015: Relay pending timeout continues waiting via relay collect

- Status: Accepted
- Date: 2026-07-31

## Context

Relay's `pending` outcome was previously treated as a failure once the wait
window elapsed. `pending` had never actually meant failure: before timing
out, relay rechecks the pane's state, and only reports a true failure when
the pane has settled with no verified result file — `pending` specifically
means the pane is still actively writing.

This decision supersedes an earlier, separate call to accept "double-write"
risk on PENDING rather than close the live pane on timeout. That earlier
decision is not itself recorded as an ADR (it predates this triage's scope),
so no formal `Superseded by` link exists here — it is recorded only as
context for why this decision's shape looks the way it does.

## Considered alternatives

- Have the driver run `herd wait` directly inside its own prompt. Rejected —
  has its own pitfalls, recorded separately in the trail as a caveat, not
  reused here.
- Raise `--wait-timeout` directly. Rejected: blocked by the Bash tool's hard
  600-second ceiling.
- Keep treating timeout as failure (the status quo this ADR replaces).
  Rejected: on a still-working pane, a second writer is spun up onto the same
  worktree the first writer is still modifying — the double-write risk the
  earlier, superseded decision had accepted rather than closed.

## Decision

Add a top-level `relay.ts collect --agent <name> --result <path>` subcommand,
sibling to `config` rather than a new delegation Mode, since polling an
existing pane needs no backend, prompt, or model. `live.ts` factors its
polling loop into `pollForResult(herd, ctx, deps)`, shared by both
`runLive` (spawn) and `collectLive` (reattach) so both use identical
settled-detection. The pending report now prints the exact `collect` command
to run. Autopilot adds `CFG.liveCollectRounds` (default 3); the dev driver
gains a step 5 "PENDING" that continues waiting up to 3 more 8-minute windows
(~32 minutes total) before falling through to failure on 5b.

## Consequences

A second writer is no longer spun up while the first is still working —
`pending` now means "keep waiting on the same writer," not "assume it died."
The double-write risk the earlier decision had accepted is closed by removing
its precondition (a parallel retry) rather than by shortening the live
pane's lifetime. Any future live-mode timeout logic must route through
`pollForResult` rather than reimplementing settled-detection, or it will
diverge from both `runLive` and `collectLive`.

## Evidence

- **PENDING never meant failure; it meant "still writing"** — relay's
  pre-timeout recheck distinguishes a settled-but-unverified pane (true
  failure) from a still-working one (pending); treating the latter as failure
  risked a second writer starting on a worktree the first was still
  modifying. `relay collect` plus a shared `pollForResult()` let autopilot's
  dev driver continue waiting up to 3×8-minute rounds (~32 min) before
  falling through to failure, replacing the prior accept-double-write-risk
  decision by removing its precondition entirely.
  Session `f20b29a7-c2c3-4431-9254-fd498d86391e`, entry `ce38c32c-7f6e-462c-b5b9-c9c4bedb504e`, 2026-07-31.
