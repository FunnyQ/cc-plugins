# ADR-0002: Multi-plugin releases share one merge commit with multiple tags

- Status: Accepted
- Date: 2026-07-06

## Context

Chronicle (0.3.2 → 0.4.0) and dispatch (3.13.0 → 3.14.0) both had unreleased
commits accumulated on `develop` at the same time. The repo's release model is
already per-plugin independent versioning with scoped tags (`<plugin>-vX.Y.Z`),
not one repo-wide version.

## Considered alternatives

- Run two independent release rounds (git-flow's default pattern): one
  `develop` → `main` merge and tag per plugin, sequentially. Rejected: the two
  plugins' release content was already interleaved across the same batch of
  commits, so there was no semantic reason to force two separate merges.

## Decision

Release both plugins in a single pass: one commit bumps both plugins' versions
and CHANGELOG entries, `develop` merges into `main` exactly once, two annotated
tags (`chronicle-v0.4.0`, `dispatch-v3.14.0`) land on that same merge commit,
`main` merges back into `develop` once, and one push carries both tags.

## Consequences

Coordinated releases across N components collapse to one merge + N tags instead
of N merges, reducing merge-commit noise and avoiding N sequential round-trips.
This pattern is the direct precursor to the later `releases[]` config-driven
multi-component release support. Do not treat this ADR as endorsing a different,
declined candidate about describing multi-component releases as prose
orchestration — that candidate was declined this triage round and is unrelated.

## Evidence

- **Two plugins' unreleased work batched into one merge, two tags** — chronicle
  and dispatch both had accumulated commits on `develop`; instead of two release
  rounds, one commit bumped both versions, one `develop`→`main` merge landed,
  and two annotated tags (`chronicle-v0.4.0`, `dispatch-v3.14.0`) were cut on
  that single merge commit.
  Session `fee2f364-2829-41d7-a1af-cbb8871205a2`, entry `ea566112-43d2-45b8-ba9d-3b4f0f11d0b3`, 2026-07-06.
