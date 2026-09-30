# CONTRACT-03: Golden stats and rollup suite

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
>
> **Depends on**: contract/01
> **Blocks**: engine/03, engine/04, engine/05, engine/06, engine/07
> **Status**: done
> **Models**: dev=opus/high

## Goal

The TS engine's outputs over the fixture home are recorded as committed golden files, and one test file asserts that any implementation (TS or Rust, chosen by the launcher) reproduces them, under the golden test names every port's verification filters on.

## Files to create / modify

- `packages/monitor/skills/usage-dashboard/contract/record-golden.ts` (new) — regenerates every golden file from the TS; refuses to run when `COCKPIT_BIN` is set.
- `packages/monitor/skills/usage-dashboard/contract/golden/SHA256SUMS` (new, generated) — `shasum -a 256` of every golden file, written by `record-golden.ts` as its last step; the fixed baseline later checks compare against.
- `packages/monitor/skills/usage-dashboard/contract/golden.ts` (new) — `normalizeFixturePaths`, the volatile-key stripper, and the table dumper, shared by the recorder and the test.
- `packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts` (new) — the golden suite.
- `packages/monitor/skills/usage-dashboard/contract/golden/volatile-keys.json` (new) — dotted paths stripped before comparing stats.
- `packages/monitor/skills/usage-dashboard/contract/golden/stats.json` (new, generated) — full `/api/stats` payload minus volatile keys.
- `packages/monitor/skills/usage-dashboard/contract/golden/sources/{claude,codex,opencode,pricing}.json` (new, generated) — one file per `atlas stats --source <name>`.
- `packages/monitor/skills/usage-dashboard/contract/golden/rollup/*.json` (new, generated) — one file per table dump and per scenario (see below).

## Implementation notes

### Harness you build on

The launcher and fixture builder already exist in `packages/monitor/skills/usage-dashboard/contract/`. Their signatures:

```ts
// launcher.ts
export function atlasCommand(sub: string, args?: string[]): string[];
// COCKPIT_BIN set → [COCKPIT_BIN, "atlas", sub, ...args]; unset → ["bun", <TS script for sub>, ...args]
export function isRust(): boolean;

// fixtures.ts
export function makeFixtureHome(): Promise<{
  home: string;                       // temp HOME holding Claude, Codex and OpenCode fixtures
  env: Record<string, string>;        // HOME, XDG_*, COCKPIT_HOME, TZ, TOKEN_ATLAS_NOW_MS, stub URLs
  stub: { url: string; stop(): void };// local HTTP stub for OpenRouter / Codex usage / token refresh
  cleanup(): Promise<void>;
}>;
```

Spawn every command with `Bun.spawn(atlasCommand(...), { env: { ...fixture.env } })` — never inherit the real `HOME`. Each test builds its own fixture home (or a `beforeAll` one per `describe` for read-only tests) and cleans it up; rollup tests always get a fresh DB path under the fixture home.

### Golden test names (frozen — copy exactly)

Filter with `bun test <file> -t "<name>"`:

- `stats key <topLevelKey>` — one per key: `period`, `summary`, `byModel`, `pricingMeta`, `budget`, `usageLimits`, `codexUsageLimits`, `dataHealth`, `daily`, `ledger`, `hourlyUsage`, `activityDays`, `hourlyDistribution`, `weekHourMatrix`, `dailyHourCounts`, `projects`, `sessions`, `insights`, `meta`
- `source claude`, `source codex`, `source opencode`, `source pricing`
- `rollup table <table>` — one per table: `meta`, `ingested_files`, `seen_requests`, `usage_hourly`, `seen_tool_calls`, `session_ledger`, `session_model_usage`
- `rollup incremental append`, `rollup transcript deleted`, `rollup rebuild`, `rollup migrate v2`, `rollup refuse newer`, `rollup pre-rust backup` (Rust only)

### Stats

- Run `atlas stats` under the fixture env, `JSON.parse` stdout, strip volatile keys, then `test("stats key <k>")` per top-level key, `expect(actual[k]).toEqual(golden[k])`. Also assert the top-level key list and order equals contracts.md §6.
- `volatile-keys.json` is a JSON array of dotted paths; `*` matches any one segment (object key or array index). The stripper deletes each matching path; a path that matches nothing is not an error.
- Derive the list empirically: record twice (different wall clock, fresh process so `BOOT_ID` differs) with `TOKEN_ATLAS_NOW_MS` pinned, diff, and add only what still differs. Keep it minimal. The test file carries one comment line per entry saying why it is volatile.

### Fixture-root normalization

Every fixture home is a fresh `mkdtemp`, and transcript paths land in rollup rows (`ingested_files.path`, `seen_requests.path`, ledger `path`) and in source/stats JSON. One helper, `normalizeFixturePaths(value, fixtureRoot)`, exported from `contract/golden.ts` (new) and used by both `record-golden.ts` and `golden.contract.test.ts`, replaces the fixture root prefix with the literal `<FIXTURE>` in every string value **and every object key** (`projectTokens`, `projectModelUsage`, `history.byProject`, `projectActivity` are keyed by absolute paths), recursively, with a unit test over a nested object that has path keys, before any comparison or write. Apply it to stats, every source, and every rollup dump. Without it no two runs compare equal.

### Sources

`test("source <name>")` runs `atlas stats --source <name>` and compares the parsed JSON deep-equal to `golden/sources/<name>.json`. No volatile stripping — if a source is not deterministic under the fixture env, fix the fixture, not the test.

### Rollup

- Run `atlas rollup-update --db <fixtureHome>/rollup.db`, then open the DB read-only with `bun:sqlite` and dump each table as an array of row objects ordered by its primary key. Exclude `ingested_files.updated_at` — it is the ingest's own wall-clock write time (`Date.now()`), not derived from input. `meta` excludes the Rust-only `writer` key, so TS and Rust dumps compare equal.
- `rollup table <table>` compares each dump to `golden/rollup/<table>.json`.
- Scenarios, each on a fresh fixture home, compared to its own golden file (`golden/rollup/<scenario>.json` holding every table dump):
  - `rollup incremental append` — ingest, append complete JSONL lines to one transcript (including a line repeating an already-billed `requestId:messageId`), reset that file's mtime with `utimes` to a fixed value later than its fixture mtime, ingest again. Every scenario step that touches a file does it through one helper in `contract/golden.ts` that ends with that `utimes`, so `ingested_files.mtime_ms` is deterministic.
  - `rollup transcript deleted` — ingest, delete one transcript, ingest again. Assert explicitly as well as against golden: `usage_hourly` identical to before the delete; that file's `session_ledger`, `session_model_usage`, `ingested_files` rows are gone; `seen_tool_calls` rows whose `session_key` no longer appears in `session_ledger` are pruned.
  - `rollup rebuild` — ingest, then `--rebuild`. Assert `usage_hourly` is identical to before and the ledger tables equal the non-rebuild golden.
  - `rollup migrate v2` — create a v2 DB in the test from inline DDL (v3 schema minus `seen_tool_calls`, `session_ledger`, `session_model_usage`; `meta.schema_version = '2'`; a few `usage_hourly` rows), ingest. Assert `<db>.v2.bak` exists, `schema_version` is `3`, pre-existing `usage_hourly` rows survive. Read `rollup-db.ts` for the exact v2 shape.
  - `rollup refuse newer` — DB with `meta.schema_version = '99'`. Assert non-zero exit, stderr contains `Unsupported rollup schema version: 99`, and the DB content is unchanged: dump every table and `meta` before and after and compare (not file bytes — opening sets `journal_mode = WAL` before the version check, which rewrites the header). A `<db>.v99.bak` beside it is expected: the TS takes its version backup before the version check.
  - `rollup pre-rust backup` — `test.skipIf(!isRust())`. A fresh DB's first ingest creates no `.pre-rust.bak` (nothing to lose) and sets `meta.writer = 'rust'`. Then make it TS-shaped: `DELETE FROM meta WHERE key = 'writer'` via `bun:sqlite`. The next ingest creates `<db>.pre-rust.bak` holding the pre-ingest rows and sets `writer` again; a further ingest leaves the `.bak` mtime unchanged.

### `record-golden.ts`

- Exits 1 with `record-golden: run against TS only; unset COCKPIT_BIN` when `COCKPIT_BIN` is set.
- Reuses the same fixture builder, launcher, stripper, and dump helpers as the test (export them from the test's helper module or a small `golden-helpers.ts` counted inside the test file — do not duplicate logic).
- Writes JSON with 2-space indent and a trailing newline, keys in the order produced, so re-running is byte-identical.

## Acceptance criteria

- [x] Every test name in the frozen list exists in `golden.contract.test.ts` exactly as written.
- [x] `bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts` passes against TS, with only `rollup pre-rust backup` skipped.
- [x] Running `record-golden.ts` twice produces byte-identical files under `contract/golden/`.
- [x] `record-golden.ts` exits 1 with the refusal message when `COCKPIT_BIN` is set.
- [x] `volatile-keys.json` entries each have a one-line reason in the test file, and removing any one entry makes a `stats key` test fail on a second recording.
- [x] The `rollup transcript deleted` test asserts `usage_hourly` survives and the deleted file's ledger rows are gone, independent of golden.
- [x] No test reads or writes outside its fixture home or `os.tmpdir()`.

## Verification

- [x] `bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts`
- [x] `bun packages/monitor/skills/usage-dashboard/contract/record-golden.ts && git diff --exit-code -- packages/monitor/skills/usage-dashboard/contract/golden/`
- [x] `COCKPIT_BIN=/bin/false bun packages/monitor/skills/usage-dashboard/contract/record-golden.ts; test $? -eq 1`
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/usage-dashboard/contract/` prints nothing.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Suite red against TS, or golden not deterministic | Green, but a scenario asserts only against golden where the rule (usage_hourly survives delete, refuse newer leaves DB untouched) is not checked directly | Green against TS, byte-stable recording, every frozen name present, every silent rollup rule asserted directly |
| Test coverage | ×2 | Only the full-payload test | Stats and tables covered; scenarios missing | Every stats key, every source, every table, and all six scenarios |
| Interface & readability | ×1 | Recorder and test duplicate stripping/dump logic | Shared helpers but unclear naming | One set of helpers used by both; test names read as the frozen list |
| Assumptions & docs | ×1 | Volatile keys unexplained | Some reasons missing | Each volatile key and the `updated_at` / `writer` exclusions carry a one-line reason |

## Out of scope

- HTTP routes and the `atlas.json` lifecycle — Deferred. Reason: a separate contract file covers the server.
- CLI subcommands other than `stats` and `rollup-update` — Deferred. Reason: a separate CLI contract file covers statusline, push-usage, and live.
- Any Rust code — Deferred. Reason: this suite pins TS behavior first; the Rust ports make it pass.
