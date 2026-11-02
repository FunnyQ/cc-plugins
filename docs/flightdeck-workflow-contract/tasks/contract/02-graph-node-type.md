# CONTRACT-02: Extract the narrow GraphNode type

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Blocks**: contract/03, deck/01
> **Status**: done

> **Ordering note**: this task depends on the event-kind task not because it
> needs its output, but because both edit `fleet.ts` and its test. Parallel
> execution dispatches every ready task of a wave into one shared working tree
> and forbids each of them to commit, so two tasks editing one file in the same
> wave would clobber each other. Serialising them is the fix; there is no
> logical dependency to satisfy.

## Goal

`deriveTaskViews` stops taking the rich markdown-derived `ParsedTask` and takes a narrow `GraphNode` instead — exactly the fields it reads — with the existing task-file path producing that shape and the dashboard rendering identically.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/graph-node.ts` (new) — the `GraphNode` and `NodeValidity` types, the `ParsedTask` → `GraphNode` adapter, and the readiness helper
- `packages/dispatch/skills/autopilot/scripts/graph-node.test.ts` (new) — unit tests for the adapter and the readiness helper
- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify) — `deriveTaskViews` takes the narrow type; its imports of `ParsedTask`, `taskValidity`, `refToString`, and `unmetDependencies` go away
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify) — the local `task(...)` fixture factory builds a `GraphNode` instead of a `ParsedTask`
- `packages/dispatch/skills/autopilot/scripts/tree-api.ts` (modify) — `loadPlan` converts; the exported `Loaded` type's `byRef` becomes the narrow type
- `packages/dispatch/skills/autopilot/scripts/tree-api.test.ts` (modify) — same fixture-factory change

This is a pure refactor. Nothing the dashboard shows may change.

## Implementation notes

### Where the module lives, and why

The new module sits in `packages/dispatch/skills/autopilot/scripts/`, **not** in the flightplan library. All three parties are autopilot-side: the caller that loads the markdown tree, the derivation that consumes it, and the second loader that a later task will add. Putting a type in the shared library that only autopilot imports would invert the dependency direction for no gain.

The flightplan library is not edited by this task at all.

### The types

Inline these exactly. `type`, never `interface`.

```ts
export type NodeValidity =
  | { kind: "complete" }
  | { kind: "unfinished"; status: string | null }
  | { kind: "invalid"; rule: string; reason: string };

export type GraphNode = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;
  dependsOn: string[];
  blocks: string[];
  finalReview: boolean;
  /** Whether this node counts as complete for a dependent. */
  validity: NodeValidity;
};
```

`NodeValidity` is a **widened** mirror of the existing `TaskValidity`, whose real shape is:

```ts
type TaskValidity =
  | { kind: "unfinished"; status: Exclude<TaskStatus, "done"> }
  | { kind: "complete" }
  | { kind: "invalid"; rule: "status" | "completion-state"; reason: string };
```

Two fields widen on purpose: `rule` becomes `string` and `unfinished.status` becomes `string | null`. A non-markdown source has neither the `TaskStatus` vocabulary nor those two rule names, and narrowing the shared type to the markdown source's vocabulary is what would force the next producer to fabricate values. The widening is safe in the other direction — the concrete `TaskValidity` assigns straight into `NodeValidity` with no mapping code, so the adapter passes the existing return value through untouched.

### The two functions

```ts
/** Pure. Converts the parsed markdown tree into the narrow node shape. */
export function nodesFromParsedTasks(
  byRef: Record<string, ParsedTask>,
): Record<string, GraphNode>;

/** The readiness rule, against nodes rather than parsed tasks. */
export function unmetNodeDependencies(
  node: GraphNode,
  byRef: Record<string, GraphNode>,
): string[];
```

`nodesFromParsedTasks` keys the result by the same `bucket/NN` string the input is keyed by, and fills each node as:

- `ref` — the input key
- `bucket`, `nn`, `title`, `status`, `finalReview` — copied straight off the parsed task
- `dependsOn`, `blocks` — the parsed task's `TaskRef[]` arrays mapped through `refToString`, which is what the derivation does today
- `validity` — `taskValidity(task)` passed through with no transformation

### Why the readiness helper has to exist

`deriveTaskViews` currently calls `unmetDependencies(task, byRef)` from the flightplan library, which operates on `ParsedTask`. Once the derivation takes the narrow node it cannot call that function at all.

The replacement implements the identical rule: **a dependency is unmet when the ref is absent from `byRef`, OR when that node's `validity.kind !== "complete"`.** Both cases, exactly those two.

That rule living in exactly one place is what keeps the dashboard and the CLI scout from disagreeing about which task is blocked. This task _moves_ that single place for the dashboard's half — it must not fork it into a second, subtly different rule. The library's own function stays as it is and unchanged; the CLI scout keeps calling it.

Write the reason down in a one-line comment above the helper, the way the surrounding code already annotates non-obvious decisions.

### The state ladder is copied verbatim

`deriveTaskViews` currently resolves state through this ladder:

```ts
if (validity.kind === "invalid") state = "invalid";
else if (task.status === "done") state = "done";
else if (task.status === "blocked") state = "blocked";
else if (task.status === "in-progress") state = "in-progress";
else if (task.status === "todo" && hasOpenStart(aggregate))
  state = "in-progress";
else if (task.status === "todo" && blockedBy.length === 0) state = "ready";
else state = "blocked";
```

Every input it reads — `validity`, `status`, the open-start count, the unmet-dependency list — is on the narrow node. So the ladder moves over **unchanged, branch for branch, in the same order**.

Do not rewrite it, do not collapse the two `"todo"` branches, do not "simplify" the trailing `else`. A second loader is going to feed this same ladder, and a behaviour change here is invisible: the panel keeps rendering, just with a wrong picture. If a branch looks redundant, leave it and say so in the report rather than editing it.

`aggregateByTask` and `hasOpenStart` are untouched — they read only flightlog entries, never the task shape.

### Deliberately not on the type

`rubric`, `sections`, `body`, `requiredReading`, and `h1` stay off `GraphNode`. The derivation never reads any of them. Synthesizing them for a source that has no markdown behind it is precisely the alternative this task exists to avoid, so a later reader should find the omission recorded rather than have to re-derive it — put that in a one-line comment on the type.

### Call-site conversion

The conversion happens in `loadPlan`, the impure half, so that `buildTreePayload` — the pure half the tests drive directly — receives narrow nodes and needs no knowledge of markdown. The exported `Loaded` type's `byRef` field changes to `Record<string, GraphNode>` in the same edit; it is the input contract of the pure function and must match what that function now consumes.

That split is what lets a second loader feed the identical pure function later, so keep the conversion out of `buildTreePayload` itself.

### Test fixtures

Both existing test files define a local `task(...)` factory returning a `ParsedTask`. Change each factory to return a `GraphNode` and leave every assertion alone. A factory that used to set `body` to drive `taskValidity` now sets `validity` directly, which is shorter and states the intent the assertion actually depends on.

The new test file covers the adapter and the readiness helper with in-memory fixtures — no filesystem, no temp directory, per the repo's convention for pure functions.

## Acceptance criteria

- [x] `graph-node.ts` exports `GraphNode`, `NodeValidity`, `nodesFromParsedTasks`, and `unmetNodeDependencies`
- [x] `nodesFromParsedTasks` maps every declared field, with `dependsOn` and `blocks` stringified through `refToString` and `validity` passed through from `taskValidity` untransformed
- [x] `unmetNodeDependencies` returns a ref for each of the three unmet cases — dependency missing from the map, dependency `unfinished`, dependency `invalid` — and an empty array when every dependency is `complete`
- [x] `deriveTaskViews` accepts `Record<string, GraphNode>` and no longer imports `ParsedTask`, `taskValidity`, `refToString`, or `unmetDependencies`
- [x] The state ladder in `deriveTaskViews` has the same branches in the same order as before this task, and every field of the returned view is unchanged
- [x] `loadPlan` converts before handing off, and the exported `Loaded` type's `byRef` is the narrow node map
- [x] The flightplan library is not modified by this task
- [x] Both existing test files pass with only their fixture factories changed — no assertion edited or deleted

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` — passes, with the same test count as before plus the new file's tests
- [x] `bun test packages/dispatch/skills/flightplan/scripts/` — passes, unchanged
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` — prints nothing. Run it against the root `tsconfig.json`; naming files on the command line drops the config and produces a dozen fake undefined-name errors. The repo-wide run is **not** green (86 pre-existing errors elsewhere), so zero total is not the bar — nothing under this grep is
- [x] `bun test packages/dispatch/skills/autopilot/scripts/graph-node.test.ts` — the new tests pass on their own

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                     | 2–3 (below bar)                                                                                                                                      | 4–5 (pass)                                                                                                                                                                                 |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correctness             | ×3     | The adapter drops a field, or the readiness helper implements a different rule than "missing, or not complete" | Adapter and helper work on well-formed input but one of the three unmet cases is mishandled, or `validity` is transformed rather than passed through | Every field maps, all three unmet cases return the ref, an all-complete dependency list returns empty, and the widened `NodeValidity` accepts the concrete validity with no mapping code   |
| Backward compatibility  | ×2     | The state ladder is rewritten, reordered, or collapsed; or the flightplan library is edited                    | The ladder is intact but a returned view field changed shape, or an existing assertion was edited to make a test pass                                | Ladder branch-for-branch identical, every returned field unchanged, the shared library untouched, and both existing suites pass with only fixture-factory edits                            |
| Test coverage           | ×2     | No tests for the new module                                                                                    | Happy-path conversion only; the readiness helper's unmet cases untested                                                                              | The adapter asserted on a whole returned node with `toEqual`, all three unmet cases plus the empty case covered, and a node whose `validity` is `invalid` shown to still block a dependent |
| Interface & readability | ×1     | The conversion is smuggled into the pure payload builder, or the exported names do not say what they do        | Types are right but the widening and the single-rule constraint are unexplained                                                                      | Conversion sits on the impure side, the pure builder stays free of markdown knowledge, and each non-obvious choice carries the one-line why-comment this codebase uses                     |
| Assumptions & docs      | ×1     | The omitted `ParsedTask` fields are dropped with no trace                                                      | The omission is visible in the type but the reason is not recorded                                                                                   | A one-line comment records why the rich fields are off the type and why the two validity fields widen, so the next producer does not re-litigate either                                    |

## Out of scope

- **Reading `graph.json`** — Deferred to the loader task in the dashboard bucket. This task only makes the derivation accept a narrow shape; nothing here parses a contract file or knows one exists.
- **Changing `TaskView`, `TreePayload`, or anything the frontend reads** — Deferred, permanently. The dashboard modules are already data-driven and this plan changes none of them; a field rename here would reach into committed frontend code.
- **Touching the flightplan library's own `unmetDependencies`** — Deferred, permanently. The CLI scout still calls it and its behaviour must not move. The new helper is an autopilot-side re-statement of the same rule for a different input type, not a replacement.
- **Deriving state from event entries** — Deferred to a later task in the dashboard bucket. The ladder moves unchanged here; teaching it a second source of truth is separate work.
