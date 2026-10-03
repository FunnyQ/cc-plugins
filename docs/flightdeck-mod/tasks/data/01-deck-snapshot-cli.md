# DATA-01: Deck snapshot CLI

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: mod/01, mod/02
> **Status**: done
> **Models**: dev=opus/high

## Goal

A bun CLI prints one `DeckSnapshot` JSON for a plan dir, and resolves the newest plan with `--latest`, by reusing the existing flightdeck data code.

## Files to create / modify

- `packages/dispatch/hooks/flightdeck/types.ts` (new) — the `DeckSnapshot` types, copied verbatim from `../_context/shared.md`. Type-only, no imports. This task owns creating it.
- `packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts` (new) — pure `layerByDepth` and `buildDeckSnapshot`, impure `latestPlan`, and the CLI main.
- `packages/dispatch/skills/autopilot/scripts/deck-snapshot.test.ts` (new) — `bun test` cases.

## Implementation notes

### Reused code (do not reimplement)

All in `packages/dispatch/skills/autopilot/scripts/`:

- `detectSource(planDir): "tasks" | "graph" | "none"` and `loadGraphPlan(planDir)` — `graph-source.ts`.
- `loadPlan(planDir)` and `buildTreePayload({ deckSource, slug, planTitle, repo, bucketDirs, loaded, entries }): TreePayload` — `tree-api.ts`. Both loaders return `{ slug, planTitle, repo, bucketDirs, loaded, entries }`; `entries` is the parsed run log.
- `aggregateFleet(entries): FleetRow[]` — `fleet.ts`. `FleetRow` and `TaskView` types come from `fleet.ts`; `TreePayload` from `tree-api.ts`.

Import `DeckSnapshot`, `DeckTask`, `DeckAgent` from `../../../hooks/flightdeck/types.ts`. Do not read transcripts or attribute tokens: the pane polls this CLI every 2 s.

### `layerByDepth`

```ts
export function layerByDepth(
  tasks: { ref: string; dependsOn: string[] }[],
): { waves: string[][]; unschedulable: string[] }
```

Pure. Static dependency depth over the whole input, done tasks included:

- A task with no `dependsOn` is wave 1 (`waves[0]`).
- Otherwise its wave is 1 + the highest wave among its dependencies.
- A dependency not in the input, or membership in a cycle, sends the task to `unschedulable` — and every task that depends on it, transitively.
- Refs inside a wave keep input order. `unschedulable` is sorted.

Sample: `a` (none), `b` → `a`, `c` → `a`, `d` → `b, c` gives `waves = [["a"], ["b", "c"], ["d"]]`. Adding `e` → `missing` and `f` → `e` gives `unschedulable = ["e", "f"]`. `x` → `y`, `y` → `x` gives `unschedulable = ["x", "y"]`.

### `buildDeckSnapshot`

```ts
export function buildDeckSnapshot(input: {
  plan: string;
  payload: TreePayload;
  fleet: FleetRow[];
}): DeckSnapshot
```

Pure. Field by field:

- `deckSource`, `slug`, `planTitle`, `counts` — copied from `payload`. `plan` — from `input.plan`.
- `tasks` — keyed by ref. Each `TaskView` maps to `DeckTask { ref, title, state, attempts, score }`. `score` is `{ weighted, threshold, passed }` from `latestScore`, or `null` when `latestScore` is null.
- `buckets` — one entry per name in `payload.buckets`, in that order. `done` and `total` count the tasks whose `bucket` equals the name.
- `waves`, `unschedulable` — `layerByDepth(payload.tasks)`.
- `currentWave` — 1-based index of the lowest wave holding a task whose state is not `done`; `null` when no wave holds a non-done task — every task done, the tree empty, or only `unschedulable` work left.
- `agents` — `fleet` rows with `status === "in-flight"` only, sorted by `startedAt` ascending, rows without `startedAt` last. Map `ref`, `attempt`, `startedAt` to `null` when absent; copy `role` and `label`.
- `errors` — `payload.errors.length`.

### `latestPlan`

```ts
export async function latestPlan(root: string): Promise<string | null>
```

Impure. Among the dirs `<root>/docs/*/` that hold `.flightlog/run.jsonl`, return the absolute dir whose `run.jsonl` has the newest mtime. Return `null` when none exists or `<root>/docs` is missing.

### CLI main

Guard with `if (import.meta.main)`.

- `bun deck-snapshot.ts <planDir>` — resolve a relative `planDir` against cwd. `detectSource`:
  - `"none"` → stderr `no tasks/ or graph.json in <dir>`, exit 2.
  - `"tasks"` → `loadPlan`; `"graph"` → `loadGraphPlan`.
  - Then `buildTreePayload({ ...loaded, deckSource })`, `aggregateFleet(loaded.entries)`, `buildDeckSnapshot`. Print `JSON.stringify(snapshot)` on stdout, exit 0.
- `bun deck-snapshot.ts --latest <dir>` — print `{"plan":"<abs>"}`, exit 0; or stderr `no flightplan run under <dir>/docs`, exit 3.

### Test fixtures

Follow the existing fixture approach: `graph-source.test.ts` builds a temp dir with `mkdtemp(join(tmpdir(), …))` and writes a `graph.json`; `tree-api.test.ts` builds temp task trees the same way. Build the tasks and graph fixtures in temp dirs and spawn the CLI with `Bun.spawn(["bun", <script path>, dir])`. Set mtimes with `utimes` for the `--latest` case.

## Acceptance criteria

- [x] `layerByDepth` tests cover a chain, a diamond (the sample above), done tasks keeping their wave, a dangling dependency with a dependent, and a 2-cycle.
- [x] `buildDeckSnapshot` tests check `counts`, `buckets` order and tallies, `currentWave` (mid-run, all done, empty, a pure 2-cycle tree, and a tree whose schedulable tasks are all done while a dangling-dep task remains — the last two give `null`), `agents` (in-flight only, ordering, missing `startedAt` last, nulls), and `score` mapping both ways.
- [x] The CLI on a temp tasks-tree fixture exits 0 and prints JSON with every `DeckSnapshot` key and `deckSource: "tasks"`.
- [x] The CLI on a temp `graph.json` fixture exits 0 with `deckSource: "graph"`.
- [x] The CLI on a dir holding neither exits 2 with the stated stderr.
- [x] `--latest` returns the dir with the newest `run.jsonl` mtime, and exits 3 with the stated stderr when no run exists.
- [x] `packages/dispatch/hooks/flightdeck/types.ts` holds no `import` statement and matches the contract in `../_context/shared.md`.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/deck-snapshot.test.ts` passes.
- [x] `bunx --bun tsc --noEmit | grep -E 'deck-snapshot|hooks/flightdeck/types'` prints nothing.
- [x] `bun packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts docs/flightdeck-mod | bun -e 'const s=JSON.parse(await Bun.stdin.text()); if(!Array.isArray(s.waves)) process.exit(1)'` exits 0.
- [x] `grep -c '^import' packages/dispatch/hooks/flightdeck/types.ts` prints `0`.

## Eval rubric

> Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared bands: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | JSON shape departs from the contract, or waves are computed from remaining work | happy path right; cycles, dangling deps, or `currentWave` edges wrong | every field matches the contract; cycles and dangling deps land in `unschedulable` with their dependents |
| Test coverage | ×2 | no tests | layering happy path only | layering edges, snapshot mapping, both CLI sources, exit 2 and exit 3 all covered |
| Interface & readability | ×1 | I/O mixed into the pure functions | pure but types loose or duplicated | pure functions typed from the reused modules; I/O only in `latestPlan` and main |
| Assumptions & docs | ×1 | silent exit codes or magic paths | behaviour right but unexplained | exit codes and the no-tokens corner-cut each carry a one-line why |

## Out of scope

- Token or usage attribution — Deferred. Reason: it reads transcripts, too costly at the pane's 2 s poll.
- Any change to `flightdeck.ts`, its server routes, or `daemon.json` — Deferred. Reason: the pane reads files and must not depend on the server.
