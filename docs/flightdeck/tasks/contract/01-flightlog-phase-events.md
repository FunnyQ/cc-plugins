# CONTRACT-01: flightlog phase events

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: contract/02, wiring/01
> **Status**: done

## Goal

The flightlog can record that an agent has *started*, not only that it finished — so a live viewer can
tell which agents are in flight, without breaking any log already on disk.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts` (modify) — add the optional `phase`
  field to `NoteEntry`; make `renderRunlog` skip start entries.
- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.test.ts` (modify) — cover the new field,
  the render skip, and backward compatibility.
- `packages/dispatch/skills/flightplan/scripts/flightlog.ts` (modify) — accept `--phase`; relax the
  `--message` requirement for a start entry.
- `packages/dispatch/skills/flightplan/scripts/flightlog.test.ts` (modify) — cover the CLI flag through
  the exported `buildNoteEntry`.

## Implementation notes

### The type change

`NoteEntry` gains exactly one optional field. Do not add a new `kind`, do not touch `ScoreEntry`, and
do not change the `kind` allow-list in `parseLog`.

```ts
export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  role: string;
  attempt?: number;
  agentLabel?: string;
  /**
   * "start" marks the agent beginning its work. "end" (or an absent value) marks
   * completion. Absent is the completion case because every entry written before
   * this field existed has no `phase` — that keeps old trails valid without migration.
   */
  phase?: "start" | "end";
  message: string;
};
```

Because the field is optional and additive, `parseLog` needs no change at all. Verify that claim with a
test rather than assuming it.

### `renderRunlog` must skip start entries

`RUNLOG.md` is the human-readable post-run artefact. A start line carries no information a reader wants
— it would double the length of every task section. Filter them out at the top of `renderRunlog`,
before grouping:

```ts
const sorted = [...entries]
  .filter((e) => !(e.kind === "note" && e.phase === "start"))
  .sort((a, b) => a.ts.localeCompare(b.ts));
```

A task whose *only* entries are start entries then produces no section at all. That is correct — there
is nothing finished to report.

### The CLI flag

`buildNoteEntry` takes `phase` through its meta argument and passes it straight through. Keep the
function pure; it already receives `ts` from the caller.

```ts
export function buildNoteEntry(meta: {
  task: string;
  role: string;
  message: string;
  ts: string;
  attempt?: number;
  agentLabel?: string;
  phase?: "start" | "end";
}): NoteEntry;
```

In `main()`:

- Read `--phase` with the existing `flagValue` helper.
- Accept only the literal strings `start` and `end`. Any other value exits `2` with a clear message —
  silently ignoring a typo would make an agent look finished when it just started.
- `--message` stays required unless `--phase start` was passed. For a start entry with no `--message`,
  store the empty string.
- Omit `phase` from the entry entirely when the flag is absent, so existing callers keep producing
  byte-identical lines.

Update the `usage()` text to show the flag.

### Backward compatibility is the real acceptance test

Four real trails already exist in the repo and must keep working:

- `docs/chronicle/.flightlog/run.jsonl`
- `docs/cockpit-autolog/.flightlog/run.jsonl`
- `docs/cockpit-thoughtful/.flightlog/run.jsonl`
- `docs/relay/.flightlog/run.jsonl`

Each has a committed `RUNLOG.md` beside it. Re-rendering any of them must reproduce the existing file
exactly.

## Acceptance criteria

- [x] `NoteEntry` carries `phase?: "start" | "end"` and no other new field.
- [x] `parseLog` is unchanged and still parses every existing trail.
- [x] `renderRunlog` omits entries with `phase: "start"`.
- [x] Re-rendering **each of the four** committed trails reproduces its `RUNLOG.md` byte for byte. One
      spot check is not enough — the guarantee is about all of them.
- [x] `flightlog.ts log ... --phase start` works without `--message` and stores `message: ""`.
- [x] `flightlog.ts log ... --phase bogus` exits `2` with a message naming the allowed values.
- [x] A `log` call with no `--phase` produces a JSONL line identical to what the previous version wrote.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/` — all green, including the existing tests.
- [x] Round-trip a start entry into a scratch file and read it back:
      `bun packages/dispatch/skills/flightplan/scripts/flightlog.ts log /tmp/fd-check.jsonl --task work/aa --role dev --phase start --agent probe`
      then confirm the line contains `"phase":"start"` and `"message":""`.
- [x] Re-render **every** committed trail and diff each against its committed run log. Loop over all
      four rather than spot-checking one:
      ```bash
      for d in chronicle cockpit-autolog cockpit-thoughtful relay; do
        bun packages/dispatch/skills/flightplan/scripts/flightlog.ts report \
          "docs/$d/.flightlog/run.jsonl" --out "/tmp/fd-$d.md" >/dev/null
        diff "/tmp/fd-$d.md" "docs/$d/.flightlog/RUNLOG.md" && echo "$d ok"
      done
      ```
      All four must print `ok` with no diff output.
- [x] Confirm the bad-value path: the `--phase bogus` call above exits non-zero.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | An existing trail fails to parse, or a re-rendered RUNLOG differs from the committed one | Start entries are recorded but still appear in RUNLOG, or a bad `--phase` value is silently accepted | Field is additive, start entries are filtered from RUNLOG, all four existing trails re-render identically, bad values exit 2 |
| Test coverage | ×2 | No new tests | Only the happy path — a start entry is written and read back | Covers the render skip, the absent-phase default, the invalid-value exit, and a regression test rendering a real trail |
| Interface & readability | ×1 | `phase` leaks into `ScoreEntry` or a new `kind` is invented | Field added but the filter is buried in the render loop | One optional field, filter applied once before grouping, `buildNoteEntry` stays pure |
| Assumptions & docs | ×1 | No comment on why absent means "end" | Comment states the rule but not the reason | The comment explains that absent means end *because* pre-existing entries lack the field |

## Out of scope

- Emitting start events from the orchestrator prompts. Deferred. Reason: that edit touches the file
  driving every autopilot run, and it should land only after this flag exists and is tested.
- Any change to `ScoreEntry`. Score verdicts are already written at a single well-defined moment and
  need no phase.
- A staleness ceiling for agents that start and never end. Deferred: the viewer treats them as in
  flight for the length of the run, which is the accepted v1 behaviour.
