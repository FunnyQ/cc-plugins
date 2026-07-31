# SERVER-04: the tree endpoint

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/03, contract/02
> **Blocks**: server/05, ui/02
> **Status**: done

## Goal

`GET /api/tree` answers with the plan's full task tree and derived state, loaded fresh on every request.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/tree-api.ts` (new) — loading plus the pure payload builder.
- `packages/dispatch/skills/autopilot/scripts/tree-api.test.ts` (new) — tests for the builder.
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (modify) — register the route.

## Implementation notes

The payload shape and every field derivation are specified in the data model context file listed in
Required reading. Implement exactly that.

### Split loading from shaping

The interesting logic must be testable without a filesystem or a running server, so keep the two apart:

```ts
/** Impure: reads the tasks tree and the flightlog. */
type Loaded = {
  byRef: Record<string, ParsedTask>;
  errors: { file: string; bucket: string; reason: string }[];
};

export async function loadPlan(planDir: string): Promise<{
  slug: string;
  planTitle: string;
  /** Every directory under `tasks/`, from the listing — NOT derived from parsed tasks. */
  bucketDirs: string[];
  loaded: Loaded;
  entries: FlightlogEntry[];
}>;

/** Pure: shapes the response. */
export function buildTreePayload(input: {
  slug: string;
  planTitle: string;
  bucketDirs: string[];
  loaded: Loaded;
  entries: FlightlogEntry[];
}): TreePayload;
```

`bucketDirs` has to travel through the interface, not be recomputed from `byRef`. That is the whole
point: a bucket with no parseable files has no entries in `byRef`, so deriving the list from parsed
tasks would erase exactly the bucket the UI most needs to show. `loadPlan` reads the directory listing;
`buildTreePayload` copies it to `buckets` verbatim, sorted.

`buildTreePayload` calls `deriveTaskViews` and tallies the counts. It is the function the tests exercise.

### Read fresh on every request

There is no cache. A run mutates task files continuously and a stale tree is worse than a slow one; the
tree is a few dozen small files and the log is a few hundred KB at most. Do not add a watcher, a TTL, or
a memoisation layer — a subtly stale progress view is the exact failure this whole screen exists to
prevent.

### Degrade rather than fail

Three conditions are normal, not errors:

- **The flightlog does not exist.** Before the first agent logs anything there is no file. Treat it as
  an empty entry list.
- **A task file fails to parse.** Put the reason in the payload's `errors` array, tagged with the bucket
  it came from, and return `200` with whatever did parse. A malformed task must be visible in the UI as a
  problem, not cause a blank page.
- **Every file in a bucket fails to parse.** The bucket must still appear in `buckets`, because that list
  comes from the directory listing rather than from the tasks that parsed. Otherwise the bucket
  disappears entirely and its errors have nowhere to render.
- **The master spec is unreadable.** Fall back to the slug for the title, as the data model specifies.

The only condition that should fail the request is a plan directory that has vanished entirely, which
means the daemon is serving something that no longer exists.

### Import surface

```ts
import { loadAllTasks } from "../../flightplan/scripts/next-ready";
import { parseLog } from "../../flightplan/scripts/lib/flightlog";
import { deriveTaskViews } from "./fleet";
```

Nothing from the monitor package.

## Acceptance criteria

- [x] `GET /api/tree` returns the documented payload with correct `state`, `blockedBy`, and `counts`.
- [x] `slug`, `planTitle`, and `buckets` follow their stated derivations.
- [x] A missing flightlog yields a valid payload rather than an error.
- [x] A task file that fails to parse appears in `errors` with its bucket, and the request returns `200`.
- [x] A bucket whose files all fail to parse still appears in `buckets`.
- [x] An empty bucket directory appears in `buckets` with no tasks.
- [x] `buildTreePayload` copies `bucketDirs` rather than deriving the list from parsed tasks.
- [x] An unreadable master spec falls back to the slug as the title.
- [x] The tree and the log are re-read on every request; no cache, watcher, or TTL exists.
- [x] `buildTreePayload` is pure and testable without a filesystem or a server.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` — all green.
- [x] Start the daemon against a real tree, which has 6 tasks in 3 buckets all marked done:
      `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan "$(git rev-parse --show-toplevel)/docs/waypoints-skill" --no-open`
- [x] `curl -s localhost:5757/api/tree | jq '.counts'` → `total` 6 and `done` 6.
- [x] `curl -s localhost:5757/api/tree | jq '[.tasks[] | select(.state != "done")] | length'` → `0`.
- [x] `curl -s localhost:5757/api/tree | jq '.errors | length'` → `0`.
- [x] Point the daemon at this plan's own tree and confirm a mix of `ready` and `blocked` with populated
      `blockedBy` arrays.
- [x] Copy a tree to a scratch directory, corrupt one task's header, restart, and confirm the response is
      `200` with that file named in `errors` alongside its bucket.
- [x] Corrupt **every** file in one bucket and confirm that bucket still appears:
      `curl -s localhost:5757/api/tree | jq '.buckets'` still lists it, and `.errors` names each file.
- [x] Confirm freshness: with the daemon running, edit a task's `Status` on disk and re-request; the new
      state appears without a restart.
- [x] Confirm no cross-plugin import:
      `rg -n "packages/monitor" packages/dispatch/skills/autopilot/scripts/` returns nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Derived state is wrong, or a missing log errors | Correct payload but a parse error blanks the response, or results are cached | Payload matches the spec, all three degradation paths handled, always fresh |
| Test coverage | ×2 | No tests | Happy path only | Payload builder against fixtures, missing log, parse errors, title fallback, empty tree, empty bucket, fully unparseable bucket |
| Interface & readability | ×1 | Loading and shaping tangled; tests need a server | Split but the builder still touches disk | Pure `buildTreePayload`, impure `loadPlan`, route body trivial |
| Assumptions & docs | ×1 | No note on the absence of caching | Mentions it without the reason | Explains why the tree is re-read per request and why parse errors return 200 |

## Out of scope

- The event stream. Separate task in this bucket.
- Watching the tasks directory for changes. The client polls this endpoint instead; a second watcher over
  a few dozen files is not justified.
- Any write route. flightdeck is read-only.
- Caching or pagination. A plan tree is small enough that neither earns its complexity.
