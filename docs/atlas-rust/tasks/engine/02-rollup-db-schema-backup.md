# ENGINE-02: Rollup DB schema, migrations, and pre-rust backup

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/01
> **Blocks**: engine/03
> **Status**: todo
> **Models**: dev=opus/high, judge=opus/high

## Goal

`packages/monitor/cockpit-rs/src/atlas/rollup_db.rs` opens, migrates, and backs up `rollup.db` exactly as `rollup-db.ts` does, adds the one-time pre-rust backup, and exposes every accessor the ingest and the stats readers need, so no Rust write can cost history a deleted transcript cannot rebuild.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/rollup_db.rs` (modify) — replace the scaffold's `todo!()` bodies with the full port plus `#[cfg(test)] mod tests`.

Nothing else. `Cargo.toml`, `atlas/mod.rs`, and every other module belong to their own tasks. `tempfile` is already a dev-dependency if the scaffold added it; if it is missing, use `std::env::temp_dir()` plus a unique subdir name instead of editing `Cargo.toml`.

## Implementation notes

Authoritative TS source while it exists: `packages/monitor/skills/usage-dashboard/scripts/rollup-db.ts`. Port behavior, not structure.

### Public surface

These names and signatures are frozen in `engine-api.md`. Keep them:

```rust
pub const SCHEMA_VERSION: i64 = 3;
pub const LEDGER_REBUILD_PENDING: &str = "ledger_rebuild_pending";
pub fn open_rollup_db(path: &Path) -> anyhow::Result<rusqlite::Connection>;
pub fn open_sqlite_file(path: &Path) -> anyhow::Result<rusqlite::Connection>;
```

Row types mirror the TS types field for field. They use the snake_case column names, because they are SQL rows, not JSON:

```rust
pub struct HourlyRow { pub hour_ms: i64, pub project: String, pub model: String,
    pub input_tokens: i64, pub output_tokens: i64, pub cache_read: i64,
    pub cache_creation: i64, pub reasoning: i64, pub message_count: i64 }
pub struct IngestedFile { pub path: String, pub bytes_parsed: i64, pub mtime_ms: i64 }
pub struct LedgerFileRow { pub path: String, pub session_key: String, pub project: String,
    pub project_ts_ms: i64, pub last_ts_ms: i64, pub interactions: i64, pub tool_calls: i64 }
pub struct LedgerModelRow { pub path: String, pub session_key: String, pub model: String,
    pub input_tokens: i64, pub output_tokens: i64, pub cache_read: i64, pub cache_creation: i64 }
```

Accessors are `pub(crate)`, one per TS export, with the same SQL:

| TS | Rust | SQL behavior |
|---|---|---|
| `getMeta` | `get_meta(&Connection, key) -> Result<Option<String>>` | `SELECT value FROM meta WHERE key = ?` |
| `setMeta` | `set_meta(conn, key, value)` | `INSERT … ON CONFLICT(key) DO UPDATE SET value = excluded.value` |
| `getIngestedFile` | `get_ingested_file(conn, path) -> Result<Option<IngestedFile>>` | selects `path, bytes_parsed, mtime_ms` |
| `upsertIngestedFile` | `upsert_ingested_file(conn, &IngestedFile, updated_at: i64)` | upsert on `path`, sets all three plus `updated_at` |
| `hasSeenRequest` / `markSeenRequest` | `has_seen_request(conn, key)` / `mark_seen_request(conn, key, path)` | `INSERT OR IGNORE` |
| `clearSeenRequestsForFile` | `clear_seen_requests_for_file(conn, path)` | `DELETE … WHERE path = ?` |
| `hasSeenToolCall` / `markSeenToolCall` | `has_seen_tool_call(conn, session_key, key)` / `mark_seen_tool_call(…)` | keyed `(session_key, tool_key)`, `INSERT OR IGNORE` |
| `pruneSeenToolCalls` | `prune_seen_tool_calls(conn)` | `DELETE FROM seen_tool_calls WHERE session_key NOT IN (SELECT session_key FROM session_ledger)` |
| `addHourlyRow` | `add_hourly_row(conn, &HourlyRow)` | **additive** upsert: every count column `= col + excluded.col` |
| `allHourlyRows` | `all_hourly_rows(conn) -> Result<Vec<HourlyRow>>` | no `ORDER BY` (same as TS) |
| `rewindRollup` | `rewind_rollup(conn)` | `UPDATE ingested_files SET bytes_parsed = 0`, then `DELETE FROM seen_tool_calls`. It **never** touches `seen_requests`. |
| `clearIngestedFile` | `clear_ingested_file(conn, path)` | delete by path |
| `clearLedgerForFile` | `clear_ledger_for_file(conn, path)` | deletes that path from `session_ledger` **and** `session_model_usage` |
| `addLedgerRow` | `add_ledger_row(conn, &LedgerFileRow)` | copy the TS upsert verbatim, including the `CASE` that keeps the earliest non-zero `project_ts_ms`, `last_ts_ms = MAX(…)`, and additive `interactions` / `tool_calls` |
| `addLedgerModelRow` | `add_ledger_model_row(conn, &LedgerModelRow)` | additive upsert on `(path, session_key, model)` |
| `allLedgerRows` | `all_ledger_rows(conn)` | `ORDER BY project_ts_ms, path` |
| `allLedgerModelRows` | `all_ledger_model_rows(conn)` | no order |

Copy each SQL string from `rollup-db.ts` character for character. The upsert arithmetic is the contract.

### Open mechanics (`open_sqlite_file`)

- Unless the path is `:memory:`, run `create_dir_all` on the parent dir.
- Open read-write and create the file.
- Run `PRAGMA journal_mode = WAL`, then `PRAGMA busy_timeout = 5000`.
- `codex-sessions.db` uses the same opener, so the WAL and timeout settings cannot drift apart.

### Schema v3 DDL (verbatim)

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ingested_files (
  path TEXT PRIMARY KEY, bytes_parsed INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS seen_requests (request_key TEXT PRIMARY KEY, path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_seen_requests_path ON seen_requests (path);
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour_ms INTEGER NOT NULL, project TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_creation INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_ms, project, model));
CREATE TABLE IF NOT EXISTS seen_tool_calls (
  session_key TEXT NOT NULL, tool_key TEXT NOT NULL, PRIMARY KEY (session_key, tool_key));
CREATE TABLE IF NOT EXISTS session_ledger (
  path TEXT NOT NULL, session_key TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
  project_ts_ms INTEGER NOT NULL DEFAULT 0, last_ts_ms INTEGER NOT NULL DEFAULT 0,
  interactions INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, session_key));
CREATE TABLE IF NOT EXISTS session_model_usage (
  path TEXT NOT NULL, session_key TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_creation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, session_key, model));
```

Keep the column layout and whitespace as they are in `rollup-db.ts`. `sqlite_master.sql` stores the text as written, so copy the TS block as it is.

### `open_rollup_db` sequence (pinned order)

1. **`open_sqlite_file(path)`.**
2. **Pre-rust backup.** This step is new and Rust-only. Skip it when the path is `:memory:`. Skip it when the `meta` table does not exist or cannot be read: that is a brand-new file, so there is nothing to lose. Otherwise, when `get_meta("writer")` is not `Some("rust")` and `<db>.pre-rust.bak` does not exist, run `VACUUM INTO '<db>.pre-rust.bak'` (bind the path as a parameter). **A failure here is an error, not swallowed**: return `Err("pre-rust backup failed: <cause>")` before any write, so `writer` is never set without a backup and the next open retries. This is stricter than the TS's own upgrade backup on purpose: the backup is the only undo for a Rust ingest bug in authoritative history. Add a failure-path cargo test (backup destination unwritable → `Err`, `writer` still unset, no row or meta value changed). **Why first:** this captures the file exactly as the TS last wrote it, before this process changes a byte of it. That includes the TS migration's own `.v<old>.bak` step and its cursor rewind.
3. **TS upgrade backup (`backupBeforeUpgrade`).** Skip it for `:memory:`. Read `schema_version`; when the read errors, skip. When the value is `None` or equals `"3"`, skip. Otherwise the destination is `<db>.v<stored>.bak`; when that file exists, skip; else run `VACUUM INTO` it and swallow errors. The TS takes this backup **before** it validates the version, so an unsupported version such as `99` also gets a `<db>.v99.bak` before the refusal. Mirror that for parity.
4. **Migrate inside one IMMEDIATE transaction** (`transaction_with_behavior(TransactionBehavior::Immediate)`):
   - Create `meta` first.
   - Let `stored = get_meta("schema_version")`. When `stored` is not `None`, not `"1"` or `"2"`, and not `"3"`, return the error `Unsupported rollup schema version: <stored>`. That is the exact TS text. The transaction rolls back, so no row or meta value changes (the header may, because WAL mode was set on open).
   - **v1 → v2:** when `stored == "1"` and `seen_requests` has no `path` column (check with `PRAGMA table_info(seen_requests)`; a failed PRAGMA means "no column"), run `ALTER TABLE seen_requests ADD COLUMN path TEXT NOT NULL DEFAULT ''`. Legacy keys keep an unknown (`''`) path. They are never pruned by path, so they keep blocking re-billing forever.
   - **v1/v2 → v3:** when `stored` is `"1"` or `"2"`, run `UPDATE ingested_files SET bytes_parsed = 0` to rewind every cursor, so the ingest replays all surviving transcripts to backfill the new ledger tables. Then set `ledger_rebuild_pending = "1"`; that flag is how the ingest knows this is a rebuild. `seen_requests` is untouched, so `usage_hourly` is not re-billed.
   - Run the full v3 DDL.
   - Set `schema_version = "3"`.
   - **Set `writer = "rust"`** in the same transaction. The key is set only when the migration succeeded, so a refused DB never gets it.
   - Commit.
5. If any step from 4 onward fails, close the connection and return the error, as the TS does. Never return a half-migrated handle.

Unknown meta keys are ignored by the TS, so `writer` is safe in a mixed TS/Rust fleet. Do not add any other key.

## Acceptance criteria

- [ ] A fresh temp DB opened with `open_rollup_db` has `schema_version = "3"` and `writer = "rust"`, and no `.pre-rust.bak` or `.v*.bak` sits next to it.
- [ ] A TS-shaped v3 DB with rows in every table and no `writer` key produces `<db>.pre-rust.bak` whose tables equal the original row for row. The original's rows are also unchanged after the open.
- [ ] Opening the same DB a second time leaves the `.pre-rust.bak` mtime and size unchanged. A pre-existing `.pre-rust.bak` placed by the test is never overwritten.
- [ ] A v2 DB (v2 DDL without the two ledger tables, `schema_version = "2"`, a non-zero `bytes_parsed`) opens to v3. `<db>.v2.bak` exists. Every `bytes_parsed` is 0 and `ledger_rebuild_pending = "1"`. `seen_requests` and `usage_hourly` are unchanged.
- [ ] A v1 DB whose `seen_requests` lacks `path` gains the column with `''` for existing keys, and those keys survive.
- [ ] A DB with `schema_version = "99"` makes `open_rollup_db` return an error whose message is `Unsupported rollup schema version: 99`. The main file's rows and meta are unchanged, and `writer` is not set.
- [ ] `PRAGMA journal_mode` returns `wal` and `PRAGMA busy_timeout` returns `5000` on a handle from `open_sqlite_file`.
- [ ] `add_hourly_row` twice on the same key sums every count column. `add_ledger_row` keeps the earliest non-zero `project_ts_ms` and its `project`. `rewind_rollup` zeroes cursors and empties `seen_tool_calls` but not `seen_requests`. Each of these has a unit test.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::rollup_db` passes and runs at least the eight cases above.
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] Every test DB is created under a temp dir. `grep -n "token-atlas" packages/monitor/cockpit-rs/src/atlas/rollup_db.rs` shows no hard-coded real-home path inside `mod tests`.

The black-box golden tests `rollup migrate v2`, `rollup refuse newer`, and `rollup pre-rust backup` drive this module through the `atlas rollup-update` CLI. That CLI's body belongs to the ingest port, so those tests are not a gate here. They go green once the ingest lands.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Any of these: a migration loses rows, a newer version is written to, `seen_requests` is cleared, or the backup overwrites an existing `.bak` | Happy path migrates, but the backup order, the `.v99.bak` parity, the `writer` placement inside the transaction, or the exact upsert arithmetic drifts from the TS | Every step matches the pinned sequence; SQL is copied verbatim; the refused DB keeps every row, its schema, and its meta values (the WAL header may change), with only the `.pre-rust.bak` (when `writer` was unset) and the TS-parity `.v<N>.bak` added |
| Test coverage | ×2 | No tests, or only a fresh-DB test | Migrations tested; backup idempotence, refusal, or accessor arithmetic untested | All eight acceptance cases plus the PRAGMA checks run under `cargo test`, each on its own temp DB |
| Interface & readability | ×1 | Signatures differ from `engine-api.md`, or `unwrap` is used on SQLite results | Signatures match, but accessors are hidden behind a one-caller abstraction or named unlike their TS counterparts | One `pub(crate)` fn per TS accessor with the snake_case name; public items exactly as frozen; clippy clean |
| Assumptions & docs | ×1 | The Rust-only backup is uncommented | Backup present, but why it runs first or why errors are swallowed is unexplained | One-line why-comments on the pre-rust-first ordering, the swallowed backup errors, and the `writer` key being Rust-only |

## Out of scope

- `update_rollup` and the `atlas rollup-update` CLI. Deferred: the ingest port owns tail-parsing, replay, and pruning, and calls these accessors.
- Readers that aggregate rollup rows into stats (`readRollupAggregates`, `readRollupLedger`). Deferred: those live with the Claude data-source port.
- `codex-sessions.db` table creation. Deferred: the Codex port owns its schema and only reuses `open_sqlite_file`.
