# DECK-01: Read and validate graph.json

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/02, contract/03
> **Blocks**: deck/02, deck/03, deck/04
> **Status**: done

## Goal

A `graph.json` file on disk becomes a validated set of narrow graph nodes plus
the run's lanes, title, and repo root — or a list of named errors, never a
throw.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/graph-source.ts` (new) — the pure
  parser and the thin reader around it
- `packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` (new) —
  unit tests for both halves

## Implementation notes

### The split that matters

A pure parser that takes already-read text, and a thin impure reader that does
the I/O. Every script in `autopilot/scripts/` already splits this way —
`buildTreePayload` is pure, `loadPlan` is not — and the tests depend on it.

```ts
export type GraphSourceError = { file: string; bucket: string; reason: string };

export type ParsedGraph = {
  title: string;
  repoRoot: string;
  lanes: string[];
  /** Keyed by ref. Empty when the file failed validation. */
  nodes: Record<string, GraphNode>;
  errors: GraphSourceError[];
};

/**
 * Pure. `fileLabel` is what appears in each error's `file`. `fallbackTitle` is
 * what `title` becomes when the file omits it — passed in rather than derived,
 * because a pure parser holding only text cannot know which directory it came
 * from, and guessing one from the label would make the returned title depend on
 * how the caller happened to spell an error string.
 */
export function parseGraph(
  text: string,
  fileLabel: string,
  fallbackTitle: string,
): ParsedGraph;

/** Impure: reads <dir>/graph.json. A missing file is an error, not a throw. */
export function loadGraph(dir: string): Promise<ParsedGraph>;
```

`loadGraph` supplies the directory's base name as `fallbackTitle`. That is the
only place the run directory is known, and keeping the derivation there is what
lets the parser stay a function of its text alone.

`GraphSourceError` deliberately matches the error shape the tree payload already
carries, so the dashboard's existing error panel renders these with no frontend
change. `bucket` has no meaning for a whole-file error — pick one value for that
case, use it consistently, and say in a comment why it is what it is. For an
error about one specific node, `bucket` is that node's lane.

`GraphNode` and `NodeValidity` are defined in the required reading. Import
them; do not redeclare them.

### Validation rules

Each of these produces a named error rather than a throw:

- the text is not valid JSON, or its parsed root is not an object
- `version` absent, or not the number `1`
- `title` present but not a string. It is the only optional top-level field:
  absent is fine and falls back to the directory's base name, but a present
  value of the wrong type is an error like any other. Without this rule the
  exhaustive list would require accepting a non-string title, which the returned
  type cannot hold and the no-coercion rule below forbids casting.
- `repoRoot` absent, not a string, empty, or not an absolute path
- `lanes` absent, not an array, empty, holding a non-string, or holding a
  duplicate
- `nodes` absent, not an array, or empty
- a node that is not an object
- a node missing `ref`, `lane`, or `title`, or holding a non-string in any of
  the three
- a `ref` not matching `/^[a-z][a-z0-9-]*\/\d{2}$/`, or repeating
- a `lane` not listed in `lanes`
- `dependsOn` or `blocks` present but not an array of strings
- `finalReview` present but not a boolean
- more than one node with `finalReview: true`

This list is exhaustive. Do not add a rule of your own, and do not reject a
shape it does not name — the specification document states the same list, and a
loader stricter than the spec rejects files the documentation told an author to
write.

**Nothing is coerced.** A field of the wrong type is an error, never a cast. A
graph that silently reinterprets its author's mistake is how a panel comes to
show a shape nobody declared.

Write each error's `reason` so a reader who cannot see the file knows what to
change — name the offending value, not just the rule.

### Two rules that look contradictory and are not

**A file that fails validation yields no nodes at all**, not the ones that
happened to be well formed. A half-loaded graph renders as a run in progress,
which is worse than an empty panel carrying the error. Return the errors with
an empty `nodes` map.

**A dangling `dependsOn` ref inside an otherwise valid file is removed from that
node's `dependsOn` array and reported as an error.** The rest of the graph is
well formed and worth drawing, so this is not a whole-file failure — but the ref
must not survive into the array.

Removing it rather than keeping it is the part to get right, and the reason is
not obvious. The readiness rule counts a ref it cannot resolve as unmet. A kept
dangling ref would therefore leave its node blocked forever, on a dependency
that does not exist, with no way for the reader to unblock it. Removing it makes
the layout and the readiness rule describe the same graph, and the reported
error is what keeps the author's mistake visible.

The difference between the two rules is worth a comment in the source: the first
case is a broken contract and nothing about the run can be trusted; the second
is one bad edge in an otherwise sound graph.

### Field mapping

For each valid node, produce the narrow node type as follows:

- `ref` — verbatim from the file
- `bucket` — the node's `lane`
- `nn` — the two digits at the end of the **ref**, kept as a string. Never from
  a separate field: the ref is the only identifier the renderer and the sort
  order agree on, so a second source for the same number could disagree with it.
- `title` — verbatim
- `status` — `null`. No state has been declared yet; the event trail supplies it
  later, and that is separate work.
- `validity` — `{ kind: "unfinished", status: null }`, for the same reason
- `dependsOn` — from the file, defaulting to `[]`
- `blocks` — from the file, defaulting to `[]`
- `finalReview` — from the file, defaulting to `false`

`title` at the top level falls back to the directory's own name when absent.

### Ordering

`lanes` order is authoritative and must be returned exactly as given — it is the
road order, top to bottom, and the panel draws it in that order. Do not sort it,
and do not derive it from the nodes. A lane naming no node is still a lane and
still appears in the returned array.

## Acceptance criteria

- [x] `parseGraph` is pure: it takes text and a file label, returns
      `ParsedGraph`, and touches no filesystem.
- [x] Every validation rule listed above returns a named error whose `reason`
      identifies the offending value, and none of them throws.
- [x] A file failing any validation rule returns an empty `nodes` map together
      with its errors.
- [x] A dangling `dependsOn` ref is removed from the node's `dependsOn` array
      and reported as an error, and the node it belonged to is not left blocked
      by it.
- [x] A field of the wrong type produces an error rather than being coerced,
      including a non-string top-level title.
- [x] An absent top-level title falls back to the supplied fallback, asserted on
      the pure parser directly, and the reader supplies the run directory's base
      name as that fallback.
- [x] Field mapping is exactly as specified, including `nn` derived from the ref
      and both `status` and `validity` reflecting that no state is declared yet.
- [x] The returned `lanes` array preserves the file's order and includes a lane
      that names no node.
- [x] `loadGraph` returns an error for a missing or unreadable file rather than
      rejecting or throwing.
- [x] A valid file loads every node, keyed by ref.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/graph-source.test.ts`
      passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes — the
      existing suite is unchanged by this work.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. The
      repo-wide typecheck is not green (86 pre-existing errors sit elsewhere),
      so a zero count is not the bar — an empty grep on these paths is.
- [x] Tests for the pure parser use in-memory fixture strings; tests for
      `loadGraph` use a real temp directory created and removed by a local
      helper, not a mock.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                   | 2–3 (below bar)                                                                                        | 4–5 (pass)                                                                                                                                  |
| ----------------------- | ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A malformed file throws, or validation returns partial nodes | Rules fire but the two asymmetric cases are conflated, or `nn` comes from somewhere other than the ref | Every rule returns data, all-or-nothing holds for the file, dangling refs are removed and reported, nothing is coerced, field mapping exact |
| Backward compatibility  | ×2     | Edits the task-file loader or the shared library             | Adds an unnecessary import or export that the existing path now depends on                             | New module only; the existing task-file path imports nothing from it and is not touched                                                     |
| Test coverage           | ×2     | No tests, or tests that pass with the implementation deleted | Happy path plus a couple of rules                                                                      | Every validation rule, both asymmetric cases, missing file, empty lane, and the full field mapping asserted                                 |
| Interface & readability | ×1     | I/O smuggled into the parser                                 | Split exists but types are loose or the error shape drifts from the payload's                          | Pure parser and thin reader, narrow types, error shape identical to what the payload already carries                                        |
| Assumptions & docs      | ×1     | The `bucket` value for whole-file errors is unexplained      | Choices made but reasons absent                                                                        | The asymmetry, the `nn` source, and the whole-file `bucket` value each carry a one-line reason in the source                                |

## Out of scope

- **Deriving node state from the event trail** — Deferred. Separate work in this
  bucket owns it, and this loader must leave `status` and `validity` reflecting
  "nothing declared yet" so that work has one place to write.
- **Wiring the loader into the server's routes or its directory detection** —
  Deferred, also to separate work in this bucket. Export the two functions and
  stop; nothing in the server should import them yet.
- **Any frontend change** — Deferred permanently. The renderer is already
  data-driven and the error shape here is chosen so it needs no change.
