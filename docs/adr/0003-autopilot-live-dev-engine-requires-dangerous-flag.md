# ADR-0003: Autopilot's live dev engine requires --dangerous to run in a visible pane

- Status: Accepted
- Date: 2026-07-07

## Context

autopilot's dev step could only run an external engine (codex/opencode)
headless, through an `<engine>-run.ts` wrapper. A visible mode was wanted so a
human could watch the engine work in a live herdr pane via relay.

## Considered alternatives

- Ship the visible-pane path without requiring `--dangerous`. Rejected: the
  wave loop runs unattended, and an approval prompt inside the pane has nobody
  to answer it — without YOLO mode the run stalls until the wait-timeout fires.

## Decision

Add an opt-in `liveDevEngine` config flag (default `false`, headless remains
the default) plus `relayPath` (empty forces headless). When both are set and
`HERDR_ENV=1`, the dev driver delegates via
`relay.ts <engine> delegate --git-scope none --dangerous` instead of the
headless wrapper. Failure detection branches accordingly: headless relies on
an `UNREACHABLE` token plus git-status; live relies on non-zero exit or an
empty result, since neither of the headless signals exists in the live path.
The review lens stays headless unconditionally.

## Consequences

Live mode trades unattended safety for visibility: `--dangerous` is a
deliberate, explicit cost of running without a human to approve prompts, not
an oversight. This decision underlies two later ones that build on the same
live-pane path: capping the live-mode wait at a single 9-minute foreground call
(ADR-0014), and letting a timed-out pane keep waiting through a `relay collect`
reattach rather than failing at the cap (ADR-0015).

## Evidence

- **Visible live mode only works with YOLO** — the dev step gained an opt-in
  path (`liveDevEngine` + `relayPath` + `HERDR_ENV=1`) that runs external
  engines in a visible herdr pane via `relay.ts ... --dangerous`, replacing the
  headless wrapper; headless stays the byte-identical fallback and the review
  lens never uses the live path.
  Session `8b71fd9a-6dfc-4201-b04a-01998e3bd207`, entry `5a23c990-11d7-4aec-8a53-517de6a41db4`, 2026-07-07.
