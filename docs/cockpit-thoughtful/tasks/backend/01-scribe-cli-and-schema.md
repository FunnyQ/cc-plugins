# BACKEND-01: Scribe CLI and schema

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/log-schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: skills/01, ui/01, release/01
> **Status**: done

## Goal

Extend the cockpit log record with optional `kind` + `source` fields and add a `cockpit scribe` subcommand that writes typed entries, auto-registers the session, and lists recent scribe entries for dedup.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit.ts` (modify) — add `kind`/`source` to `DecisionRecord`, label `cmdLog`, add `cmdScribe` + `scribe` dispatch, extend `parseArgs` flags.
- `packages/monitor/skills/cockpit/scripts/cockpit.test.ts` (modify) — add scribe tests.

## Implementation notes

### Schema

Add two optional fields + their unions (full shape in `../_context/log-schema.md`):

```ts
type DecisionKind = "decision" | "rationale" | "learning" | "caveat";
type DecisionSource = "agent" | "scribe";

type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: DecisionKind;     // NEW — default "decision" when absent
  source?: DecisionSource; // NEW — default "agent" when absent
  decision: string;
  reason: string;
  tradeoff: string;
  facets: Facet[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  timestamp: string;
};
```

Both optional → old logs deserialize unchanged. In `cmdLog`'s record literal, set `kind: "decision"` and `source: "agent"` so hand-authored entries are explicitly labeled.

### `parseArgs` wiring

`parseArgs` keys flags off three sets. Add `"type"`, `"text"`, `"title"` to `SINGLE_FLAGS`.

`--recent` carries an **optional** numeric value and must NOT fall into the generic else-branch (that branch greedily consumes the next token, so `--recent --provider codex` would swallow `--provider`). Special-case `recent` **before** the else-branch: consume a following token only if it matches `/^\d+$/`; otherwise leave N=8 and consume nothing. Either special-case it in `parseArgs` (e.g. a `recent` entry that captures an optional numeric) or parse the scribe argv directly in `cmdScribe` — but the three cases below must all work:
- `cockpit scribe --recent` → N=8
- `cockpit scribe --recent 3` → N=3
- `cockpit scribe --recent --provider codex` → N=8, `--provider` intact

### `cmdScribe(args)`

Mirror `cmdLog` (cockpit.ts ~286–341). Two modes:

**Recent mode** — when `--recent` is present and `--type` is absent:
- Resolve session (`--session || findSession(provider, project)`); if none, print nothing and exit 0 (a fork with no session shouldn't crash).
- Read the log at `logPathFor(project, sessionId)` if it exists; parse lines; filter `source === "scribe"`; take the last N (default 8); print one compact line each: `${kind} · ${decision || "(untitled)"} · ${timestamp}`. Exit 0.

**Write mode** — when `--type` is present:
- Validate `--type` ∈ `{decision,rationale,learning,caveat}`; else `console.error` + `process.exit(1)`.
- Require `--text`; else error + exit 1.
- Resolve session as in `cmdLog` (`--session || findSession(...)`); error + exit 1 if unresolved. **Note**: `findSession` only resolves a *live* harness session. In tests / non-live contexts there is none, so pass an explicit `--session <uuid>`. "Never-started" means **no registry entry / no meta** — the session id itself is still required (explicit or live); auto-register supplies the registry entry, not the id.
- Build the record:

```ts
const rec: DecisionRecord = {
  id: crypto.randomUUID(),
  type: "decision",
  kind,                              // validated --type
  source: "scribe",
  decision: args.single["title"] || "",
  reason: args.single["text"] || "",
  tradeoff: "",
  facets: [],
  needs_your_call: false,
  options: [],
  files: args.repeated["file"] || [],
  timestamp: new Date().toISOString(),
};
```

- **Auto-register before/at write**: call `upsertSession({ provider, project, sessionId, logPath: logPathFor(project, sessionId), lastHeartbeat: new Date().toISOString() })` so the session becomes `tracked:true`. Do NOT write a goal record and do NOT clobber an existing `project-meta.md`.
- `mkdirSync(join(projectCockpitDir(project), "logs"), { recursive: true })`, `appendFileSync(logPath, line + "\n")`.
- **Persistence guard (concurrency-safe)**: re-read the file and confirm a line whose parsed `id === rec.id` **exists anywhere** — do NOT check "is the tail" the way `cmdLog` does. `/thoughtful` spawns background fire-and-forget forks, so two scribe writes can interleave; a tail check would false-fail the earlier writer when a later fork's line becomes the tail. (`appendFileSync` of a single line is atomic on POSIX for small writes, so lines don't corrupt — only the tail identity is unreliable.) If our `id` isn't found, `console.error` + `process.exit(1)`.
- `refreshHeartbeat(project, sessionId, provider)`.
- Success: `console.log(\`cockpit: scribed ${kind} for ${sessionId}\`)`.

### Dispatch

Add `case "scribe": cmdScribe(parseArgs(rest)); break;` to `main()`'s switch and mention `scribe` in the usage line.

## Acceptance criteria

- [x] `DecisionRecord` has optional `kind` + `source`; `DecisionKind`/`DecisionSource` unions defined.
- [x] `cmdLog` records now include `kind:"decision"`, `source:"agent"`.
- [x] `cockpit scribe --type learning --title T --text X` on a never-started session creates the log file, the entry has `kind:"learning"`/`source:"scribe"`/`needs_your_call:false`, and `decision===T`/`reason===X`.
- [x] After that scribe write, the session has a registry entry (would render `tracked:true`).
- [x] `cockpit scribe --type bogus --text X` exits non-zero with a clear error and writes nothing.
- [x] `cockpit scribe --recent` prints only `source:"scribe"` entries (skips manual/agent + goal records), newest-bounded to N (default 8), exit 0 even when the log is missing.
- [x] `--recent` parsing handles all three: `--recent` (N=8), `--recent 3` (N=3), `--recent --provider codex` (N=8, `--provider` preserved).
- [x] **Concurrency-safe persistence guard**: confirms the record by `id` existing in the file (not by tail). Two near-simultaneous scribe writes to the same log both succeed and both records persist.
- [x] Old log lines without `kind`/`source` still parse (no crash in recent mode).

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts` passes, including new scribe cases (temp `projectDir` + `COCKPIT_HOME`, `Bun.spawnSync`, `readLines` helper — match existing patterns). Tests pass an explicit `--session <uuid>` (no live harness session in tests).
- [x] Test the concurrency guard: launch two `scribe` writes to the same `--session` without awaiting between them; assert both exit 0 and both ids are in the log.
- [x] Manual: `COCKPIT_HOME=/tmp/x bun .../cockpit.ts scribe --session 11111111-1111-1111-1111-111111111111 --type rationale --title "Why fork" --text "cache-warm"` → inspect `<cwd>/.cockpit/logs/<id>.jsonl` and `/tmp/x/registry.json`.
- [x] Manual: `cockpit scribe --session <uuid> --recent 3` after a few writes shows the compact list.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong record shape, no auto-register, or breaks `cmdLog` | writes but misses validation, recent filter, or read-back guard | all modes correct incl. auto-register, validation, dedup list, guard |
| Test coverage | ×2 | no scribe tests | happy-path write only | write + recent + bad-type + auto-register + backward-compat covered |
| Interface & readability | ×1 | duplicates `cmdLog` messily, fields drift | works but naming/flow unclear | reuses helpers, mirrors `cmdLog` cleanly, `type` over `interface` |
| Assumptions & docs | ×1 | silent magic, no compat note | partial | optional-field defaults + no-goal-record choice noted inline |

## Out of scope

- Watermark file — Deferred. Reason: dedup is the scribe fork reading `--recent`, decided during interview.
- log_language handling — Deferred. Reason: the `/cockpit-scribe` skill reads it; the CLI stores `--text` verbatim.
- Dashboard rendering of `kind`/`source` — Deferred. Reason: handled by the separate UI task; the producer here only writes the fields.
