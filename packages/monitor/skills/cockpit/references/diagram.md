# Cockpit Mermaid diagrams

Use `--diagram` only when the insight is structural. A picture must carry it
better than prose: a flow, a state machine, a sequence, a dependency graph, a
fan-out, a before/after comparison, or a decision tree. Pass the Mermaid
source as one argument. Use a heredoc to preserve newlines.

The dashboard renders diagrams inline as Night Flight-themed SVG. Rendering is
sandboxed: the SVG profile is sanitized, and it allows no scripts or HTML
labels. If the source cannot parse in the dashboard, the card shows the
source as text instead of breaking.

The CLI lints the source before writing. Each of these exits non-zero with a
fix hint: an unknown diagram type, unbalanced brackets, an unknown `:::`
class, an unquoted `()` inside a `[...]` label, and a `[/…]` label that opens
a shape it never closes. Correct the source and re-run it, rather than
dropping the diagram.

**Quote any label with punctuation.** A bare `[...]` label is parsed for
shape syntax. Leading or embedded `/ \ ( )` characters break this parsing.
For example, `[/release]` reads as an unterminated parallelogram (`[/…/]`),
not as the literal text "/release", and this fails the whole parse. Whenever
the label carries a slash-command, a path, a parenthetical, or other
punctuation, wrap it in quotes, for example `["/release"]`. A plain-word
label such as `[read config]` needs no quotes.

## Pick the Mermaid type from the shape

| The insight is... | Use |
|---|---|
| states/statuses and what moves between them | `stateDiagram-v2` |
| a call chain / who-talks-to-whom over time | `sequenceDiagram` |
| a decision tree, branch, or fallback cascade | `flowchart TD` |
| a pipeline or dependency chain | `flowchart LR` |
| a before/after or two compared designs | `flowchart` with two `subgraph`s |

## Layout discipline

Draw the narrative, not the wiring. A decision-card diagram is a glance-sized
instrument, not a wiring schematic.

- **One main path.** The happy path reads in one direction, top-down or
  left-right. Side concerns hang off it as short stubs. They never cut
  across the main path.
- **Label only the non-obvious edges.** Use short event-like words, for
  example "retry", "timeout", or "cache miss". An arrow between adjacent
  steps needs no label.
- **Detail belongs in prose, not extra arrows.** If you add a node only to
  explain another node, move the explanation to `--reason`, `--facet`, or
  `--text` instead.
- **Edge budget: ~12.** Past that limit, delete edges until only the main
  narrative remains. Or split the insight into two entries.

## Night Flight node colours

Colour nodes by meaning with `:::class` markers. The renderer predefines the
palette. Do not write your own `classDef`.

Append the class to a node, e.g. `B[has env]:::ok`.

- `:::ok` — green, success/healthy path
- `:::bad` — red, failure/error path
- `:::fix` — amber, the fix or action to take
- `:::info` — cyan, a neutral note
- `:::warn` — dim amber, a softer caution
- `:::start` — grey, a neutral entry

Tag only the nodes that carry meaning; leave plumbing nodes untagged.
