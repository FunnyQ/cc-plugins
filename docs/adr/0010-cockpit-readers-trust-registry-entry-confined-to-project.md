# ADR-0010: Cockpit daemon readers trust the registry entry, confined to its own project

- Status: Accepted
- Date: 2026-07-28

## Context

The usage-dashboard's Live-now deep link carries a live session's raw cwd,
which may differ from the repo root the trail was actually written under;
legacy registry entries sometimes had the opposite mismatch (entry in a
subdirectory, request carrying the root). `log-stream.ts`'s exact
`e.project === project` comparison broke in both directions, producing 400s
or empty panels.

## Considered alternatives

- Keep exact project-string matching and try to normalize cwd vs. root before
  comparing. Not pursued as the shipped fix — string-equality comparison is
  inherently fragile to the root/subdirectory ambiguity itself, not just to a
  normalization bug.

## Decision

`resolveLogPath` in `log-stream.ts` now looks up the entry by `sessionId`
first and trusts its absolute `logPath` directly, confining the stream to
that entry's own registered project (not a narrower or wider set — security
scope is unchanged, only the lookup key changes). Only untracked sessions
fall back to computing a path from the request's `project` param.
`project-info.ts` and `design-system.ts`'s known-project checks (`design-system.ts`
was a reader the author missed; a codex review caught it) switch to a new
`resolveKnownProject()`: pure string comparison that maps a subdirectory down
to a registered root, never resolving upward, so an unregistered ancestor
directory cannot unlock a registered descendant project.

Trusting the entry's `logPath` by session ID alone, without any further check
against the request's `project`, turned out to weaken confinement: any known
session ID could stream its trail regardless of what project the request
claimed, degrading cross-project isolation to session-ID knowledge alone (path
escape outside the registered tree was still blocked, so this was not an
arbitrary-file read, but the weakening was unnecessary). The same day, this was
closed with `arePathsRelated()`: the entry is used only if the request's
project and the entry's project are equal, or one contains the other,
checked segment-by-segment via `relative()` so `/repo` and `/repo-other` are
never treated as related. Both directions are required — a deep link carries
a subdirectory cwd while the entry is at root, and legacy entries have the
reverse shape. When the entry exists but is unrelated, the resolver now
returns `null` rather than falling back to recomputing a path.

## Consequences

This decision is the origin of "Resolve sessions by raw cwd" and now spans
three reader modules (`log-stream.ts`, `project-info.ts`, `design-system.ts`).
Any new cockpit daemon reader added later must resolve sessions the same way
— trust the registry entry, but require the request's own project to be
related to the entry's project via `arePathsRelated()` — or it will
reintroduce either the original root/subdirectory bug or the confinement
weakening this ADR closed.

## Evidence

- **Exact project-string matching broke in both directions** — a Live-now
  deep link's raw cwd versus a trail's repo root, and legacy entries with the
  reverse mismatch, both broke `e.project === project`. The fix trusts the
  registry entry's absolute `logPath` by `sessionId`, confined to that
  entry's own project; a reader the author missed (`design-system.ts`) was
  caught by codex review and fixed in the same pass.
  Session `82327df5-6355-45c3-8550-3facb7b7aac9`, entry `8372cd2f-480d-4b5f-8796-b02bc5b31a9f`, 2026-07-28.
- **Trusting the entry by session ID alone weakened cross-project confinement** —
  any known session ID could stream its trail regardless of the request's
  claimed project, though path escape stayed blocked. Closed same-day with
  `arePathsRelated()`, a bidirectional, segment-by-segment containment check
  that treats `/repo` and `/repo-other` as unrelated; entries that fail the
  check return `null` instead of falling back to a guessed path.
  Session `82327df5-6355-45c3-8550-3facb7b7aac9`, entry `a13dc132-fd3f-4e25-841f-ff1a63cf3d9a`, 2026-07-28.
