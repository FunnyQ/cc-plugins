# WORK-03: label-and-stats-cli

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: work/01
> **Blocks**: review/01
> **Status**: todo

## Goal

Q can run `bun packages/runes/hooks/teacher/lessons-cli.ts label` to label logged attempts one by one, and `… stats` to read per-variant counts and a threshold sweep over the labeled rows.

## Files to create / modify

- `packages/runes/hooks/teacher/lessons-db.ts` (modify) — add `StoredRow`, `unlabeled`, `label`, `Variant`, `Cut`, `Stats`, `stats`.
- `packages/runes/hooks/teacher/lessons-cli.ts` (modify) — add the `label` and `stats` subcommands.
- `packages/runes/hooks/teacher/lessons-db.spec.ts` (modify) — tests for the new functions and both subcommands.

## Implementation notes

These already exist and must not change shape: `attempt.ts` (`ENGLISH = 0.7`, `IMPROVE = 0.6`, `OUTCOMES`, `Outcome`, `Attempt`, `AttemptRow`, `VERDICTS`, `Verdict`), `lessons-db.ts` (`dbPath`, `open`, `insert`, `parseRow`), `lessons-cli.ts` (the `record` subcommand, the `HOME` check, and the usage error with exit 2), and `lessons-db.spec.ts`, which already holds the database and `record` tests. Keep that file's existing tests and its style; none of them names `label` or `stats` as an unknown subcommand, so all stay green.

### `lessons-db.ts` additions

Use the signatures exactly as given here. They are copied from `schema.md`.

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

- `label` runs one autocommit `UPDATE attempts SET needs = ?, verdict = ?, note = ?, labeled_at = ? WHERE id = ? AND labeled_at IS NULL`. It returns `changes === 1`, so it never overwrites a row another `label` run already answered. Open no explicit transaction around it.
- `stats` follows these semantics, copied from `schema.md`:
  - **Variants** group by `(model, effort, system_hash, english_min, improve_min)`, ordered by the earliest `id` in each group.
    - `rows`: all rows.
    - `shown`: rows with `outcome = 'shown'`.
    - `labeled`: rows with `labeled_at` set, skips included.
    - `judged`: rows with `verdict` non-null.
    - `good`: rows with `verdict = 'good'`.
  - **Sample**: rows with `needs` non-null and both `english` and `improve` non-null. Every `jev-failed` row, a `gated` row with a `NULL` score, and every skipped row are left out. `sample` is its size, across all variants.
  - **Cut** `(e, i)` predicts "needs a lesson" when `english >= e && improve >= i`.
    - `tp`: predicted and `needs = 1`.
    - `fp`: predicted and `needs = 0`.
    - `fn`: not predicted and `needs = 1`.
    - `tn`: not predicted and `needs = 0`.
  - **Ratios**: `accuracy = (tp + tn) / sample`, `precision = tp / (tp + fp)`, `recall = tp / (tp + fn)`. A zero denominator gives `0`.
  - **Grid**: `e` and `i` each take `n / 100` for `n = 50, 55, …, 95`. That is 10 values each and 100 cuts.
  - **`sweep`**: the top 5 cuts, sorted by `accuracy` desc, then `recall` desc, then `e` asc, then `i` asc.
  - **`current`**: the cut at the passed thresholds, computed the same way even when they are off the grid.
  - **Empty sample**: when `sample` is `0`, `current` is `null` and `sweep` is `[]`.

### `label` subcommand

1. Open `dbPath(process.env.HOME)` with `open()`, then read `unlabeled(db)` once.
2. If no row is unlabeled, print `no unlabeled rows` and exit 0.
3. For each row, print a block to stdout. Pass every database string (`project`, `prompt`, `better`, `quip`) through `visible(s)` first, which replaces each C0 control character and DEL (`/[\x00-\x1f\x7f]/g`) with its `\xNN` escape, so an ESC or OSC sequence in a prompt or rewrite is shown, never run by the terminal. The database keeps the original text. Leave out the `better:` and `quip:` lines when the value is `null`. Print a score as `toFixed(2)`, or `-` when it is `null`:
   ```
   #<id> <at> <project> <outcome> english=<0.00|-> improve=<0.00|->
   prompt: <prompt>
   better: <better>
   quip: <quip>
   ```
4. Read the answers one line at a time from stdin, through `const lines = console[Symbol.asyncIterator]()` and `await lines.next()`, so piped answers work the same as typed ones. Trim each answer. Ask in this order:
   1. `needs? [y/n/s=skip/q=quit] `
      - `y` → `needs = 1`.
      - `n` → `needs = 0`.
      - `s` → write the skip at once: `needs`, `verdict` and `note` all `null`, `labeled_at` now. Move to the next row.
      - `q` → exit 0 without touching this row.
      - Any other answer re-asks the same question.
   2. `verdict? [g=good m=bad-model p=bad-prompt t=bad-gate] `
      - Ask this only when `better` is non-null and non-empty. Otherwise `verdict` is `null`.
      - `g`, `m`, `p` and `t` map to `good`, `bad-model`, `bad-prompt` and `bad-gate`.
      - Any other answer re-asks.
   3. `note (Enter to skip) `
      - An empty answer gives `note = null`.
5. Call `label(db, id, l, new Date().toISOString())` right after the last answer for the row. When it returns `false`, print `row <id> already labeled, skipped` and go on.
6. At EOF, at any prompt, exit 0 without touching the current row.
7. Install no SIGINT handler, so Ctrl-C exits 130 (Bun's default SIGINT status). Every write is its own autocommit statement, so a Ctrl-C keeps every row already written. Hold no transaction while waiting for input.

### `stats` subcommand

Open the database, then call `stats(db, { english: ENGLISH, improve: IMPROVE })`, with both constants imported from `./attempt`. Print tab-separated lines to stdout and exit 0:

```
sample	<n>
variants
model	effort	system	english_min	improve_min	rows	shown	labeled	good/judged
<model>	<effort>	<systemHash>	<0.00>	<0.00>	<rows>	<shown>	<labeled>	<good>/<judged>
sweep
english	improve	tp	fp	fn	tn	accuracy	precision	recall
<0.00>	<0.00>	<tp>	<fp>	<fn>	<tn>	<0.000>	<0.000>	<0.000>
current
english	improve	tp	fp	fn	tn	accuracy	precision	recall
<one row in the sweep format>
```

- Print thresholds with `toFixed(2)` and ratios with `toFixed(3)`.
- Print one variant line per variant and one sweep line per cut, in `Stats` order.
- When `current` is `null`, print `current	none` in place of the `current` block.

### Fixed stats sample for the spec

Insert these rows through `insert()` into a fresh `mkdtemp` database, in this order, so the ids run 1 to 9. Then label them with `label()` as the table shows.

- Every row has `model: "haiku"`, `effort: "low"` and `system: "S"`.
- `min` is `englishMin`/`improveMin`.
- The `better` column is the stored rewrite; `-` means `null`.

| id  | outcome       | english | improve | min       | better | label written                     |
| --- | ------------- | ------- | ------- | --------- | ------ | --------------------------------- |
| 1   | `gated`       | 0.40    | 0.68    | 0.70/0.60 | -      | needs 1                           |
| 2   | `shown`       | 0.68    | 0.88    | 0.70/0.60 | `"B2"` | needs 1, verdict `good`           |
| 3   | `gated`       | 0.92    | 0.52    | 0.70/0.60 | -      | needs 1                           |
| 4   | `gated`       | 0.62    | 0.52    | 0.70/0.60 | -      | needs 0                           |
| 5   | `shown`       | 0.82    | 0.68    | 0.70/0.60 | `"B5"` | needs 0, verdict `bad-gate`       |
| 6   | `gated`       | 0.78    | 0.97    | 0.70/0.60 | -      | needs 0                           |
| 7   | `jev-failed`  | null    | null    | 0.70/0.60 | -      | needs 1                           |
| 8   | `gated`       | 0.90    | 0.90    | 0.75/0.60 | -      | skip (needs null, labeled_at set) |
| 9   | `not-rewrite` | 0.85    | 0.75    | 0.75/0.60 | `"B9"` | unlabeled                         |

`stats(db, { english: 0.7, improve: 0.6 })` must return:

- **`sample`**: `6`, which is rows 1–6. Row 7 has null scores, row 8 is skipped, and row 9 is unlabeled.
- **`variants`**: two variants, in this order:
  - `{ englishMin: 0.70, improveMin: 0.60, rows: 7, shown: 2, labeled: 7, good: 1, judged: 2 }`.
  - `{ englishMin: 0.75, improveMin: 0.60, rows: 2, shown: 0, labeled: 1, good: 0, judged: 0 }`.
  - Both have the same `systemHash`: the first 12 hex characters of SHA-256 of `"S"`.
- **`current`**: `{ english: 0.7, improve: 0.6, tp: 0, fp: 2, fn: 3, tn: 1 }`, with `accuracy` 1/6, `precision` 0 (that is 0/2), and `recall` 0.
- **`sweep`**, in exactly this order:

  | english | improve | tp  | fp  | fn  | tn  | accuracy | precision | recall |
  | ------- | ------- | --- | --- | --- | --- | -------- | --------- | ------ |
  | 0.85    | 0.50    | 1   | 0   | 2   | 3   | 4/6      | 1         | 1/3    |
  | 0.90    | 0.50    | 1   | 0   | 2   | 3   | 4/6      | 1         | 1/3    |
  | 0.65    | 0.50    | 2   | 2   | 1   | 1   | 3/6      | 2/4       | 2/3    |
  | 0.50    | 0.70    | 1   | 1   | 2   | 2   | 3/6      | 1/2       | 1/3    |
  | 0.50    | 0.75    | 1   | 1   | 2   | 2   | 3/6      | 1/2       | 1/3    |

  The fixture checks each tie-break in the sort:
  - Rows 1 and 2 tie on accuracy and recall, so `e` asc orders them.
  - Row 3 comes before rows 4 and 5 only because its recall is higher. Sorted by `e` alone, `0.50/0.70` would come first.
  - Rows 4 and 5 tie on `e`, so `i` asc orders them.

  Compare ratios with `toBeCloseTo`.

- **Zero denominator**: `stats(db, { english: 0.99, improve: 0.99 }).current` predicts nothing, so it is `tp 0, fp 0, fn 3, tn 3`, `precision 0`, `recall 0`, `accuracy 0.5`.
- **Empty database**: `stats` returns `sample 0`, `sweep []`, `current null`, and `variants []`.

## Acceptance criteria

- [ ] A row whose `prompt` holds `"\x1b]52;c;aGk=\x07"` prints `\x1b]52;c;aGk=\x07` as text in `label`'s output (a CLI spec test asserts stdout contains no raw `\x1b`).

- [ ] `unlabeled()` returns unlabeled rows in `id` order and never a skipped row. In the fixture it returns only id 9.
- [ ] `label()` on a row whose `labeled_at` is already set returns `false` and leaves `needs`, `verdict`, `note` and `labeled_at` unchanged.
- [ ] `stats()` over the fixed sample returns exactly the `sample`, `variants`, `current` and `sweep` listed under Implementation notes. It also returns the zero-denominator and empty-database results listed there.
- [ ] `label` CLI: a fresh database holds three rows.
  - Row 1 is `shown` with `better: "Fix it."`, row 2 is `gated` with no `better`, and row 3 is `shown`.
  - Pipe in `x\ny\ng\nnice\ns\nq\n` through `Bun.spawn` with `HOME` set to the temp directory. The run exits 0.
  - Row 1 ends as `needs 1, verdict good, note "nice"`. The `x` was re-asked.
  - Row 2 ends as `needs null, verdict null, labeled_at` set.
  - Row 3 has `labeled_at` still `NULL`.
- [ ] `label` CLI: a row with no `better` is never asked for a verdict. A `n` answer followed by an empty note stores `needs 0, verdict null, note null`.
- [ ] `stats` CLI over the fixed sample exits 0. Its stdout starts with `sample\t6`. It contains the `variants`, `sweep` and `current` headings in that order, and the first sweep line is `0.85\t0.50\t1\t0\t2\t3\t0.667\t1.000\t0.333`.
- [ ] `lessons-db.ts` and `lessons-cli.ts` import only what `schema.md` allows: `bun:sqlite`, `node:fs`, `node:path`, `./attempt` and `./lessons-db`.
- [ ] (human) In a temp `HOME` seeded with 4 rows by the smoke script's `record` command looped as `for o in shown same gated shown`, Q runs `label` by hand: answers row 1, skips row 2 with `s`, answers row 3, presses Ctrl-C at row 4. `sqlite3` shows rows 1–3 with `labeled_at` set and exactly the answers typed, and row 4 unlabeled.

## Verification

- [ ] `(cd packages/runes/hooks/teacher && bun test ./lessons-db.spec.ts)` passes with 0 fail.
- [ ] Smoke test with a temporary `HOME`:
  ```sh
  set -e
  h=$(mktemp -d)
  for o in shown gated; do
    printf '{"prompt":"can you checking it","english":0.9,"improve":0.8,"englishMin":0.7,"improveMin":0.6,"outcome":"%s","better":"can you check it","quip":null,"system":"S","at":"2026-10-27T00:00:00.000Z","project":"p","session":"s","model":"haiku","effort":"low"}' "$o" \
      | HOME=$h bun packages/runes/hooks/teacher/lessons-cli.ts record
  done
  printf 'y\ng\n\nn\nt\nwrong gate\n' | HOME=$h bun packages/runes/hooks/teacher/lessons-cli.ts label
  HOME=$h bun packages/runes/hooks/teacher/lessons-cli.ts stats
  sqlite3 "$h/.local/share/q-lab/runes/teacher/lessons.db" 'select id, needs, verdict, note, labeled_at is not null from attempts'
  rm -rf "$h"
  ```
  Run it in a subshell; with `set -e` any step that exits non-zero stops the script before `sqlite3`. `sqlite3` prints `1|1|good||1` and `2|0|bad-gate|wrong gate|1`. `stats` prints `sample\t2`.
- [ ] `claude plugin test packages/runes` reports 0 fail.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                 | 2–3 (below bar)                                                                               | 4–5 (pass)                                                                                                           |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | Fixture sweep, sample, or current differs; `label` overwrites a labeled row; skip leaves `labeled_at` NULL | Happy path right; a tie-break, zero denominator, null-score exclusion, or EOF/`q` path drifts | Every number in the fixture matches, all tie-breaks hold, `q`/EOF/Ctrl-C keep earlier rows, no overwrite             |
| Test coverage           | ×2     | No new test                                                                                                | Only the fixture sweep, or only the CLI                                                       | Fixture, zero denominator, empty DB, `label()` false, re-ask, no-verdict path, `q`, and stats CLI output each tested |
| Interface & readability | ×1     | Prompt loop holds a transaction, or I/O inside `stats()`                                                   | Works, but printing and counting are tangled                                                  | `stats()` and `label()` are pure over a passed `Database`; the CLI only prompts and prints                           |
| Assumptions & docs      | ×1     | Thresholds hard-coded in the CLI instead of `ENGLISH`/`IMPROVE`                                            | A deviation from `schema.md` made but not stated                                              | Every deviation stated in the task report; no new comment beyond a one-line external constraint                      |

## Out of scope

- Re-labeling or editing an already-labeled row. Deferred. Reason: `label()` refuses on purpose, so two concurrent runs cannot overwrite each other. Clearing a label is a manual `sqlite3` update for now.
- Filtering `stats` by date, project or variant. Deferred. Reason: the first week of rows fits one sample; add it once variants multiply.
- Changing `ENGLISH` or `IMPROVE` from the sweep's result. Deferred. Reason: this plan only measures; the threshold change is its own decision.
