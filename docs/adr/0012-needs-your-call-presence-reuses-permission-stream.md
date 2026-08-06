# ADR-0012: needs_your_call presence reuses the permission-stream subscriber set

- Status: Accepted
- Date: 2026-07-28

## Context

`needs_your_call` needs to know whether a user is currently looking at
cockpit.

## Considered alternatives

- Add a new `/api/presence` endpoint, a 15-second frontend heartbeat, a
  `tabId`, a per-tab store, and stale-entry cleanup. Rejected in favor of
  reusing infrastructure that already answers the same question implicitly.

## Decision

Read the existing permission-stream's subscriber set and add
`hasVisibleSubscriber()`. The UI already ties that specific stream's
lifecycle to "tab visible and this session selected": it closes on hidden,
reopens on return, and closes-then-reopens on session switch
(`permission-modal.js:285-333`). The transcript and decision-log streams do
not behave this way — they stay alive in hidden tabs — so they cannot answer
the presence question. `hasVisibleSubscriber()` enqueues a `: probe` line
before answering; this is a necessary write, not overhead — without it, a
socket that disconnected without firing `cancel()` would only be swept on the
next 25-second heartbeat, giving a stale positive.

## Consequences

Presence detection has zero new endpoints, no heartbeat protocol, and no
`tabId` concept to maintain. It is coupled to the permission stream's exact
lifecycle semantics — if that stream's open/close behavior ever changes
(e.g., staying open while hidden), this presence signal breaks silently and
needs to be re-derived from whatever stream still has visibility-tied
lifecycle.

## Evidence

- **The permission stream already encodes tab visibility** — its lifecycle is
  bound to "tab visible + session selected" (`permission-modal.js:285-333`),
  unlike the transcript/decision-log streams, which survive hidden tabs.
  `hasVisibleSubscriber()` reuses that subscriber set and probes with a
  `: probe` write to avoid a false positive from an uncancelled dead socket.
  Session `2a7606f0-acf8-4c76-8af3-1ac7d54d712c`, entry `ffa25ac3-3d69-46b2-90a7-43e552bde01d`, 2026-07-28.
