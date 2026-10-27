# REVIEW-01: final review 🏁

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: work/02, work/03
> **Status**: todo
> **Final review**: true

## Goal

The whole diff delivers the teacher lesson log: every prompt that reaches Jev leaves exactly one scrubbed row carrying `model`, `effort`, `system_hash`, and both thresholds, and Q can label rows and read stats, while nothing the teacher shows changes.

## Files to create / modify

- Any file the earlier work touched, only to fix an integration or consistency defect this review finds. Expected changed paths:
  - `packages/runes/hooks/teacher/attempt.ts` (new)
  - `packages/runes/hooks/teacher/lessons-db.ts` (new)
  - `packages/runes/hooks/teacher/lessons-cli.ts` (new)
  - `packages/runes/hooks/teacher/lessons-db.spec.ts` (new)
  - `packages/runes/hooks/teacher/teacher.ts` (modified)
  - `packages/runes/hooks/teacher/teacher.test.ts` (modified)
  - `packages/runes/hooks/register.tsx` (modified)
  - `packages/runes/hooks/config.ts` (modified: `TEMPLATE` teacher comment only)
  - `CLAUDE.md` (modified: one sentence in the runes summary)

## Implementation notes

This gate checks integration and consistency across the whole diff. It does not re-score each piece of work; fix only what breaks the contract below.

### Contract match

Hold the diff against `schema.md` line by line:

- `OUTCOMES` is exactly `jev-failed, gated, no-reply, empty, same, not-rewrite, shown`. `VERDICTS` is exactly `good, bad-model, bad-prompt, bad-gate`.
- `ENGLISH = 0.7` and `IMPROVE = 0.6` are defined in `attempt.ts` only. `teacher.ts` and `lessons-cli.ts` import them.
- The `attempts` table has the v1 columns in `schema.md` and nothing more. `system_hash` is 12 hex characters, and the full `system` text is never stored.
- `open()` refuses `user_version > 1` before switching the journal mode, retries `PRAGMA journal_mode = WAL` on `SQLITE_BUSY` (100 ms, at most 50 tries), and runs the v1 DDL under `BEGIN IMMEDIATE` with a re-read of `user_version`.
- `label()` updates only `WHERE id = ? AND labeled_at IS NULL` and returns `false` when no row changed. A skip writes `labeled_at`.
- `stats()` groups variants by `(model, effort, system_hash, english_min, improve_min)`, sweeps the 10×10 grid built as `n / 100`, compares with `>=`, sorts by accuracy desc, recall desc, `e` asc, `i` asc, and returns the top 5 plus `current`.
- `Transport.record(a: Attempt, session: Promise<string | undefined>): void`. `teach()`'s `prompt.submit` hook starts `$.session.id()` per submit without awaiting it. `register.tsx` skips the spawn when `where.home` is `""`, and passes `env: { HOME: home }`.
- `register.tsx` defines `MODEL = "haiku"` and `EFFORT = "low"`, and both `$.model.complete` and `record` use them.
- `prompt`, `better`, and `quip` pass through `scrub()` from `transcript/jev.ts` before they leave the mod.

### Boundaries

- Mod code (`teacher.ts`, `register.tsx`) imports only `./attempt` (or `./teacher/attempt`) of the new files, never `lessons-db.ts` or `bun:sqlite`.
- The `bun:test` file is named `lessons-db.spec.ts`, never `*.test.ts`.
- The teacher's visible behaviour is unchanged: same thresholds, same SYSTEM prompt, same model and effort, same rejects.

### Disclosure

- `hooks/config.ts` `TEMPLATE`'s `teacher` comment says the rune logs asked prompts to `~/.local/share/q-lab/runes/teacher/lessons.db`.
- `CLAUDE.md`'s runes summary carries one sentence naming that database path.

### Style

- No reformatting of untouched lines; each touched file keeps its semicolon and quote style.
- No new comment beyond a one-line external constraint.

## Acceptance criteria

- [ ] `git diff --name-only <baseRef> -- packages/runes/hooks CLAUDE.md` lists `attempt.ts`, `lessons-db.ts`, `lessons-cli.ts`, `lessons-db.spec.ts`, `teacher.ts`, `teacher.test.ts`, `register.tsx`, `config.ts`, and `CLAUDE.md`.
- [ ] `grep -rn "lessons-db\|bun:sqlite" packages/runes/hooks/teacher/teacher.ts packages/runes/hooks/register.tsx` prints nothing.
- [ ] `grep -rnE "const (ENGLISH|IMPROVE) =" packages/runes/hooks` prints only lines in `packages/runes/hooks/teacher/attempt.ts`.
- [ ] `grep -n "lessons.db" packages/runes/hooks/config.ts CLAUDE.md` prints at least one line from each file.
- [ ] `ls packages/runes/hooks/teacher/*.test.ts` lists no file that imports `bun:test` (`grep -l "bun:test" packages/runes/hooks/teacher/*.test.ts` prints nothing).
- [ ] (reviewer) Every name, column, signature, and outcome in the diff matches `schema.md` (checked against the Contract match list above).
- [ ] `git diff <baseRef> -- packages/runes/hooks/teacher/teacher.ts packages/runes/hooks/register.tsx packages/runes/hooks/config.ts` shows no reformatted untouched line, and `git diff -U0 <baseRef> -- packages/runes/hooks | grep -cE '^\+\s*(//|/\*)'` prints `0`.
- [ ] (human) In a real Claude Code session with the teacher on and `TYPESAFE_API_KEY` set, Q submits `can you checking the logs before we deploying`, `thanks, that works fine for me`, and `fix it` (exactly two new rows; if Jev scores the thanks above both thresholds, pick another plain-English thanks and note it), then `/clear` and `please telling me why this test failing` (its row's `session` differs from the earlier rows'; any outcome counts, since Jev's scores vary), and `sqlite3 ~/.local/share/q-lab/runes/teacher/lessons.db 'select outcome, prompt, better from attempts order by id desc limit 5'` matches what the UI drew (a `shown` row for each lesson drawn).
- [ ] (human) Q runs `bun packages/runes/hooks/teacher/lessons-cli.ts label` over the first three unlabeled rows: answers the first, skips the second with `s`, presses Ctrl-C at the third, and `sqlite3` shows the first two with `labeled_at` set and the third still unlabeled.

## Verification

- [ ] `claude plugin test packages/runes` reports 0 fail and at least 387 passing tests.
- [ ] `(cd packages/runes/hooks/teacher && bun test ./lessons-db.spec.ts)` reports 0 fail.
- [ ] `claude plugin validate packages/runes` passes.
- [ ] End-to-end smoke under a temporary `HOME`:
  ```bash
  h=$(mktemp -d)
  cli=packages/runes/hooks/teacher/lessons-cli.ts
  base='"at":"2026-10-27T00:00:00.000Z","project":"p","session":"s","englishMin":0.7,"improveMin":0.6,"model":"haiku","effort":"low","system":"SYS"'
  echo "{$base,\"prompt\":\"can you checking it\",\"english\":0.9,\"improve\":0.8,\"outcome\":\"shown\",\"better\":\"can you check it\",\"quip\":\"tense!\"}" | HOME=$h bun $cli record
  echo "{$base,\"prompt\":\"fine as written here\",\"english\":0.9,\"improve\":0.2,\"outcome\":\"gated\",\"better\":null,\"quip\":null}" | HOME=$h bun $cli record
  printf 'y\ng\n\nn\n\n' | HOME=$h bun $cli label
  HOME=$h bun $cli stats
  sqlite3 $h/.local/share/q-lab/runes/teacher/lessons.db 'select outcome, needs, verdict, length(system_hash) from attempts order by id'
  rm -rf "$h"
  ```
  Both `record` calls exit 0, `stats` exits 0, and `sqlite3` prints `shown|1|good|12` then `gated|0||12`.

## Eval rubric

> Scale 0–5 per dimension. Pass: weighted average > 4.0. Correctness < 4 is an automatic veto.

| Dimension      | Weight | 0–1 (fail)                                                                                                                                      | 2–3 (below bar)                                                                                            | 4–5 (pass)                                                                                                                |
| -------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Correctness    | ×3     | A gate fails, or a name, column, outcome, or signature diverges from `schema.md`                                                                | Pieces work alone, but one integration point drifts (session capture, HOME skip, scrub, shared thresholds) | Every Contract match item holds across the whole diff, and the smoke prints the expected rows                             |
| Meets the goal | ×2     | Some asked prompt leaves no row, or the teacher's visible behaviour changed                                                                     | Rows land, but setup columns or labeling/stats miss part of the goal                                       | Exactly one row per Jev ask, with full setup columns, labelable and summarised, and the teacher draws what it drew before |
| Consistency    | ×1     | Mod code imports `lessons-db.ts` or `bun:sqlite`, or thresholds are duplicated                                                                  | Style or naming differs between files; disclosure is missing in one place                                  | One source per constant, file boundaries as in `schema.md`, disclosure in both places, untouched lines unchanged          |
| No regressions | ×1     | `claude plugin test packages/runes` fails                                                                                                       | Tests pass, but an existing test was weakened or deleted to get there                                      | All 373 earlier tests keep their assertions and pass, plus the new ones                                                             |
| Leanness       | ×1     | Extra layers, options, or helpers `schema.md` does not require (a wrapper with one caller, an unused flag, a hand-rolled SQLite or JSON helper) | One or two needless helpers or indirections                                                                | Only what `schema.md` requires; stdlib and `bun:sqlite` used directly                                                     |

## Out of scope

- Changing the teacher's prompt, model, effort, or thresholds — Deferred. Reason: this work only logs; those changes get measured against these rows later.
- An opt-in switch, retention, or export — Deferred. Reason: Q decided logging runs whenever the teacher runs, rows are kept forever, and nothing leaves the machine.
