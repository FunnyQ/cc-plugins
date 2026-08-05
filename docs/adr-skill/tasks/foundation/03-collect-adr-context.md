# FOUNDATION-03: Collect the trail context, read-only

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: foundation/01, foundation/02
> **Blocks**: triage/02
> **Status**: done

## Goal

A script that hands a triage agent the whole unprocessed backlog as entry skeletons, and full entry bodies only for the ids it asks for, without writing anything to the trail.

## Files to create / modify

- `packages/chronicle/skills/adr/scripts/collect-adr-context.ts` (new) — the collector
- `packages/chronicle/skills/adr/scripts/collect-adr-context.test.ts` (new) — its unit tests

## Implementation notes

### It builds on the shared cockpit trail reader

Import `logRoot`, `gitRootOf`, the `DecisionRecord` type, `isDecisionRecord`, and `readDecisionLog` from `packages/chronicle/shared/scripts/cockpit-trail.ts`. Do not re-implement any of them here, and do not import anything from `packages/monitor/` — plugins install into version-pinned cache directories, so a cross-package relative path does not resolve on a user machine.

### It reads the log directory, not the registry

This inversion is the whole point of the collector. The cockpit registry reaps entries older than fourteen days on every write. Measured in this repository: 63 log files against 27 matching registry entries. The lost tail is exactly the part that can answer whether a decision held up over time, so a registry-backed listing sees under half the history and loses the half that matters most.

Use the registry only if session metadata is genuinely needed. Never use it as the list of sessions.

### Sources it globs

Both live under the trail root that the shared walk-up resolves from cwd:

- `.cockpit/logs/*.jsonl` — the inbox, the unprocessed backlog
- `.cockpit/archive/watch/*.jsonl` — watched sessions, which triage compares against fresh candidate clusters to fire the wake condition

It does **not** read `.cockpit/archive/done/` during triage. The drafting path reads `done/` separately when it has to reconstruct a decision spanning an already-processed session. This collector exposes that as an explicit opt-in flag rather than doing it by default, because pulling the whole archive into a triage run defeats the point of an inbox.

### Export surface

```ts
export type Bucket = "inbox" | "watch" | "done";

export type SessionFile = {
  sessionId: string;   // the log filename without .jsonl
  path: string;
  bucket: Bucket;
  mtimeMs: number;
  entryCount: number;
};

/** Pass 1 output. Deliberately omits reason, tradeoff, facets, options, diagram. */
export type EntrySkeleton = {
  id: string;
  sessionId: string;
  kind: DecisionRecord["kind"];
  decision: string;
  timestamp: string;
  files: string[];
};

export type AdrContext = {
  trailRoot: string;      // the directory holding .cockpit/, or "" when there is none
  hasTrail: boolean;
  sessions: SessionFile[];
  skeletons: EntrySkeleton[];
  adrDir: string;         // docs/adr under the GIT root — not under trailRoot; see below
  error?: string;
};

/** A full record plus the session it came from. `DecisionRecord` alone has no session field. */
export type EntryBody = DecisionRecord & { sessionId: string };

export function toSkeleton(record: DecisionRecord, sessionId: string): EntrySkeleton;
export function collectContext(cwd: string, opts?: { includeDone?: boolean }): Promise<AdrContext>;
export function fetchBodies(cwd: string, ids: string[]): Promise<EntryBody[]>;
```

`EntryBody` exists because `sessionId` is not a field of `DecisionRecord` — the session is the *file*
the record was read from, not something the record knows about itself. Returning bare
`DecisionRecord[]` would drop it, and the drafting path needs it: every ADR evidence entry carries
the session id alongside the entry id, and by the time a body is fetched the session may already
have been archived, so the caller cannot recover it by re-globbing. Use `EntryBody` consistently —
in the export surface, in the `--bodies` CLI payload, and in the tests.

`fetchBodies` searches **every bucket — the inbox, `archive/watch/`, and `archive/done/`** — and it
does so unconditionally, with no opt-in flag. That is deliberately unlike `collectContext`, which
defaults to the inbox plus the watched bucket. The two answer different questions. Collection asks
*"what is still unprocessed?"*, so including already-dispositioned sessions would re-surface work
that was settled. Body lookup asks *"what did entry `X` actually say?"*, and the drafting path
reaches into already-processed sessions by design: reconstructing a decision that spans an archived
session is the stated reason the archive exists at all. An id that resolves in the inbox before
archiving and stops resolving after it would break the ADR flow in a way nothing reports.

Ids are unique across the whole trail, so there is no ambiguity to resolve — the first match wins.

### `trailRoot` and `adrDir` are resolved from different roots

They look like they should come from the same place. They must not.

`trailRoot` comes from `logRoot(cwd)`, which walks up for an *existing* `.cockpit/` before falling
back to the git root. That walk-up is a deliberate escape hatch: a hand-made
`packages/x/.cockpit` keeps its own trail. So `trailRoot` can legitimately be a subdirectory.

`adrDir` must be `join(gitRootOf(cwd) ?? cwd, "docs", "adr")` — the **git** root, always. ADRs are
repository-level records; there is exactly one numbering sequence per repository, and one place a
reader looks for it.

Deriving `adrDir` from `trailRoot` is the trap, and it is silent. Under a nested trail it would
produce `packages/x/docs/adr`, which is empty — so the index reports no existing records, duplicate
detection finds nothing to match against, the next number resets to `0001`, and the drafting path
writes a record into a subtree nobody reads. Every one of those looks like correct behaviour on a
repository that simply has no ADRs yet.

Outside a git repository the two collapse to cwd, which is the right answer for both.

### `toSkeleton` is the pure function the tests lean on

It must strip `reason`, `tradeoff`, `facets`, `options`, and `diagram`. A skeleton that leaks a `reason` defeats the two-pass design outright: a single `reason` runs to roughly 400 words, a `diagram` can hold a whole Mermaid graph, and this repository alone holds around 352 entries. Loading all of that at once does not fit in a useful context window.

Keep it pure — take a record and a session id, return a skeleton. No filesystem access inside it.

### CLI shape

Mirror how the branch analyzer hands large payloads to an agent: write the JSON to a temp file and print a one-line JSON summary carrying the path, so a 352-entry payload never lands in an agent's context by accident.

```
bun collect-adr-context.ts                       # skeletons; writes the payload, prints its path
bun collect-adr-context.ts --include-done        # also globs the done archive
bun collect-adr-context.ts --bodies <id,id,...>  # EntryBody[] for those ids only — full record + sessionId
```

The payload path follows the existing convention — `/tmp/chronicle/adr/context-<timestamp>-<pid>.json`, with the directory created via `mkdirSync(dir, { recursive: true })`. Stdout carries a JSON object whose `outputPath` field is that path, alongside cheap counts the caller can read without opening the file:

```ts
// stdout, one line
{ "outputPath": "/tmp/chronicle/adr/context-1754438400000-51234.json",
  "hasTrail": true, "sessionCount": 63, "entryCount": 352,
  "adrDir": "/Users/you/repo/docs/adr" }
```

`adrDir` is on stdout, not only inside the payload, and that is load-bearing. Its consumer is the
collecting agent, which runs the ADR index reader next — and that reader takes its directory as an
argument, with no default. The collecting agent is also forbidden from opening the payload, so a
field that lives only inside the payload is a field it cannot reach. Without `adrDir` on stdout the
agent has to derive `docs/adr` itself, which is exactly the silent trap this section warns about.

### Empty and missing behaviour

State these in code and cover them in tests:

- A repository with no `.cockpit/` returns `hasTrail: false`, `trailRoot: ""`, empty `sessions` and `skeletons`, and exits 0. It never throws.
- It never creates `.cockpit/`, `archive/`, `done/`, or `watch/`. Creating the archive layout belongs to the archiver, not here.
- An existing but empty `logs/` directory returns `hasTrail: true` with an empty session list.
- A malformed JSONL line is skipped, not fatal — the same tolerance the shared reader already has. A file of entirely unparseable lines yields a `SessionFile` with `entryCount: 0`, not an error.
- `fetchBodies` with an id that matches nothing returns fewer records than ids requested, without throwing.
- `fetchBodies` finds an id whose session was already archived into `archive/done/`, even though `collectContext` would not have listed that session.

## Acceptance criteria

- [x] `packages/chronicle/skills/adr/scripts/collect-adr-context.ts` and `packages/chronicle/skills/adr/scripts/collect-adr-context.test.ts` both exist.
- [x] The collector imports `logRoot`, `DecisionRecord`, `isDecisionRecord`, and `readDecisionLog` from `packages/chronicle/shared/scripts/cockpit-trail.ts` rather than re-implementing them, and imports nothing from `packages/monitor/`.
- [x] It builds its session list by globbing `.cockpit/logs/` and `.cockpit/archive/watch/` under the resolved trail root, and never derives that list from the cockpit registry.
- [x] `adrDir` resolves from `gitRootOf(cwd) ?? cwd`, never from `trailRoot`, so a nested `.cockpit/` still points ADRs at the repository-level `docs/adr/`.
- [x] `toSkeleton` returns an object with no `reason`, `tradeoff`, `facets`, `options`, or `diagram` key.
- [x] `fetchBodies` returns `EntryBody` records — full record plus `sessionId` — only for the requested ids, ignores unknown ids without throwing, and resolves an id that lives in `archive/done/` as readily as one in the inbox. The `--bodies` CLI payload carries `sessionId` on every record too, asserted by a test at the CLI level and not only at the function level.
- [x] A repository with no `.cockpit/` returns `hasTrail: false` with empty arrays, and the CLI exits 0.
- [x] The script creates no directory under `.cockpit/` and modifies no file there.
- [x] The payload is written to a path under `/tmp/chronicle/adr/` and that path is printed on stdout as the `outputPath` field of a one-line JSON summary.
- [x] That stdout summary also carries `adrDir`, so a caller that never opens the payload can pass the directory straight to the ADR index reader.

## Verification

- [x] `bun test packages/chronicle/skills/adr/scripts/collect-adr-context.test.ts` passes with zero failures, covering: no trail at all, an empty log directory, a malformed JSONL line, the watch directory included in the session list, an unknown id passed to a body request, a skeleton asserted to have no `reason` key, and a nested `.cockpit/` under a git root where `trailRoot` is the subdirectory while `adrDir` still resolves to the repository-level `docs/adr/`.
- [x] Run `bun packages/chronicle/skills/adr/scripts/collect-adr-context.ts` from this repository root, read the printed payload, and confirm its session count matches the **combined** count of both source directories: `ls .cockpit/logs/*.jsonl 2>/dev/null | wc -l` plus `ls .cockpit/archive/watch/*.jsonl 2>/dev/null | wc -l`. Comparing against the inbox alone would fail a correct implementation the moment any watched session exists. Also confirm the per-bucket split in the payload matches those two numbers individually.
- [x] Record `md5 .cockpit/logs/*.jsonl` before and after that run and confirm every sum is unchanged, proving the collector writes nothing.
- [x] Run `bun packages/chronicle/skills/adr/scripts/collect-adr-context.ts` in a scratch directory that is not a git repository and confirm it exits 0 with `hasTrail: false`.
- [x] `git status --short -- packages/chronicle/skills/adr/scripts/collect-adr-context.ts packages/chronicle/skills/adr/scripts/collect-adr-context.test.ts` shows both paths dirty.
- [x] Do not run `bunx tsc --noEmit` — `@types/bun` is absent in this repo, so it floods with pre-existing errors unrelated to this change. `bun test` is the type-and-behaviour gate here.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Lists sessions from the registry, re-implements the shared reader, or writes into `.cockpit/` | Works on a populated trail but throws on a repository with none, or leaks a body field into a skeleton | Globs both source directories, skeletons carry no body fields, missing-trail and malformed-line paths return cleanly, and nothing under `.cockpit/` is touched |
| Test coverage | ×2 | No tests, or tests that only construct types | Happy path only — a populated trail asserted for a non-zero session count | Empty-trail, empty-directory, malformed-line, watch-included, and unknown-id cases all covered, plus an explicit assertion that a skeleton has no `reason` key |
| Interface & readability | ×1 | I/O smuggled into `toSkeleton`, or types that do not match the declared surface | Exports match but `collectContext` mixes globbing, parsing, and payload writing in one unstructured function | `toSkeleton` is pure and separately testable, the three exports match the declared signatures, and glob / parse / serialize are distinct steps |
| Assumptions & docs | ×1 | The registry-versus-directory choice is unexplained, so a later reader "fixes" it back | The choice is noted but the 63-versus-27 evidence is missing | A comment states why the directory is read instead of the registry, with the measured counts, and why `done/` is opt-in |

## Out of scope

- Clustering entries or judging them against the promotion threshold — Deferred. That is the triage agent's job; this script stays deterministic and opinion-free.
- Reading existing ADR metadata, numbering, or lifecycle links — Deferred. A separate foundation task owns the ADR index reader; this collector only reports where the ADR directory is via `adrDir`.
- Any write under `.cockpit/`, including creating the archive layout — Deferred. Exactly one component writes there, and it is the archiver, not this one.
- Reading `.cockpit/archive/done/` by default — Deferred. It stays behind `--include-done`, because pulling the whole archive into every triage run defeats the inbox model.
