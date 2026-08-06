# ADR-0025: Dashboard hides archived sessions only via archive-bucket presence

- Status: Accepted
- Date: 2026-08-05

## Context

After `chronicle:adr` triage archives a decision log, the corresponding
session should stop appearing in the cockpit dashboard. Two candidate rules
were compared: hide when `ended` and `logPath` no longer exists (~3 lines,
also fixes existing dead rows from hand-deleted logs), versus hide only when
the session is both absent from `logs/` and confirmed present in
`.cockpit/archive/done/` or `.cockpit/archive/watch/` (two extra `existsSync`
checks per `ended` entry).

## Considered alternatives

- Hide on "ended + log missing" alone. Rejected in favor of the narrower
  rule, though the reasoning given for rejecting it at the time was
  incorrect — see Consequences.

## Decision

Adopt the narrower rule: hide only when the session is absent from `logs/`
**and** present in `.cockpit/archive/done/` or `.cockpit/archive/watch/`.
`.cockpit/` is already monitor's own directory, so reading its `archive/`
bucket is not new cross-plugin coupling. The narrower rule only hides
sessions that were genuinely archived, and does not also silently hide
sessions whose log was hand-deleted — a behavior change nobody asked for.
Locked in with a test asserting the dashboard "keeps an ended session whose
log is merely missing."

## Consequences

Monitor's `registry.ts` now depends on chronicle's `archive/` directory
convention — a real cross-plugin coupling that exists specifically because
`.cockpit/` belongs to monitor itself, not because monitor imports chronicle
code (see ADR-0026 on why plugins never import each other). The original
justification given for choosing this rule — "some sessions inherently have
no log" — does not hold for tracked sessions: every registry entry is
created in lockstep with the first log append (`cockpit.ts:586` registers
immediately before `appendFileSync`; `cockpit.ts:491`'s `refreshHeartbeat`
only fires after the append at `cockpit.ts:471`). No tracked session can have
an entry with no log. The sessions that genuinely have no log are untracked
ones (`registry.ts:267-291`, running but never started via `/cockpit-start`,
`logPath` is an empty string) — and this filter does not touch that branch at
all. The conclusion (narrower rule) is correct; the reasoning that produced
it was not. Anyone re-deriving this rule from the original "some sessions
have no log" premise will arrive somewhere else — the two real justifications
are that `.cockpit/` is already monitor's own territory, and the narrower
rule avoids an unrequested behavior change for hand-deleted logs.

## Evidence

- **The rule adopted is correct; the reason first given for it was not** —
  every tracked session's registry entry is created in lockstep with its
  first log append, so "some sessions have no log" cannot apply to tracked
  sessions; the real justifications are that `.cockpit/archive/` is already
  monitor's own directory (no new cross-plugin coupling) and that the
  narrower rule avoids silently hiding hand-deleted logs. Locked in with a
  dedicated regression test.
  Session `c98564b7-7090-461f-9b98-f81c09eda644`, entry `d0d7222d-a6dd-479f-813f-686f47555d55`, 2026-08-05.
