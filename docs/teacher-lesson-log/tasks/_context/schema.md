# Lesson log contract

Every task in this tree agrees to this file. Paths are relative to the repo root.

## Files

| File                                              | Runs in         | May import                                        |
| ------------------------------------------------- | --------------- | ------------------------------------------------- |
| `packages/runes/hooks/teacher/attempt.ts`         | mod and CLI     | nothing (types and constants only)                |
| `packages/runes/hooks/teacher/lessons-db.ts`      | `bun` only      | `bun:sqlite`, `node:fs`, `node:path`, `./attempt` |
| `packages/runes/hooks/teacher/lessons-cli.ts`     | `bun` only      | `./lessons-db`, `./attempt`                       |
| `packages/runes/hooks/teacher/lessons-db.spec.ts` | `bun test` only | `bun:test`, `./lessons-db`, `./attempt`, `node:*` |

Mod code (`teacher.ts`, `register.tsx`) imports `attempt.ts` only, never `lessons-db.ts`. A mod has no `Bun` global and cannot load `bun:sqlite`.

## `attempt.ts`

```ts
export const ENGLISH = 0.7; // moved here from teacher.ts, which imports it
export const IMPROVE = 0.6; // likewise

export const OUTCOMES = [
  "jev-failed",
  "gated",
  "no-reply",
  "empty",
  "same",
  "not-rewrite",
  "shown",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

// what coach() knows; teacher.ts builds it
export type Attempt = {
  prompt: string; // scrub(keyOf(text))
  english: number | null; // Jev's noul; null when Jev threw or the answer lacks it
  improve: number | null;
  englishMin: number; // ENGLISH at the time, 0.7 today
  improveMin: number; // IMPROVE at the time, 0.6 today
  outcome: Outcome;
  better: string | null; // scrub(parsed rewrite); null unless haiku answered
  quip: string | null; // scrub(parsed quip); null when absent or rejected by parseReply
  system: string; // the SYSTEM prompt text sent to haiku
};

// what the record CLI receives on stdin; register.tsx adds the last five
export type AttemptRow = Attempt & {
  at: string; // new Date().toISOString()
  project: string; // basename of the session cwd, "" when unknown
  session: string; // $.session.id() read when the prompt was submitted, "" when unknown
  model: string; // "haiku" today
  effort: string; // "low" today
};

export const VERDICTS = [
  "good",
  "bad-model",
  "bad-prompt",
  "bad-gate",
] as const;
export type Verdict = (typeof VERDICTS)[number];
```

## Outcomes

`coach()` records exactly one outcome per call, at the first exit it reaches, in this order:

| Outcome       | When                                                                               | `english`/`improve`    | `better` | `quip`           |
| ------------- | ---------------------------------------------------------------------------------- | ---------------------- | -------- | ---------------- |
| `jev-failed`  | `systemOne` throws (refused, timeout, bad JSON)                                    | `null`                 | `null`   | `null`           |
| `gated`       | `needsLesson` is false (a missing answer scores 0, as today, but is stored `null`) | as returned, or `null` | `null`   | `null`           |
| `no-reply`    | haiku's `complete` resolves `undefined` or throws                                  | scores                 | `null`   | `null`           |
| `empty`       | `parseReply(reply).better` is `""`                                                 | scores                 | `""`     | parsed or `null` |
| `same`        | `same(better, text)`                                                               | scores                 | rewrite  | parsed or `null` |
| `not-rewrite` | `!isRewrite(better, text)`                                                         | scores                 | rewrite  | parsed or `null` |
| `shown`       | the lesson is kept and drawn                                                       | scores                 | rewrite  | parsed or `null` |

## Database

Path: `${HOME}/.local/share/q-lab/runes/teacher/lessons.db`. `open()` creates the directory with `mkdirSync(dir, { recursive: true, mode: 0o700 })`, then `chmodSync(dir, 0o700)` so an existing directory is made private too; the database and its WAL side files are then readable only through it.

On every open, in this order: `PRAGMA busy_timeout = 5000;`, then read `PRAGMA user_version`, and refuse before any persistent change:

- greater than `1` → close the handle and throw `Error("lessons.db schema v<N> is newer than this runes build")`. The journal mode and the file stay as they were.
- otherwise → `PRAGMA journal_mode = WAL;`, retried because `busy_timeout` does not cover it (measured: 22 of 30 concurrent first opens threw `SQLITE_BUSY` there): on an error whose `code` is `SQLITE_BUSY`, `Bun.sleepSync(100)` and try again, at most 50 tries, then rethrow. Then, when the version read was `0`: `BEGIN IMMEDIATE`, re-read `user_version` inside the transaction, and only if it is still `0` run the v1 DDL below and set `PRAGMA user_version = 1`; then `COMMIT`. Two sessions opening a fresh file at once must both succeed: the second waits on `busy_timeout`, re-reads `1`, and creates nothing. A version of `1` does nothing more.

v1 DDL:

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

- `system_hash` is the first 12 hex characters of the SHA-256 of `AttemptRow.system`, computed by `insert()` (`new Bun.CryptoHasher("sha256").update(system).digest("hex").slice(0, 12)`). The full `system` text is never stored.
- `needs` is `1`, `0`, or `NULL`. `verdict` is one of `VERDICTS` or `NULL`. `labeled_at` is the ISO time the row was answered; `NULL` means never answered.
- Labeling writes, per row:

  | Answer     | `needs`   | `verdict`             | `note`         | `labeled_at` |
  | ---------- | --------- | --------------------- | -------------- | ------------ |
  | `y` / `n`  | `1` / `0` | the answer, or `NULL` | text or `NULL` | now          |
  | `s` (skip) | `NULL`    | `NULL`                | `NULL`         | now          |

  When `label()` returns `false` (another `label` run answered the row first), the CLI prints `row <id> already labeled, skipped` and moves on; it never overwrites. It holds no write lock while waiting for input. `q` or EOF leaves the current row untouched, keeps every row already answered, and exits 0. Ctrl-C does the same but exits 130, the default SIGINT status; the CLI installs no handler. A skipped row has `labeled_at` set, so `unlabeled()` never returns it again. The verdict prompt is asked only when `better` is non-null and non-empty (`same`, `not-rewrite`, `shown`); for every other row `verdict` is `NULL`.

## `lessons-db.ts` API

```ts
import type { Database } from "bun:sqlite";
export const dbPath = (home: string) =>
  `${home}/.local/share/q-lab/runes/teacher/lessons.db`;
export function open(path: string): Database; // mkdir, pragmas, migrate (rules above)
export function insert(db: Database, row: AttemptRow): void;
export function parseRow(json: string): AttemptRow; // JSON.parse + validate; throws on a bad row
```

`parseRow` throws when `outcome` is not in `OUTCOMES`, when any required string field (`at`, `project`, `session`, `prompt`, `model`, `effort`, `system`) is not a string, when `englishMin`/`improveMin` is not a number, when `english`/`improve` is neither a number nor `null`, or when `better`/`quip` is neither a string nor `null`.

The label and stats functions are added to the same file:

```ts
export type StoredRow = {
  id: number;
  at: string;
  project: string;
  outcome: Outcome;
  english: number | null;
  improve: number | null;
  prompt: string;
  better: string | null;
  quip: string | null;
};
export function unlabeled(db: Database): StoredRow[]; // labeled_at IS NULL, ORDER BY id
export function label(
  db: Database,
  id: number,
  l: { needs: 0 | 1 | null; verdict: Verdict | null; note: string | null },
  at: string,
): boolean; // UPDATE ... WHERE id = ? AND labeled_at IS NULL; false when 0 rows changed
export type Variant = {
  model: string;
  effort: string;
  systemHash: string;
  englishMin: number;
  improveMin: number;
  rows: number;
  shown: number;
  labeled: number;
  good: number;
  judged: number;
};
export type Cut = {
  english: number;
  improve: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number;
  precision: number;
  recall: number;
};
export type Stats = {
  variants: Variant[];
  sweep: Cut[];
  current: Cut | null;
  sample: number;
};
export function stats(
  db: Database,
  current: { english: number; improve: number },
): Stats;
```

### Stats semantics

- **Variants** group by `(model, effort, system_hash, english_min, improve_min)`, ordered by the earliest `id` in each group. Per variant: `rows` = all rows; `shown` = rows with `outcome = 'shown'`; `labeled` = rows with `labeled_at` set (skips included); `judged` = rows with `verdict` non-null; `good` = rows with `verdict = 'good'`.
- **Sample** = rows with `needs` non-null and both `english` and `improve` non-null. Rows whose score is `NULL` (every `jev-failed`, and a `gated` row missing an answer) and skipped rows are left out. `sample` is its size, across all variants.
- **Cut** `(e, i)` predicts "needs a lesson" when `english >= e && improve >= i`, the same `>=` `needsLesson` uses. `tp` = predicted and `needs = 1`; `fp` = predicted and `needs = 0`; `fn` = not predicted and `needs = 1`; `tn` = not predicted and `needs = 0`.
- `accuracy = (tp + tn) / sample`; `precision = tp / (tp + fp)`; `recall = tp / (tp + fn)`. A zero denominator gives `0`.
- **Grid**: `e` and `i` each take `0.50, 0.55, …, 0.95` (10 values, built as `n / 100` for `n = 50, 55, …, 95` so no float drift), 100 cuts.
- **`sweep`** is the top 5 cuts, sorted by `accuracy` desc, then `recall` desc, then `e` asc, then `i` asc.
- **`current`** is the cut at the passed `current` thresholds, computed the same way even when it is off the grid; `null` when `sample` is `0`, and `sweep` is then `[]`.
- The CLI prints the variants table, then the sweep, then `current`, with `sample` in the heading. It calls `stats(db, { english: ENGLISH, improve: IMPROVE })`, imported from `attempt.ts`, so a threshold change moves `current` with it.

## `lessons-cli.ts`

`bun packages/runes/hooks/teacher/lessons-cli.ts <record|label|stats>`. The database is `dbPath(process.env.HOME)`. An unset or empty `HOME` prints `lessons-cli.ts: HOME is not set` to stderr and exits 1 before opening anything; the mod also skips the spawn when `where.home` is `""`. A missing or unknown subcommand prints `usage: lessons-cli.ts record|label|stats` to stderr and exits 2. `record` exits 0 after one insert and 1 with the error on stderr otherwise.

## The mod's spawn

The session id is captured per attempt, never once per `session.start`: a `/clear` moves the process to a new session id and fires no `session.start` (`.claude-plugin/types/claude-code/index.d.ts`, `SessionEndInput.reason`). So:

- `teach()`'s `prompt.submit` hook starts `$.session.id().catch(() => undefined)` without awaiting it (the `.catch` keeps a prompt that never reaches `record` from leaving an unhandled rejection), before calling `teacher.submit(r.text, session)`, and does not delay its own return.
- `teacher.submit(text: string, session: Promise<string | undefined>)` hands that promise through `coach()` unchanged to every `record` call of that attempt.
- `Transport` gains `record(a: Attempt, session: Promise<string | undefined>): void`.

`register.tsx` implements it as:

```ts
record: (a, session) => {
  if (!home) return;
  void session
    .then((id) =>
      $.process.run(["bun", `${$.plugin.root}/hooks/teacher/lessons-cli.ts`, "record"], {
        stdin: JSON.stringify({ ...a, at: new Date().toISOString(), project, session: id ?? "", model: MODEL, effort: EFFORT }),
        env: { HOME: home },
      }),
    )
    .catch(() => {});
},
```

The other inputs come from what `register.tsx` already has in its `session.start` hook: `home` is `where.home` (set by `loadConfig` from `$.env.get("HOME")`), and `project` is the basename of `e.cwd` (`e.cwd.split("/").filter(Boolean).at(-1) ?? ""`, the same expression `explain.ts` uses). A mod's child gets no `HOME`, so `env: { HOME }` is required. `MODEL = "haiku"` and `EFFORT = "low"` become constants in `register.tsx`, used by both `$.model.complete` and `record`, so the logged setup cannot drift from the real one.
