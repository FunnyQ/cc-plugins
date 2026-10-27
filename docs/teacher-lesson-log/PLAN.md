# Teacher lesson log

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-10-27
> **Max parallel**: unlimited

## Overview

Record every prompt the runes teacher asks Jev about — scores, outcome, rewrite, quip, and the model setup that produced it — in a local SQLite database, and give Q a CLI to label those rows and read threshold statistics. This is step 1 of the teacher improvement plan: the thresholds (P6) and every later prompt or model change (P1, P2, P5) get measured against these rows.

## Goals

- Every prompt that passes `isWorthAsking` and reaches Jev leaves exactly one row, whatever the outcome.
- Each row carries enough setup (`model`, `effort`, `system_hash`, both thresholds) to split old and new variants in an A/B.
- Q can label rows interactively (`needs`, `verdict`, `note`) and read per-variant stats plus a threshold sweep.

## Non-goals

- No change to what the teacher shows, its prompt, its model, or its thresholds. Logging only.
- No opt-in switch: logging runs whenever the teacher rune runs (Q's decision).
- No retention or automatic deletion. Clearing means trashing the file.
- No upload, sync, or export of the database.
- No habit file (P4) and no second Jev check (P3).
- No logging of prompts that `isWorthAsking` rejects.

## Context

- The teacher lives in `packages/runes/hooks/teacher/teacher.ts`. `coach()` asks Jev two `noul` questions (`english >= 0.7`, `improve >= 0.6`), then haiku (`register.tsx`, `model: "haiku"`, `effort: "low"`, 15s timeout) for `<quip>` + rewrite, then drops a rewrite that is empty, `same()`, or fails `isRewrite()`. Today `submit()` swallows every error with `.catch(() => undefined)`, so no failure is observable.
- The thresholds were never measured (`0dd8506`: "thresholds are unmeasured").
- A mod has no `Bun` global, and `$.fs` has `write` but no append, with a 4 MiB read cap. Concurrent sessions rewriting one JSONL file would lose lines. SQLite through a `bun` child (the pattern of `explain/pele-cli.ts` and config's `PARSE`, `env: { HOME }`) avoids that.
- `claude plugin test` runs only `*.test.ts(x)`, and the root `bunfig.toml` ignores `packages/runes/**`. A `bun:test` file named `*.spec.ts`, run from inside its directory, is collected by neither, and was measured to run with `cd packages/runes/hooks/teacher && bun test ./x.spec.ts`.

## Requirements

### MVP

1. **Attempt record** — `coach()` reports one `Attempt` per Jev ask, through a new `Transport.record`, at every exit.
   - Acceptance: kit tests drive each of the 7 outcomes and see exactly one `record` call with that outcome.
2. **Database** — `lessons-db.ts` opens/migrates `~/.local/share/q-lab/runes/teacher/lessons.db` (WAL, `busy_timeout = 5000`, `user_version = 1`) and inserts rows.
   - Acceptance: spec inserts and reads back a row; a `user_version` of 2 is refused with the journal mode unchanged; two `record` children started together on a fresh file, 20 rounds, leave 2 rows every round.
3. **Record CLI** — `bun lessons-cli.ts record` reads one JSON row on stdin and inserts it. The mod spawns it per attempt, fire-and-forget.
   - Acceptance: piping a row into a temp `HOME` produces one row visible to `sqlite3`.
4. **Label CLI** — `bun lessons-cli.ts label` walks unlabeled rows oldest first, asks `needs`, then `verdict` when a rewrite exists, then `note`, and writes each row as soon as it is answered.
   - Acceptance: piped answers label the expected rows; `q` stops with earlier rows saved.
5. **Stats CLI** — `bun lessons-cli.ts stats` prints per-variant counts and a threshold sweep (top 5 plus current 0.70/0.60).
   - Acceptance: spec over a fixed sample yields the exact confusion counts.

### Later

- **P1/P2/P3/P4/P5** — each needs these rows first.
- **Opt-in switch** — Q decided against one; revisit before the next public runes release if users object.

## Tech decisions

- **Stack**: Bun + TypeScript; `bun:sqlite` only inside the `bun` child and the CLI, never in mod code.
- **Storage**: SQLite at `$HOME/.local/share/q-lab/runes/teacher/lessons.db`, schema v1 in `tasks/_context/schema.md`.
- **Privacy**: `prompt`, `better`, and `quip` are stored after `scrub()` from `transcript/jev.ts`. work/02 adds the disclosure: one line in the config template's `teacher` comment (`hooks/config.ts` `TEMPLATE`) and one sentence in CLAUDE.md's runes summary, naming the database path.
- **Tests**: kit tests (`teacher.test.ts`, `claude plugin test packages/runes`) for mod code; `lessons-db.spec.ts` (`bun:test`) for the database and CLI logic.
- **Visual design**: none.
- **Conventions**: `tasks/_context/shared.md`.

## Architecture

```
prompt.submit → teacher.submit → coach()
                                  ├─ Jev throws        → record(outcome: jev-failed)
                                  ├─ below threshold   → record(gated)
                                  ├─ haiku undefined   → record(no-reply)
                                  ├─ empty rewrite     → record(empty)
                                  ├─ same()            → record(same)
                                  ├─ !isRewrite()      → record(not-rewrite)
                                  └─ lesson            → record(shown)
record (register.tsx) adds at/project/model/effort, plus the session id teach() captured at submit
  → $.process.run(["bun", <root>/hooks/teacher/lessons-cli.ts, "record"], { stdin: JSON, env: { HOME } })
  → lessons-db.ts: open() → insert()
Q's terminal: bun lessons-cli.ts label | stats → lessons-db.ts
```

Files: `teacher/attempt.ts` (types only, mod-safe), `teacher/lessons-db.ts`, `teacher/lessons-cli.ts`, `teacher/lessons-db.spec.ts`.

## Bucketing

- **Strategy**: single `work/` bucket plus `review/`.
- **Why**: four small tasks; work/02 and work/03 touch disjoint files and run in parallel after work/01.

### Buckets

- **`work/`** — database + record CLI, mod recording, label + stats CLI.
- **`review/`** — the closing review.

## Task index

| Bucket | NN  | Title                        | Status | Pass line | Depends on       |
| ------ | --- | ---------------------------- | ------ | --------- | ---------------- |
| work   | 01  | lessons-db-and-record-cli    | todo   | > 4.0     | —                |
| work   | 02  | record-attempts-from-the-mod | todo   | > 4.0     | work/01          |
| work   | 03  | label-and-stats-cli          | todo   | > 4.0     | work/01          |
| review | 01  | final review 🏁              | todo   | > 4.0     | work/02, work/03 |

Run options: Sim Instructor on **Codex**, depth **Standard** (4 tasks reads as Light; Standard adds the design gate over the schema, which is where a defect costs most). No design phase.

## Cross-bucket dependencies

```
work/01 ─┬─ work/02 ─┐
         └─ work/03 ─┴─ review/01
```

## Open questions

1. **Spawn cost** — one `bun` child per asked prompt (~30–50ms, off the draw path). Accepted; measure if prompts feel slow.

## Known gaps

- **No opt-in**: other users' scrubbed prompts land on disk while the teacher is on. Disclosed in the config template and CLAUDE.md only.
- **Typecheck**: runes' `tsconfig.json` loads only mod types, so `bun:sqlite` and `Bun` in the new CLI files do not typecheck there — same as the existing `explain/geometry-cli.ts`.
- **Live write path**: the kit has no process, so the real spawn is verified only by the `(human)` session check.
- **Repeat prompts**: the teacher's 50-entry cache skips an already-asked prompt, so a repeat in one session leaves no second row.
- **haiku sees the raw prompt**: unchanged by this plan; only what lands on disk is scrubbed.

## References

- Improvement plan: Obsidian `📥 inbox/2026-10-27-runes-teacher-improvement-plan.md`
- `packages/runes/hooks/teacher/teacher.ts`, `packages/runes/hooks/register.tsx`, `packages/runes/hooks/transcript/jev.ts`
