# Cockpit Mermaid diagrams

Use `--diagram` only when the insight is structural and a picture carries it
better than prose: a flow, state machine, sequence, dependency graph, fan-out,
before/after comparison, or decision tree. Pass the Mermaid source as one
argument; a heredoc preserves newlines.

The dashboard renders diagrams inline as Night Flight-themed SVG. Rendering is
sandboxed (SVG-profile sanitized, no scripts/HTML labels). If the source can't
parse in the dashboard, the card shows it as text rather than breaking.

The CLI lints the source before writing: unknown diagram type, unbalanced
brackets, unknown `:::` classes, and unquoted `()` inside `[...]` labels all
exit non-zero with a fix hint. Correct the source and re-run rather than
dropping the diagram.

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

- **One main path.** The happy path reads in one direction (top-down or
  left-right); side concerns hang off it as short stubs, never cut across it.
- **Label only the non-obvious edges,** with short event-like words ("retry",
  "timeout", "cache miss"). An arrow between adjacent steps needs no label.
- **Detail belongs in prose, not extra arrows.** If you're adding a node to
  explain a node, move the explanation to `--reason` / `--facet` / `--text`.
- **Edge budget: ~12.** Past that, delete edges until the main narrative is
  what remains, or split the insight into two entries.

## Night Flight node colours

Colour nodes by meaning with `:::class` markers. The renderer predefines the
palette; don't write your own `classDef`.

Append the class to a node, e.g. `B[has env]:::ok`.

- `:::ok` — green, success/healthy path
- `:::bad` — red, failure/error path
- `:::fix` — amber, the fix or action to take
- `:::info` — cyan, a neutral note
- `:::warn` — dim amber, a softer caution
- `:::start` — grey, a neutral entry

Tag only the nodes that carry meaning; leave plumbing nodes untagged.
