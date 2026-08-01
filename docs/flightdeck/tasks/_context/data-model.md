# Data model

> The shared contract between the flightlog, the derivation layer, the HTTP API, and the SPA.
> Everything an executor needs is inlined here.

## Flightlog entries

The audit trail is one append-only JSONL file at `docs/<slug>/.flightlog/run.jsonl`. Two kinds of
entry live in it. These types are declared in
`packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts`:

```ts
export type ScoreEntry = {
  kind: "score";
  ts: string;              // ISO timestamp
  task: string;            // task ref, e.g. "ui/03"
  attempt: number;         // 1-based
  agentLabel?: string;
  weighted: number;        // weighted average on the rubric's scale
  passed: boolean;
  hardFailed: boolean;
  missing: string[];       // dimensions the rubric declared but the scores omitted
  threshold: number;
  passOp: ">" | ">=";
  breakdown: { name: string; weight: number; score: number }[];
};

export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  role: string;            // free-form: dev / verify / judge / final-review
  attempt?: number;
  agentLabel?: string;
  message: string;
};

export type FlightlogEntry = ScoreEntry | NoteEntry;
```

`parseLog(content: string): FlightlogEntry[]` is deliberately tolerant: blank lines are skipped and a
malformed line is dropped rather than aborting the whole trail. Every consumer must inherit that
tolerance and never throw on a bad line.

### The `phase` extension

`NoteEntry` gains one optional field:

```ts
phase?: "start" | "end";
```

Semantics, chosen so existing logs keep working:

- `phase: "start"` — the agent has begun. Message may be empty.
- `phase: "end"` or **absent** — the agent has finished. Every entry written before this change has no
  `phase`, so it reads as a completion. That keeps all four `docs/*/.flightlog/run.jsonl` files on disk
  valid without migration.
- `renderRunlog` skips `phase: "start"` entries so `RUNLOG.md` output for existing logs stays
  byte-identical.

The CLI gains a matching flag:

```
bun flightlog.ts log <logfile> --task <ref> --role <role> [--phase start|end] \
    [--attempt N] [--agent <label>] --message "<text>"
```

`--message` stays required for an end entry. For a start entry it may be omitted, in which case the
stored `message` is the empty string.

## Agent labels

The orchestrator assigns every workflow agent a structured label. These are the exact forms it emits
(source: `packages/dispatch/skills/autopilot/references/orchestrator.md`):

| Label form | Example | Role | Ref | Attempt |
|---|---|---|---|---|
| `scout-wave-<n>` | `scout-wave-3` | `scout` | — | — |
| `dev:<ref>#<n>` | `dev:ui/03#2` | `dev` | `ui/03` | 2 |
| `dev-<engine>:<ref>#<n>` | `dev-codex:ui/03#2` | `dev` | `ui/03` | 2 |
| `verify:<ref>#<n>` | `verify:ui/03#2` | `verify` | `ui/03` | 2 |
| `judge:<ref>#<n>` | `judge:ui/03#2` | `judge` | `ui/03` | 2 |
| `review:<lens>#<n>` | `review:reuse#1` | `review` | — | 1 |
| `fix:<ref>#<n>` | `fix:ui/03#1` | `fix` | `ui/03` | 1 |
| `done:<ref>` | `done:ui/03` | `done` | `ui/03` | — |
| `block:<ref>` | `block:ui/03` | `block` | `ui/03` | — |
| `commit-post-loop` | — | `commit` | — | — |

Two labels are written as free text by the agent itself rather than generated, so parsing must be
tolerant:

- `<engine>-delegate`, e.g. `codex-delegate` — the external dev driver's own delegate call.
- Any label an agent substitutes for the literal `<your label>` placeholder in its prompt.

The parser signature:

```ts
export type AgentRole =
  | "scout" | "dev" | "verify" | "judge"
  | "review" | "fix" | "done" | "block" | "commit" | "unknown";

export type ParsedLabel = {
  role: AgentRole;
  ref?: string;      // "ui/03" when the label carries one
  attempt?: number;
  lens?: string;     // review lens key, e.g. "reuse", "codex"
  wave?: number;     // scout only
  raw: string;
};

export function parseAgentLabel(label: string): ParsedLabel;
```

An unrecognised label returns `{ role: "unknown", raw: label }`. Never throw.

The `dev-<engine>` form must be matched before the bare `dev:` form, otherwise `dev-codex:ui/03#2`
falls through to `unknown`.

## Task shape

`loadAllTasks(tasksDir)` in `packages/dispatch/skills/flightplan/scripts/next-ready.ts` returns
`{ byRef, pathByRef, buckets, errors, invalid }`, where each task is:

```ts
export type ParsedTask = {
  bucket: string;                 // "ui"
  nn: string;                     // "01"
  title: string;
  h1: string;
  requiredReading: string[];
  dependsOn: TaskRef[];           // { bucket, nn }[]
  blocks: TaskRef[];
  status: "todo" | "in-progress" | "done" | "blocked" | null;
  finalReview: boolean;
  sections: string[];
  body: string;
  rubric: Rubric | null;
};
```

`refToString({ bucket, nn })` yields `"ui/01"`. `errors` is non-empty when a file fails to parse or a
ref is duplicated; the API must surface those rather than silently dropping tasks. `invalid` lists tasks
that parsed but hold a malformed execution state (see below). Those tasks stay in `byRef` on purpose —
the dashboard must render them as invalid rather than drop them.

## Execution validity

`taskValidity(task)` in `scripts/lib/parse-task.ts` is the one rule every consumer reads — the linter,
readiness, and this dashboard. It returns `unfinished`, `complete`, or `invalid`. Two things make a task
invalid:

- **`status`** — the Status value is missing, decorated, or not one of the four bare words.
- **`completion-state`** — `Status: done` with any unticked checkbox in `## Acceptance criteria` or
  `## Verification`. Boxes in every other section carry no completion meaning.

A dependency is satisfied only by a **valid** completed task, so a task claiming `done` over an unticked
gate box keeps blocking its dependents instead of unlocking them.

## Derived task state

The task files record only `status`. The five states below are what the UI actually needs, and none of
them exists on disk. Derivation rules, in precedence order:

1. `taskValidity(task).kind === "invalid"` → **`invalid`**. This outranks the raw Status: a task
   claiming `done` over an unticked gate box must never read as done, or the dashboard would show the
   tree complete while the gate result is missing.
2. `status === "done"` → **`done`**
3. `status === "blocked"` → **`blocked`**
4. `status === "in-progress"` → **`in-progress`**
5. `status === "todo"` and the flightlog holds an unmatched `phase: "start"` entry for this ref →
   **`in-progress`**. This case matters: autopilot only writes `Status: done` at the very end, so a
   task actively being worked still reads `todo` on disk.
6. `status === "todo"` and every dependency is validly complete → **`ready`**
7. otherwise → **`blocked`**, with `blockedBy` listing the dependency refs that are not validly
   complete — an invalid dependency appears here too

```ts
export type TaskState =
  | "done"
  | "in-progress"
  | "ready"
  | "blocked"
  | "invalid";

export type TaskView = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;      // raw file status
  state: TaskState;           // derived
  invalidReason: string | null;  // why state is "invalid"; null otherwise
  blockedBy: string[];        // unfinished dependency refs; empty unless state is "blocked"
  dependsOn: string[];
  blocks: string[];
  finalReview: boolean;
  attempts: number;           // highest attempt seen for this ref in the flightlog, else 0
  latestScore: {
    weighted: number;
    threshold: number;
    passOp: ">" | ">=";
    passed: boolean;
    hardFailed: boolean;
    breakdown: { name: string; weight: number; score: number }[];
  } | null;
};

export function deriveTaskViews(
  byRef: Record<string, ParsedTask>,
  entries: FlightlogEntry[],
): TaskView[];
```

An "unmatched start" means: for a given `(ref, role, attempt)` there is a `phase: "start"` note with no
later note for the same triple that has `phase: "end"` or no `phase` at all.

## Fleet rows

One row per agent the flightlog has seen, newest first:

```ts
export type FleetStatus = "in-flight" | "finished";

export type FleetRow = {
  key: string;               // stable unique row id — see "Row keys" below
  label: string;
  role: AgentRole;
  ref?: string;
  attempt?: number;
  lens?: string;
  status: FleetStatus;
  startedAt?: string;        // ISO, from the start entry
  endedAt?: string;          // ISO, from the end entry
  elapsedMs?: number;        // endedAt - startedAt; undefined while in flight
  message?: string;          // the end entry's message
  score?: ScoreEntry;        // attached when a score entry shares this ref + attempt
};

export function aggregateFleet(entries: FlightlogEntry[]): FleetRow[];
```

**Row keys.** `key` must be unique across the returned rows, because the client uses it to key its
rendering. It cannot simply be `agentLabel`: that field is optional, and every pre-existing trail on disk
has entries without one. Derive it as:

1. `agentLabel` when present.
2. Otherwise `` `${task}|${role}|${attempt ?? "-"}` `` — the same identity the pairing rule falls back to.
3. If that still collides with a key already emitted, append `#2`, `#3`, and so on in entry order. Two
   unlabelled entries sharing a task, role, and attempt are indistinguishable, so a deterministic
   suffix is the only honest answer; silently merging them would hide one agent's row entirely.

Cover all three branches in the aggregation tests, including the collision case.

Pairing rule: entries pair on `agentLabel` when present, and fall back to `(task, role, attempt)` when
it is absent. A start with no matching end stays `in-flight` — there is deliberately no staleness
ceiling in v1, so an agent that dies without writing an end entry reads as in flight until the run
ends.

`elapsedMs` must be computed from the two timestamps, never from the wall clock, so the function stays
pure and testable. An in-flight row therefore ships with `elapsedMs` undefined; the browser is free to
tick a live display against its own clock from `startedAt`, which is a rendering concern, not a
derivation one.

## HTTP API

Both endpoints bind `127.0.0.1` only.

### `GET /api/tree`

```jsonc
{
  "slug": "waypoints-skill",
  "planTitle": "Waypoints skill",       // see the derivation note below
  "buckets": ["integration", "scripts", "skill"],
  "tasks": [ /* TaskView[] */ ],
  "counts": { "total": 6, "done": 6, "inProgress": 0, "ready": 0, "blocked": 0, "invalid": 0 },
  "errors": []                           // parse errors, surfaced not swallowed — shape below
}
```

Responds `200` with `errors` populated rather than failing, so a malformed tree still renders what
parsed.

**Field derivations:**

- `slug` — the basename of the plan directory.
- `planTitle` — the first `# ` heading of the plan directory's master spec, the file named `PLAN.md`
  sitting beside `tasks/`. If that file is missing or unreadable, fall back to `slug`. Never fail the
  request over it; the title is decoration and the tree is the payload.
- `buckets` — every bucket **directory** under `tasks/`, sorted. Derive it from the directory listing,
  not from the tasks that parsed. A bucket whose files all failed to parse must still appear, or the UI
  cannot render a lane heading to hang its errors on, and the bucket vanishes silently.
- `errors` — one entry per unparseable file, carrying the bucket it belongs to so the UI can place it:

  ```ts
  type TreeError = { file: string; bucket: string; reason: string };
  ```

  `loadAllTasks` returns `{ file, reason }`; derive `bucket` from the file's parent directory name.
- `counts` — one tally per derived state, plus `total`.

### `GET /api/events`

Server-Sent Events carrying **aggregated fleet snapshots**, not raw log lines.

The server owns aggregation. It keeps the parsed entry list in memory for the connection, re-runs
`aggregateFleet` whenever the log grows, and emits the resulting rows. The browser renders what it is
given and implements none of the pairing, ordering, label-parsing, or score-attachment rules.

That ownership is deliberate. Those rules are unit-tested once, in one language, in `fleet.ts`. A second
implementation in the browser would drift the moment either side changed, and the two would disagree
about something the user is watching in real time.

Frame sequence on connect:

1. one `fleet` event carrying the full current row set, derived from whatever the log already holds
2. `fleet` events as the log grows, each carrying the **full current row set** again
3. a `:heartbeat` comment every 25s so idle sockets are not dropped

```
event: fleet
data: {"rows":[ /* FleetRow[] */ ],"entryCount":42,"logPresent":true}
```

Payload fields:

- `rows` — the complete `FleetRow[]`, ordered as specified above (in-flight first, then newest first).
- `entryCount` — how many entries the rows were derived from. Lets a client show volume without
  receiving the entries.
- `logPresent` — `false` while the run has not started and the log file does not exist yet. The row set
  is empty in that case. This is a normal pre-run state, not an error.

Full snapshots rather than deltas, for three reasons: a run's fleet is at most a few hundred rows and a
few KB of JSON; a reconnecting client needs no replay protocol; and a snapshot cannot desynchronise the
way an applied delta stream can. Debounce emission to at most one snapshot per 250ms so a burst of
appends does not produce a burst of frames.

A missing `run.jsonl` is **not** a 404. The run may not have started yet. Hold the connection open,
emit a `logPresent: false` snapshot immediately so the client can render its waiting state, and re-check
on an interval until the file appears. Returning 404 would make the browser's `EventSource` fail
permanently with no auto-reconnect, leaving the panel blank for the whole run.

Lines that do not parse as a `FlightlogEntry` are skipped, exactly as `parseLog` already does. They
never appear in `entryCount` and never break the stream.
