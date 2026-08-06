# ADR-0024: ADR Status reports implementation state, not review state

- Status: Accepted
- Date: 2026-08-05

## Context

`promote` needed to decide whether a confirmed candidate writes
`Status: Proposed` or `Status: Accepted`. This is not obvious, because the
conventional Nygard ADR lifecycle assumes a forward-running team process:
someone drafts `Proposed`, the team reviews, it becomes `Accepted`, then
implementation begins. `chronicle:adr` runs backward — a candidate exists
specifically because the decision was already made, already implemented, and
already logged to the cockpit trail before triage ever sees it. With Q as a
single decision-maker, Q's own confirmation at the triage gate is the only
review this project has; there is no second-party approval waiting to happen
later.

## Considered alternatives

- Always write `Proposed`, upgrade manually later. Rejected on a predicted
  consequence, not a principle: no moment in this workflow would ever perform
  that upgrade — there is no review meeting, no PR-approval step. Every ADR
  would sit at `Proposed` forever, at which point a 100%-uniform field value
  carries zero information; an apparently-safe default would silently kill
  the field.
- Let triage judge its own confidence, defaulting to `Proposed` only when
  unsure. Rejected: theoretically more precise, but "unsure" has no clean
  definition and adds a branch the v1 design does not need.

## Decision

Status reports implementation state:

- `Accepted` — alive in the code today. `promote` always writes this.
- `Proposed` — drafted ahead of implementation. Only produced by `supersede`,
  and only when the replacement describes work not yet landed; flips to
  `Accepted` once it lands.
- `Superseded` — replaced by a named successor; must carry
  `Superseded by: ADR-NNNN`.
- `Deprecated` — no longer applies, no successor; carries no link.

The `Superseded`/`Deprecated` split is pinned here to prevent the two from
being conflated later, and becomes a unit-testable assertion in the plan's
Verification section.

## Consequences

This explicitly deviates from the standard Nygard convention, because this
pipeline documents decisions after the fact rather than before. A maintainer
familiar with conventional ADR practice could accidentally "fix" this back to
the standard forward-running semantics, which would silently kill the
Status field's information content again, exactly as the rejected
always-`Proposed` alternative would have.

## Evidence

- **Always-`Proposed` was rejected on a traced consequence, not a
  preference** — nothing in this backward-running workflow would ever
  perform the Proposed→Accepted upgrade, so the field would sit uniform
  forever and carry zero information. `promote` therefore always writes
  `Accepted`; `Proposed` is reserved for `supersede` describing not-yet-landed
  work, flipping to `Accepted` once it lands.
  Session `7597db5d-c42a-4043-997f-47359b3e2a19`, entry `465b2cf8-5c4e-4f4b-b6a6-e22a03f01373`, 2026-08-05.
