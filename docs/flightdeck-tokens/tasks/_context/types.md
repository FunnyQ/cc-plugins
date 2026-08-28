# Frozen type contract

These declarations are the contract between every task in this plan. They are frozen
**before** any code is written, so no task has to guess what the layer above or below
it will hand over.

Write them exactly as given. If a task believes a declaration is wrong, it must stop
and report rather than edit it — a unilateral change silently breaks whatever consumes
it downstream.

**One task owns `usage-types.ts` and creates it.** Every later task imports from it and
must not redeclare, re-export, or edit these types. Adding the one optional field to
`FleetRow` described below is the sole exception, and it also has exactly one owner.

## New types

Declare these in `packages/dispatch/skills/autopilot/scripts/usage-types.ts`.
That file holds types only: **no imports at all**, and no runtime code.

The direction matters. `fleet.ts` imports `TokenCounts` from `usage-types.ts` for the
field added below, so `usage-types.ts` importing anything from `fleet.ts` would close a
cycle. Keep the edge one-directional: `usage-types.ts` depends on nothing, and every
other module depends on it.

```ts
/**
 * The four counters Claude Code writes on every billed assistant turn.
 * All four are collected even though only `input` and `output` are rendered —
 * they arrive in one object, so dropping two would cost more code than keeping them.
 */
export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** One Workflow-spawned agent's whole run, distilled from its transcript. */
export type AgentUsage = {
  /** Absolute path of the transcript. The stable identity across passes. */
  file: string;
  /** Task ref from the opening prompt, e.g. "ui/03" or "scout". Null when unparseable. */
  task: string | null;
  /** Role from the opening prompt, e.g. "dev" / "judge" / "mark-done". Null when unparseable. */
  role: string | null;
  /** Attempt from the opening prompt. Undefined when the prompt omits it. */
  attempt: number | undefined;
  /** ISO timestamp of the transcript's first line. Null when the file is empty. */
  startedAt: string | null;
  /** Every model that produced a billed turn, in first-seen order, deduplicated. */
  models: string[];
  counts: TokenCounts;
};

/** Plan-wide usage, addressed by task and in aggregate. */
export type UsageRollup = {
  /** Task ref -> counts, summed over every agent that named that ref. */
  byTask: Record<string, TokenCounts>;
  /** Counts from agents whose task ref could not be parsed. */
  unattributed: TokenCounts;
  /** Every counted token from every discovered agent. */
  totals: TokenCounts;
  /** How many agent transcripts fed this rollup. */
  agentCount: number;
};
```

**Conservation invariant**, which the attribution layer must hold and test:

```
sum(values(byTask)) + unattributed === totals
```

Row-level attribution is independent of this invariant. A row may end up with no
usage, and that does not move any total.

## Extension to an existing type

`FleetRow` lives in `packages/dispatch/skills/autopilot/scripts/fleet.ts`. Add exactly
one optional field to it. Reproduced here in full so no task needs to open that file:

```ts
export type FleetRow = {
  key: string;
  label: string;
  role: AgentRole;
  ref?: string;
  attempt?: number;
  lens?: string;
  status: FleetStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  message?: string;
  score?: ScoreEntry;
  outcome?: GateOutcome;
  /**
   * Tokens this agent burned. Absent when no transcript paired to the row —
   * an external-engine agent, or a run whose transcripts are gone. Absent must
   * render as unavailable, never as zero.
   */
  usage?: TokenCounts;
};
```

`usage` is **optional on purpose**. `undefined` and `0` mean different things and the
UI must distinguish them.

## Extension to the SSE frame

`FleetSnapshot` lives in `packages/dispatch/skills/autopilot/scripts/events-api.ts`
and is the JSON body of the `fleet` server-sent event. Reproduced in full:

```ts
export type FleetSnapshot = {
  rows: ReturnType<typeof aggregateFleet>;
  entryCount: number;
  logPresent: boolean;
  /**
   * Plan-wide token rollup. Always present; every counter is 0 and
   * `agentCount` is 0 when no transcript was found.
   */
  usage: UsageRollup;
};
```

`usage` is **required**, unlike `FleetRow.usage`. The frontend can rely on the object
existing and read `agentCount === 0` to decide whether to show the header total at all.

## Function signatures

The reader:

```ts
export type TranscriptSource = {
  /**
   * Re-scan and return the current state of every discovered agent.
   * Cheap to call repeatedly: only bytes appended since the last call are read.
   */
  read(): AgentUsage[];
};

/**
 * Bind a source to one plan directory. Does no I/O until `read()` is called.
 *
 * `projectsRoot` defaults to `join(homedir(), ".claude", "projects")`. It is the seam
 * that makes this layer testable and demonstrable: without it every fixture would have
 * to be written into the developer's real Claude Code state, which no test may touch.
 *
 * Production callers may pass it, and normally pass `undefined` — the value is threaded
 * down from an optional CLI flag, so both a real run and a fixture run take the same
 * code path. Passing `undefined` is identical to omitting it.
 */
export function createTranscriptSource(
  planDir: string,
  projectsRoot?: string,
): TranscriptSource;
```

The attribution layer — pure, no I/O, no clock:

```ts
/**
 * Attach per-agent usage to fleet rows and roll the whole set up.
 * Returns new row objects; never mutates the input.
 */
export function attributeUsage(
  rows: FleetRow[],
  agents: AgentUsage[],
): { rows: FleetRow[]; rollup: UsageRollup };
```

## Naming

The counter field names are `input` / `output` / `cacheRead` / `cacheWrite` — the
repo's camelCase, **not** the raw `input_tokens` / `cache_read_input_tokens` wire
names. Translate at the parse boundary and use the repo names everywhere inland.
