# ADR-0013: needs_your_call gates on explicit intent plus subscriber liveness

- Status: Accepted
- Date: 2026-07-28

## Context

Presence was originally inferred from browser tab visibility. This premise
was empirically falsified: `document.hidden` stays `false` when another
application window covers the browser — a minimized window still reports the
tab as visible, so visibility inference alone is unreliable.

## Considered alternatives

- Window focus/blur plus a recency timestamp on mouse and keyboard activity.
  Rejected: more code, threshold parameters that need tuning, and still
  fundamentally a guess at a person's attention rather than a fact.

## Decision

Require two independent factors, both mandatory:

- **Intent** — `answer_here`, a global boolean in the XDG config, default
  off. Set via the dashboard toggle or `cockpit config --answer-here on|off`.
- **Liveness** — `hasVisibleSubscriber()` (ADR-0012). Cannot be dropped: with
  the toggle on but no browser tab connected, a `park` would hang forever.

When either factor is absent, `/api/wait` refuses and returns a `reason`
(`toggle_off` or `no_tab`); `cockpit wait` exits 4 in both cases, naming which
factor blocked it.

## Consequences

Every `needs_your_call` gate check must evaluate both factors; neither alone
is sufficient (intent alone can hang forever with no tab; liveness alone,
without explicit opt-in, would ask the user in the TUI even when they never
requested browser-side answering). Any future presence heuristic based on
visibility, focus, or activity timestamps should be treated as a re-tried
approach already found insufficient, unless it produces a genuinely different
signal than tab visibility.

## Evidence

- **Tab-visibility inference is empirically false** — `document.hidden` stays
  `false` when a minimized or covered browser window is not actually being
  looked at. Replaced with two mandatory factors: an explicit `answer_here`
  intent switch (default off) and `hasVisibleSubscriber()` liveness; refusal
  reports which factor (`toggle_off` or `no_tab`) blocked the wait, and both
  map to CLI exit code 4.
  Session `2a7606f0-acf8-4c76-8af3-1ac7d54d712c`, entry `12da43a3-4b59-4ad5-978d-1bf2fbd735b9`, 2026-07-28.
