# ADR-0014: Autopilot live-mode wait caps at one 9-minute foreground call

- Status: Accepted
- Date: 2026-07-31

## Context

Autopilot's live dev engine wait had a 15-minute patience window. The cheap
driver model behind live delegation (`MODEL.devExternal`, Haiku) needed a
wait strategy that would not invite improvisation on timeout.

## Considered alternatives

- Keep the 15-minute window and teach the driver a background-poll protocol:
  `run_in_background`, then stop polling and wait for a completion
  notification before reading the output file. Rejected: the cheapest model
  is the most likely to improvise; a background protocol requires it to "do
  nothing after sending," and a missed notification produces a silent stall
  that is harder to diagnose than idle spinning.

## Decision

Cap the wait at 540000 ms (9 minutes) as a single foreground call. This is
deterministic — the driver has no room to improvise around it — at the cost
of reduced live-pane patience (15 → 9 minutes).

## Consequences

A task that cannot complete within 9 minutes in live mode is treated as too
large; the existing retry/escalation path absorbs the timeout cost (relay
prints PENDING, the attempt is judged failed, then retried or escalated to
Claude-Opus). This decision is the reliability contract every live-dev-engine
session runs under, and interacts directly with the `relay collect`
continue-waiting behavior in ADR-0015, which changed what "PENDING" means for
the driver after this cap was set.

## Evidence

- **A background-poll protocol was rejected specifically because of the model
  tier** — the live dev driver runs on the cheapest model (Haiku), which is
  judged most likely to improvise on an ambiguous "wait silently" protocol; a
  deterministic single foreground call with a hard 9-minute cap removes that
  failure mode entirely, at the cost of the pane's overall patience dropping
  from 15 to 9 minutes.
  Session `f20b29a7-c2c3-4431-9254-fd498d86391e`, entry `96e5941c-5e2a-4a22-9993-66b9bb9fa715`, 2026-07-31.
