# ADR-0023: ADR exists because cockpit's trail is write-only, not for institutional memory

- Status: Accepted
- Date: 2026-08-05

## Context

The original plan described the ADR skill as an independent "institutional
memory" artifact. That framing gave a weak justification with no clear
boundary against CLAUDE.md or `memory/`.

## Considered alternatives

- Keep the "institutional memory" framing. Rejected: too weak to justify the
  skill's existence and does not explain why it should not simply be folded
  into `memory/` or CLAUDE.md.

## Decision

Reframe: the cockpit trail is, in the meaningful sense, write-only.
`/chronicle:pr` reads one branch's window, produces a PR body, and discards
the read; the dashboard is a live view. Neither produces anything that
outlives the session that wrote it — the repo's (then-)61 log files had never
produced an artifact that outlived its own writing session. ADR is therefore
cockpit's first durable read path: it consumes the trail rather than
competing with it. This also draws a clean boundary:

| Repository | Owns | Lifetime |
|---|---|---|
| cockpit trail | raw in-the-moment decisions | expires; it is raw material |
| ADR | cross-release architectural commitments | permanent, has a lifecycle |
| CLAUDE.md | how the repo works now | always describes the present |
| `memory/` | harness behavior and pitfalls | follows the harness, not the code |

Explicitly out of scope: moving `memory/` content into ADR. It mixes genuine
harness facts (which belong in `memory/`) with project decisions that were
only put there for lack of a better place at the time; the latter should be
extracted piecemeal later, not wholesale now.

## Consequences

This framing governs the whole documentation ecosystem's scope going forward
— any new documentation surface must be checked against this table before
being added, or its boundary against ADR/CLAUDE.md/`memory/` will be
undefined from day one. The tradeoff accepted here: once triage archives
logs, ADR's judgment quality is the only barrier standing between the trail
and permanently lost meaning. A careless triage pass that skips an entire
batch loses those sessions for good — this is the direct reason triage
thresholds must stay conservative and archiving must never mean deletion
(ADR-0022).

## Evidence

- **The trail had never once produced anything that outlived its own
  session** — `/chronicle:pr` reads and discards; the dashboard is a live
  view only. This reframes ADR as cockpit's first durable read path rather
  than a competing "institutional memory" store, and produces an explicit
  four-way lifetime table (trail/ADR/CLAUDE.md/memory) to keep the
  boundaries from blurring later.
  Session `7597db5d-c42a-4043-997f-47359b3e2a19`, entry `d2f361c7-fe40-49f1-9e0d-7a47d149a27c`, 2026-08-05.
