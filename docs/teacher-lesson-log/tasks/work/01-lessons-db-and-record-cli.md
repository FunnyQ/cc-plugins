# WORK-01: lessons-db-and-record-cli

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: work/02, work/03
> **Status**: done
> **Models**: dev=opus/high

## Goal

A `bun` CLI, `lessons-cli.ts record`, reads one attempt row as JSON on stdin and stores it in `~/.local/share/q-lab/runes/teacher/lessons.db`. Two sessions writing at the same moment to a fresh file both keep their row.

## Files to create / modify

- `packages/runes/hooks/teacher/attempt.ts` (new) — the shared types and constants, copied exactly from the `attempt.ts` block in `schema.md`.
- `packages/runes/hooks/teacher/lessons-db.ts` (new) — `dbPath`, `open`, `insert`, `parseRow`.
- `packages/runes/hooks/teacher/lessons-cli.ts` (new) — subcommand dispatch with `record` only.
- `packages/runes/hooks/teacher/lessons-db.spec.ts` (new) — `bun:test` spec for all of the above.

Do not touch `teacher.ts` or `register.tsx`. Moving `ENGLISH`/`IMPROVE` out of `teacher.ts` and spawning the CLI from the mod belong to later work. Until that lands, `attempt.ts` and `teacher.ts` both hold `0.7` and `0.6`.

## Implementation notes

### `attempt.ts`

Copy the `schema.md` block exactly: `ENGLISH`, `IMPROVE`, `OUTCOMES`, `Outcome`, `Attempt`, `AttemptRow`, `VERDICTS`, `Verdict`. The file imports nothing. Drop the inline `//` notes from the schema block, because `shared.md` forbids new comments. The field names and order carry the meaning.

### `lessons-db.ts`

Imports: `bun:sqlite`, `node:fs`, `node:path`, `./attempt`. Nothing else.

```ts
import type { Database } from "bun:sqlite";
export const dbPath = (home: string) =>
  `${home}/.local/share/q-lab/runes/teacher/lessons.db`;
export function open(path: string): Database;
export function insert(db: Database, row: AttemptRow): void;
export function parseRow(json: string): AttemptRow;
```

`open(path)`, in this exact order:

1. `mkdirSync(dirname(path), { recursive: true, mode: 0o700 })`, then `chmodSync(dirname(path), 0o700)` (an existing directory is made private too), then `new Database(path)`.
2. `PRAGMA busy_timeout = 5000;`
3. Read `PRAGMA user_version` as `v`.
4. If `v > 1`: close the handle and throw `Error("lessons.db schema v<N> is newer than this runes build")`, where `<N>` is `v`. Change nothing first, journal mode included.
5. `PRAGMA journal_mode = WAL;`. `busy_timeout` does not cover this step: 22 of 30 concurrent first opens threw `SQLITE_BUSY` here. On an error whose `code` is `"SQLITE_BUSY"`, call `Bun.sleepSync(100)` and retry, up to 50 tries in total. After the 50th failure, rethrow. Rethrow any other error immediately.
6. If `v === 0`: run `BEGIN IMMEDIATE`. Inside the transaction, re-read `user_version`. Only if it is still `0`, run the v1 DDL and `PRAGMA user_version = 1`. Then `COMMIT`. A second process that lost the race waits on `busy_timeout`, re-reads `1`, and creates nothing. If anything throws, roll back before rethrowing.
7. If `v === 1`, do nothing more. Return the handle.

v1 DDL (verbatim from `schema.md`):

```sql
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  prompt TEXT NOT NULL,
  english REAL,
  improve REAL,
  english_min REAL NOT NULL,
  improve_min REAL NOT NULL,
  outcome TEXT NOT NULL,
  better TEXT,
  quip TEXT,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  system_hash TEXT NOT NULL,
  needs INTEGER,
  verdict TEXT,
  note TEXT,
  labeled_at TEXT
);
```

`insert(db, row)` writes one row with a prepared statement. The camelCase fields map to snake_case columns: `englishMin → english_min`, `improveMin → improve_min`. It computes `system_hash` as `new Bun.CryptoHasher("sha256").update(row.system).digest("hex").slice(0, 12)` and never stores `row.system` itself. `needs`, `verdict`, `note`, and `labeled_at` stay `NULL`.

`parseRow(json)` runs `JSON.parse`, then validates. It throws on each of these:

- `outcome` is not in `OUTCOMES`.
- Any of `at`, `project`, `session`, `prompt`, `model`, `effort`, `system` is not a string.
- `englishMin` or `improveMin` is not a number.
- `english` or `improve` is neither a number nor `null`.
- The text is not valid JSON. The `JSON.parse` error propagates.

`parseRow` rejects a `better` or `quip` that is neither a string nor `null` (a missing key reads as `undefined` and is rejected too), so `insert` binds them as given.

### `lessons-cli.ts`

Imports `./lessons-db` and `./attempt` only. Usage: `bun packages/runes/hooks/teacher/lessons-cli.ts <subcommand>`.

| Input                                                                                                 | stderr                                       | Exit |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---- |
| no subcommand, or anything except `record` (`label` and `stats` included, until later work adds them) | `usage: lessons-cli.ts record\|label\|stats` | 2    |
| `HOME` unset or `""` (checked before opening anything)                                                | `lessons-cli.ts: HOME is not set`            | 1    |
| `record`, valid row on stdin                                                                          | —                                            | 0    |
| `record`, `parseRow`, `open` or `insert` throws                                                       | the error message                            | 1    |

Check the subcommand before `HOME`, so a bad subcommand always exits 2. `record` reads all of stdin (`await Bun.stdin.text()`), calls `parseRow`, `open(dbPath(process.env.HOME))`, then `insert`, and closes the handle. It prints nothing on success.

### `lessons-db.spec.ts`

`bun:test` only. Imports: `bun:test`, `./lessons-db`, `./attempt`, `node:*`. Each test that touches a database uses a fresh `mkdtempSync(join(tmpdir(), "lessons-"))` directory and removes it in the same file (`afterEach` / `rmSync(..., { recursive: true, force: true })`). Never touch the real `~/.local/share/q-lab/runes/`. Spawn the CLI with `Bun.spawn(["bun", join(import.meta.dir, "lessons-cli.ts"), ...])` and pass `env: { ...process.env, HOME: <temp> }`, or a `HOME` of `""` for the no-HOME case.

The spec needs these tests:

1. **Round trip**: `insert` a row, then `SELECT *` returns every column. That includes `english_min`/`improve_min`, and `NULL` for `english`/`improve` when those are `null`. The `needs`, `verdict`, `note`, and `labeled_at` columns are `NULL`.
2. **system_hash**: it equals the first 12 hex characters of the SHA-256 of `system`, and no column holds the `system` text.
3. **parseRow refusals**: one case per rule above (bad outcome; each of the 7 string fields set to a number; `englishMin` set to a string; `english` set to `"0.5"`; `better` set to `5`; `quip` key missing). Plus one accepted case with `english: null`.
4. **Newer schema**: set `PRAGMA user_version = 2` on a fresh file left in `DELETE` journal mode. `open` throws `lessons.db schema v2 is newer than this runes build`, and afterwards a separate handle reads `PRAGMA journal_mode` as `delete`.
5. **Private directory**: under umask `022`, after `open`, `statSync(dirname(path)).mode & 0o777` is `0o700`; a pre-made `0o755` directory is `0o700` after `open`.
6. **Reopen**: opening a v1 file twice keeps `user_version = 1`, keeps the rows, and creates no second table.
7. **Concurrent first open**: run 20 rounds. Each round uses a fresh temp `HOME` and starts two `lessons-cli.ts record` children together, each fed a valid row. Both children exit 0, and `SELECT count(*) FROM attempts` is `2`. Give this test a generous timeout (for example 60 000 ms).
8. **CLI exits**: no subcommand → 2; `bogus` → 2; `record` with `HOME=""` → 1 with `lessons-cli.ts: HOME is not set`; invalid JSON on stdin → 1.

A valid row for the tests and the smoke check:

```json
{
  "prompt": "can you checking the logs",
  "english": 0.92,
  "improve": 0.81,
  "englishMin": 0.7,
  "improveMin": 0.6,
  "outcome": "shown",
  "better": "can you check the logs",
  "quip": "verbs, not gerunds",
  "system": "You are Clawd.",
  "at": "2026-10-27T10:00:00.000Z",
  "project": "cc-plugins",
  "session": "abc123",
  "model": "haiku",
  "effort": "low"
}
```

### Typecheck

runes' `tsconfig.json` loads only mod types, so `bun:sqlite` and `Bun` in these files do not typecheck there. This is the same known gap as `explain/geometry-cli.ts`. Do not edit any `tsconfig.json`.

## Acceptance criteria

- [x] `attempt.ts` exports `ENGLISH = 0.7`, `IMPROVE = 0.6`, `OUTCOMES` in the order `jev-failed, gated, no-reply, empty, same, not-rewrite, shown`, `VERDICTS` in the order `good, bad-model, bad-prompt, bad-gate`, and the types `Outcome`, `Attempt`, `AttemptRow`, `Verdict` with exactly the `schema.md` fields. It imports nothing.
- [x] `lessons-db.ts` imports only `bun:sqlite`, `node:fs`, `node:path`, `./attempt`. `lessons-cli.ts` imports only `./lessons-db` and `./attempt`.
- [x] Opening a file with `user_version = 2` throws `lessons.db schema v2 is newer than this runes build` and leaves its journal mode `delete`.
- [x] Two `record` children started together on a fresh file leave 2 rows, in each of 20 rounds.
- [x] `record` exits 0 on a valid row. It exits 1 on bad JSON, a bad row, or an empty `HOME`, and 2 on a missing or unknown subcommand, with the stderr texts above.
- [x] `grep -rlE "bun:test|bun:sqlite" packages/runes --include='*.test.ts' --include='*.test.tsx'` prints nothing.
- [x] `teacher.ts` and `register.tsx` are unchanged: `git diff --quiet -- packages/runes/hooks/teacher/teacher.ts packages/runes/hooks/register.tsx`.

## Verification

- [x] `(cd packages/runes/hooks/teacher && bun test ./lessons-db.spec.ts)` passes with 0 failures.
- [x] `h=$(mktemp -d); echo '{"prompt":"can you checking the logs","english":0.92,"improve":0.81,"englishMin":0.7,"improveMin":0.6,"outcome":"shown","better":"can you check the logs","quip":"verbs, not gerunds","system":"You are Clawd.","at":"2026-10-27T10:00:00.000Z","project":"cc-plugins","session":"abc123","model":"haiku","effort":"low"}' | HOME=$h bun packages/runes/hooks/teacher/lessons-cli.ts record && sqlite3 $h/.local/share/q-lab/runes/teacher/lessons.db 'select outcome from attempts'; rm -rf "$h"` prints `shown`.
- [x] `bun packages/runes/hooks/teacher/lessons-cli.ts; echo $?` prints the usage line and `2`.
- [x] `claude plugin test packages/runes` still reports 373 pass, 0 fail.
- [x] `claude plugin validate packages/runes` passes.

## Eval rubric

> Scale 0–5; pass: weighted average > 4.0; Correctness < 4 is an automatic veto. Shared anchors: `../_context/rubric.md`.

| Dimension               | Weight | 0–1 (fail)                                                                                        | 2–3 (below bar)                                                                                                         | 4–5 (pass)                                                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A column, name, or pragma order differs from `schema.md`, or the concurrent-open test loses a row | Round trip works, but the v2 refusal changes the journal mode, or the WAL retry or `BEGIN IMMEDIATE` re-read is missing | The pragma order, v2 refusal, WAL retry, and race-safe migration all match `schema.md`, and the 20-round concurrency test is green |
| Test coverage           | ×2     | No spec                                                                                           | Round trip only                                                                                                         | All 8 spec groups above, each `parseRow` refusal case included                                                                     |
| Interface & readability | ×1     | Mod code imports `lessons-db.ts`, or `attempt.ts` imports anything                                | Works, but the CLI mixes parsing and SQL inline                                                                         | `lessons-db.ts` holds pure functions over a passed-in `Database`; the CLI only wires stdin, `HOME`, and exit codes                 |
| Assumptions & docs      | ×1     | Unmarked magic numbers beyond `schema.md`'s 5000 / 100 / 50                                       | A choice `schema.md` left open is made but not stated                                                          | The task report states every choice `schema.md` left open; no new comment beyond a one-line external constraint                    |

## Out of scope

- `unlabeled`, `label`, `stats`, and the `label`/`stats` subcommands — Deferred to a follow-up task in the same bucket.
- Changing `teacher.ts` or `register.tsx`, including recording from the mod — Deferred. Reason: this task only lays the storage that the mod's spawn will call.
- Retention, deletion, export — Deferred. Reason: rows are kept forever by decision.
