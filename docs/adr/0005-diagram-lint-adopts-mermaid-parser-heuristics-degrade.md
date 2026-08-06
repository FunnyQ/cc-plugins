# ADR-0005: diagram-lint adopts the real mermaid parser; heuristics degrade to a fallback

- Status: Accepted
- Date: 2026-07-08

## Context

diagram-lint validated cockpit `--diagram` mermaid source with hand-written
heuristics. A concrete false negative surfaced: an edge label containing a
literal `.` (`A -.context.mjs 撈.-> B`) passed the heuristics, got written, and
then rendered as raw, unparsed source on the card, because the dotted-arrow
lexer stopped early on the label's `.` and `bracketProblem()` never inspected
edge labels at all. A real mermaid parser had become runnable from the CLI
(happy-dom plus a vendored UMD bundle, ~200ms cold, paid only when `--diagram`
is used), so the renderer's own judgment could become the lint's judgment.

## Considered alternatives

- Delete the heuristics once the real parser covers the same detector surface
  (unclosed `[`, stray `]`, unquoted `()` in labels, unclosed `[/x]` shapes —
  each checked line-by-line against the vendored bundle). Rejected: the real
  parser is not always available, and the same design also requires a
  heuristics fallback for when it isn't — deleting the heuristics would leave
  that fallback path with zero coverage.

## Decision

Keep every heuristic, but change their role from primary lint to two narrower
jobs: (1) the entire fallback lint when `getParser()` returns null, and (2) a
fix-hint layer that only runs after `mermaid.parse()` has already failed, to
supply an actionable hint that mermaid's own position-only error does not
give. Two checks stay unconditional, before parsing: `:::class` validation
(mermaid accepts unknown classes silently; the dashboard's scoped CSS ignores
them just as silently) and `DIAGRAM_TYPES` detection, which short-circuits —
mermaid's own "No diagram type detected" message never demonstrates a correct
first line, so this check must run first and independently.

## Consequences

A heuristic false positive can no longer, on its own, block a legitimate write
— it can only ever supplement a parser that has already rejected the diagram,
or stand in when no parser is available at all. The pre-parse class-marker and
diagram-type checks remain load-bearing and permanent, since the real parser
structurally cannot cover them.

## Evidence

- **A real false negative motivated the switch** — `A -.context.mjs 撈.-> B`
  passed the old heuristics, got written, then rendered as raw unparsed source
  because the dotted-arrow lexer stopped early on the label's literal `.` and
  `bracketProblem()` never inspected edge labels. The real parser now runs
  first when available; heuristics only supply fallback lint or post-failure
  fix hints.
  Session `d577c413-69ab-4157-baa6-96de8d3a86c2`, entry `59397cfa-d65e-49df-aa12-497539e28bd6`, 2026-07-08.
- **Detector overlap was measured, not assumed** — the real parser's detection
  of unclosed `[`, stray `]`, unquoted `()` in labels, and unclosed `[/x]`
  shapes was checked line-by-line against the vendored bundle before the
  heuristics were downgraded rather than removed, preserving 100% fallback
  coverage for when the parser is unavailable.
  Session `d9833854-82f0-4365-8f47-2ef21ce6d1ae`, entry `6808e208-8423-475c-aee4-e5f52b14924f`, 2026-07-08.
