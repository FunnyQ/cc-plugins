# WORK-03: SSE Wiring

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/types.md`
> - `../_context/data-model.md`
>
> **Depends on**: work/02
> **Blocks**: work/04
> **Status**: done

## Goal

Carry the plan's token rollup to the browser on the existing `fleet` server-sent-event
frame, refreshed on that stream's own poll cadence, without adding a second loop or a
second endpoint.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/events-api.ts` (modify) — extend the
  snapshot type, thread the transcript source through the stream closure, and attribute
  usage before each frame is emitted
- `packages/dispatch/skills/autopilot/scripts/events-api.test.ts` (modify) — cover the
  new frame contents and the degraded path
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (modify) — two changes.
  First, the events handler gains a parameter, so its one caller must pass it; the route
  already has the plan directory in hand as the server's `plan` argument. This edit is
  **in scope**: a signature change that leaves its own call site broken is not a
  finished change. Second, add the `--projects-root` flag described below.

## Implementation notes

Two collaborators already exist and must be imported, never re-implemented:

- **the transcript source** — `createTranscriptSource(planDir): TranscriptSource`, whose
  `read(): AgentUsage[]` re-scans and returns the current state of every discovered
  agent. It is incremental: bytes already consumed are never re-read.
- **the attribution function** — `attributeUsage(rows, agents): { rows, rollup }`, a
  pure function that attaches per-agent usage to fleet rows and rolls the set up.

Both signatures are frozen in `../_context/types.md`.

### The snapshot type gains a required field

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

`usage` is **required, not optional**. A frontend forced to branch on whether the field
exists will get that branch wrong once, and the bug will look like missing data rather
than missing code. An empty rollup is a value; absence is not.

Import `UsageRollup` and `AgentUsage` from `./usage-types`.

### The frame formatter takes the agents as a third argument

```ts
export function formatFleetFrame(
  entries: FlightlogEntry[],
  logPresent: boolean,
  agents: AgentUsage[],
): string
```

Inside, aggregate the rows exactly as today, then hand those rows and the agents to the
attribution function, and put the returned rows and rollup into the payload:

```ts
const attributed = attributeUsage(aggregateFleet(entries), agents);
const payload: FleetSnapshot = {
  rows: attributed.rows,
  entryCount: entries.length,
  logPresent,
  usage: attributed.rollup,
};
return `event: fleet\ndata: ${JSON.stringify(payload)}\n\n`;
```

Keeping this function exported and pure over its three inputs is what makes the whole
seam testable without a filesystem, a server, or a clock. Do not move attribution into
the stream closure, and do not pass the source object in here — this function must
never touch I/O.

The emitted envelope does not change: the text still begins with `event: fleet\n` and
still ends with a blank line, so a client that ignores the new field is unaffected.

### Threading the source into the stream

The stream handler already owns a per-stream closure holding the flightlog cursor, the
held partial line, and the decoded entries. The transcript source belongs in that same
closure, created **once per stream**, so its byte cursors survive across every snapshot
that stream emits. A source created per snapshot would re-read every transcript from
byte zero each time and defeat the entire incremental design.

The handler currently receives only the run-log path, so the plan directory has to
reach it. Both ends change:

```ts
export function eventsHandler(
  request: Request,
  logPath: string,
  planDir: string,
): Response
```

The single call site is the server's route for the events endpoint, in
`packages/dispatch/skills/autopilot/scripts/flightdeck.ts`. That route already has the
plan directory in scope — it derives the run-log path from it — so it passes both.

Inside the handler, alongside the existing cursor state:

```ts
const usageSource = createTranscriptSource(planDir);
```

### Cadence — reuse the existing loop, add nothing

**Do not add a `setInterval`, a filesystem watcher, or a debouncer.** The check-file
routine already runs on a 2-second poll plus watches on the log file and its parent
directory, and already schedules a debounced snapshot. Read the transcript source
inside the existing snapshot path, so the usage numbers refresh exactly when the fleet
rows do:

```ts
const emitSnapshot = (): void => {
  enqueue(formatFleetFrame(entries, logPresent, readAgents()));
};
```

A second timer would double the disk work and, worse, let the two halves of one frame
disagree about when they were measured — a row could show a finished agent beside a
usage figure taken before that agent's last turn landed.

### Cost control — why this read is affordable

Calling the source on every debounced snapshot is acceptable **only because the read is
incremental**: an unchanged transcript costs one `stat` and zero bytes read. Put a
one-line comment at the call site saying so, and naming what would break it — any
change that makes the source re-parse a whole file per call turns a 250 ms debounce
into a repeated full scan of every transcript the plan ever produced.

### Failure behaviour — degrade, never take the panel down

If reading the source throws for any reason, the frame must still go out, carrying an
empty rollup:

```ts
function readAgents(): AgentUsage[] {
  try {
    return usageSource.read();
  } catch {
    // A broken token panel must not take the fleet panel down with it.
    return [];
  }
}
```

**A test seam is required, or that `catch` is unreachable from a test.** The handler
builds its own source, so nothing outside can make `read()` throw.

The handler needs two optional inputs — where to look, and a pre-built source to look
with. Take them as one options object rather than two trailing positional optionals,
which are easy to pass in the wrong order and impossible to read at a call site:

```ts
export function eventsHandler(
  request: Request,
  logPath: string,
  planDir: string,
  options?: { projectsRoot?: string; source?: TranscriptSource },
): Response;
```

Inside, build the source exactly once per stream:

```ts
const usageSource = options?.source ?? createTranscriptSource(planDir, options?.projectsRoot);
```

`source` is the unit-test seam: a stub whose `read()` throws, or one returning fixed
agents, needing no filesystem. `projectsRoot` is the end-to-end seam, carrying the CLI
flag down. Neither is set in normal use.

### The `--projects-root` flag

The server takes an optional `--projects-root <dir>` and threads it into the transcript
source it builds. It defaults to the real location, so normal use is unchanged and no
existing invocation needs editing.

It exists because every manual gate in this plan otherwise reads whatever transcripts
happen to survive on the machine running it, and Claude Code deletes those on a
retention schedule. With the flag, a gate points at a generated fixture and gets the
same answer today, next month, and on someone else's laptop. See
`../_context/shared.md` for the generator and the rule.

**The complete call chain, end to end.** Implement exactly this and nothing more:

1. The CLI parses `--projects-root <dir>` beside the existing `--port` and `--plan`.
2. It passes the value to the server factory, which gains a trailing optional parameter
   for it and holds it in the same closure that already holds `plan`.
3. The events route calls
   `eventsHandler(request, runLogPath(plan), plan, { projectsRoot })`.
4. The handler builds `createTranscriptSource(planDir, options?.projectsRoot)`.

`undefined` flows the whole way when the flag is absent, and the source falls back to
the real location — so every existing invocation behaves exactly as before.

The server does **not** construct a transcript source itself. Source construction stays
inside the stream closure, one per stream, because that is what owns its cursor state; a
server-level source would be shared between two open browser tabs and their cursors
would eat each other's bytes.

Do not add a config file, an environment variable, or a settings object for this.

**Production always passes the options object**, as the call chain above specifies —
`{ projectsRoot }`, whose value is `undefined` unless the flag was given. It never omits
the argument. A test may instead pass `{ source }`: a stub whose `read()` throws, or one
returning fixed agents, needing no filesystem at all.

Both fields are optional and both default to the real construction, so there is exactly
one code path. Do not build a factory type, a registry, or a settings module for this;
the options object is the whole seam.

The fleet panel is the reason the dashboard exists. A missing projects directory, a
permissions error, or a transcript format that moved must cost the token column and
nothing else.

## Acceptance criteria

- [x] `FleetSnapshot` carries a required `usage` field typed as the shared rollup type,
      imported from the shared types module rather than redeclared.
- [x] `formatFleetFrame` takes three arguments, remains exported, and performs no I/O.
- [x] A frame built with an empty agent list carries a rollup whose four counters are
      all `0` and whose `agentCount` is `0`.
- [x] A frame built with a non-empty agent list carries that rollup, and every row the
      attribution function paired carries its own `usage` object.
- [x] The emitted frame still begins with `event: fleet\n` and still ends with `\n\n`.
- [x] Exactly one transcript source is created per stream, inside the stream closure,
      and no new `setInterval`, watcher, or debouncer is introduced anywhere in the file.
- [x] A transcript source whose `read()` throws produces a frame with an empty rollup
      instead of an error, a dropped frame, or a closed stream. This is exercised by
      passing a throwing stub through the handler's optional source parameter, with no
      filesystem involved.
- [x] The events route in the server module passes the plan directory to the handler,
      and the whole directory's tests still compile and pass — a changed signature whose
      caller was not updated is an unfinished change, not a follow-up.
- [x] `--projects-root <dir>` is accepted by the server, reaches the transcript source's
      second parameter, and defaults to the real location when omitted, so every existing
      way of starting the server behaves exactly as before.

## Verification

- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/events-api.test.ts` —
      every test passes.
- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/` — the whole directory
      still passes, proving the handler signature change did not break its callers.
- [x] Run `bunx --bun tsc --noEmit | grep packages/dispatch/skills/autopilot` — it
      prints nothing. Typecheck against the root `tsconfig.json` exactly as written:
      naming files on the command line drops the config, so `strict` runs without Bun's
      global types and every `Bun`, `process`, and `Buffer` reports as an undefined
      name. Real errors then hide among a dozen fake ones. Do not chase a zero total
      either — the repo-wide run has pre-existing errors outside this directory.
- [x] End-to-end, against generated data rather than whatever happens to be on this
      machine. Run the fixture generator described in `../_context/shared.md`, capture
      its `planDir`, `projectsRoot`, and `expected` from the JSON it prints, then start
      the flightdeck server against that plan directory with `--projects-root` pointing
      at that projects tree. Read the port from the server's own startup output rather
      than assuming one, run `curl -N http://127.0.0.1:<port>/api/events`, and confirm
      the first frame's `usage.agentCount` and `usage.totals` equal the generator's
      declared `expected` values.
      Do **not** write this gate as "open a plan that has already run": Claude Code
      deletes transcripts on a retention schedule, so that form reports a zero-versus-zero
      agreement once the data ages out and cannot run on another machine at all.
- [x] Run `git status --short -- packages/dispatch/skills/autopilot/scripts/events-api.ts packages/dispatch/skills/autopilot/scripts/events-api.test.ts packages/dispatch/skills/autopilot/scripts/flightdeck.ts`
      and confirm all three paths are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The rollup is missing from the payload, or a throwing source kills the stream | Populated frames are right, but an empty agent list omits the field instead of zeroing it, or a throwing source drops the frame | Every frame carries a rollup; all-zero when nothing is found; a throwing source degrades to an empty rollup; the frame prefix and terminator are byte-identical to before |
| Test coverage | ×2 | No test asserts the new field | Only the populated case is covered | Empty list, populated list with paired rows, a throwing source, and the unchanged frame envelope are each covered |
| Interface & readability | ×1 | Attribution is inlined into the stream closure and cannot be tested without a server | The formatter is exported but takes the source object, so testing it needs a stub with I/O | The formatter stays exported and pure over its three plain-data inputs; all I/O stays in the stream closure |
| Assumptions & docs | ×1 | No comment explains why a per-snapshot read is affordable | The cadence is mentioned but not what would make it unaffordable | A one-line comment states the read is affordable only because it is incremental, and names the change that would break that |

## Out of scope

- **Any change to the tree endpoint or its payload** — Deferred. The lanes view will
  read the rollup from this same event stream, so the tree payload needs no token field
  and adding one would create a second source of truth that can disagree.
- **Any new HTTP route** — Deferred. The whole point of this seam is that one stream
  carries both halves of a frame, measured at the same instant.
- **All browser-side code: markup, styling, and number formatting** — Deferred to the
  rendering work that follows. This task ends when the bytes are on the wire.
- **Persisting cursors or caching between streams** — Deferred. Two open browser tabs
  each keep their own source and their own cursors, which is fine precisely because the
  reads are incremental; shared state would buy nothing and add a lifecycle to get wrong.
- **Reading `~/.codex/` or any OpenCode store** — Deferred. External-engine agents leave
  no Claude transcript, so their rows carry no usage and must render as unavailable.
