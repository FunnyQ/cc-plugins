# ENGINE-03: Rollup ingest and the rollup-update subcommand

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/02, contract/03
> **Blocks**: engine/07, engine/08, cli/01
> **Status**: todo
> **Models**: dev=opus/high, judge=opus/high

## Goal

`cockpit atlas rollup-update` ingests Claude transcripts into `rollup.db` exactly as `rollup-update.ts` does, so every golden `rollup …` test passes against the Rust binary.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/rollup_update.rs` (modify — replace the scaffold stub) — `UpdateResult`, `UpdateOptions`, `update_rollup`, `run`, plus private `parse_slice`, `ingest_file`, `prune_missing_files`, and `#[cfg(test)]` units.

Nothing else. The `rollup_db.rs` accessors (`get_ingested_file`, `upsert_ingested_file`, `has_seen_request`, `mark_seen_request`, `clear_seen_requests_for_file`, `has_seen_tool_call`, `mark_seen_tool_call`, `prune_seen_tool_calls`, `add_hourly_row`, `add_ledger_row`, `add_ledger_model_row`, `clear_ledger_for_file`, `clear_ingested_file`, `rewind_rollup`, `get_meta`, `set_meta`, `LEDGER_REBUILD_PENDING`) and `open_rollup_db` already exist as `pub(crate)`; `dedup.rs` and `jsonl.rs` already exist. If one is missing or wrong, stop and report — do not edit those modules.

## Implementation notes

Authoritative behavior: `packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts` (457 lines). Read it whole before writing code. Port what it does, including the parts that look odd. The rules below fail silently when broken; each must survive the port.

### Public surface (fixed by `_context/engine-api.md`)

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct UpdateResult { pub files_scanned: usize, pub rebuilt: bool }
pub struct UpdateOptions { pub rebuild: bool }
pub fn update_rollup(db: &mut rusqlite::Connection, projects_dir: &Path, opts: UpdateOptions) -> anyhow::Result<UpdateResult>;
pub fn run(args: &[String]) -> std::process::ExitCode;
```

`ingested_files.updated_at` uses the real clock (`SystemTime::now()`), never `model::now_ms()`, as the TS writes `Date.now()` there. Add a cargo test: with `TOKEN_ATLAS_NOW_MS` set to a small value, `updated_at` is still within a few seconds of the wall clock. The golden row dump excludes `updated_at`.

### CLI (`run`)

- `--rebuild` anywhere → `rebuild: true`. `--db <path>` → that DB path, else `paths::rollup_db_path()` (honors `TOKEN_ATLAS_ROLLUP_DB`). Projects dir = `paths` projects dir (honors `TOKEN_ATLAS_PROJECTS_DIR`).
- Open with `rollup_db::open_rollup_db` (migrations, refuse-newer, pre-rust backup all live there). On error: print the error to stderr and exit non-zero, as an uncaught TS throw would.
- stdout: `JSON.stringify({ ...result, usageHourlyRows: n }, null, 2)` plus a trailing newline, where `n = SELECT COUNT(*) FROM usage_hourly`. Key order is `filesScanned`, `rebuilt`, `usageHourlyRows`. Exit 0.

### `update_rollup` order of operations

1. `files = walk_files(projects_dir, ".jsonl")` (order = directory walk order, same as TS `readdirSync` recursion).
2. `ledger_rebuild = prune_missing_files(db, files)` runs **before** ingest.
3. With `rebuild` set, run `rewind_rollup` in a transaction, set `rebuilt = true`, and add every file to `ledger_rebuild`. Otherwise, when meta `ledger_rebuild_pending == "1"`, set `rebuilt = true` and add every file to `ledger_rebuild`.
4. `ctx = { now_ms, ledger_rebuild, ledger_seen: empty set }`. Ingest the files in order. On the first `ingest_file` that returns false (a truncation), run `rewind_rollup` in a transaction, set `rebuilt = true`, mark all files, clear `ledger_seen`, re-ingest **every** file, then stop the loop.
5. `set_meta(LEDGER_REBUILD_PENDING, "0")`. Return `{ files_scanned: files.len(), rebuilt }`.

### `ingest_file` → `bool`

- A stat failure returns `true` and skips the file. `mtime_ms = floor(mtime)`.
- `start = prior.bytes_parsed or 0`. When `prior` exists and `size < prior.bytes_parsed`, return `false`.
- `ledger_rebuild_for_file = ctx.ledger_rebuild.contains(file)`. This is **not** the same as `start == 0`. A brand-new file stays gated on `seen_requests`.
- Every early exit clears the stale ledger rows of a rebuilt file (`clear_ledger_for_file` in a transaction). That covers `size <= start` and "grew but no new complete line". The second case also upserts `ingested_files` with `bytes_parsed = start`.
- Read lines from `start` with the jsonl reader in no-partial mode. The cursor's consumed-bytes boundary is the new `bytes_parsed`. **Only the tail from `start` is read.** Stream it; never load the whole file into memory.
- One transaction applies: add each hourly row, mark each request key with this path, clear this file's ledger when rebuilding, add ledger rows, add ledger model rows, mark tool keys, and upsert `ingested_files` with `bytes_parsed = boundary`.

### `parse_slice` rules (per complete line)

- Skip blank lines and unparseable JSON.
- `session_key = entry.sessionId ?? <file basename>`. `ts = Date.parse(timestamp)`, and a missing or unparseable value becomes `0`. Parse ISO-8601 with `jiff` and confirm it agrees with JS `Date.parse` on the fixture's timestamp forms.
- **Every line feeds the ledger row** for its session, not only billed turns:
  - `last_ts_ms = max`.
  - The earliest cwd wins: take `entry.cwd` when the row has no project yet, or when `ts > 0` and (`project_ts_ms == 0` or `ts < project_ts_ms`).
  - `interactions += 1` for `type == "user"` and not `isMeta`.
- Tool calls: `n = count_claude_tool_calls(message.content)`. When `n > 0`, the key is `message.id ?? uuid ?? "<file>:<ts>"`. It counts only when not seen, where "seen" checks an in-run set of `session_key\0key` **first** and then `seen_tool_calls`. The in-run check inserts the key. Dedup is **per session and spans files**.
- Billing applies only to `type == "assistant"` with a model and a usage, a model other than `"<synthetic>"`, and `usage_token_total > 0`.
- `key = dedup_key(entry, file, seen_run.len())`. That is `requestId:message.id`, else `uuid`, else `"<file>:<seen_run size>"`. `seen_run` is per file per call.
  - **The first occurrence wins.** A key already in `seen_run` skips the line, so later snapshots of the same request are ignored. Mirror this exactly; do not switch to last-wins. The golden files record the TS behavior and decide.
  - `billed_before = has_seen_request(key)`.
  - `ledger_duplicate` is `ledger_seen.contains(key)` (then insert it) when this file is being rebuilt, else `billed_before`. When not a duplicate, add billed tokens to the `session_model_usage` row keyed `(session_key, model)`.
  - When `billed_before` is true, stop here. Otherwise push the key, then add to the hourly bucket `(hour_start_ms(ts), cwd or "", model)` and do `message_count += 1`. `hour_start_ms(0)` must yield `0`; confirm in `dedup.rs`.

### `prune_missing_files` → set of survivor paths

- `missing` = paths in `ingested_files` that are not in `files`. When `missing` is empty, return an empty set.
- For each missing path, collect its distinct `session_key`s from `session_ledger` (the disturbed sessions). In one transaction, `clear_ingested_file` and `clear_ledger_for_file` for each missing path.
- For each disturbed session that still has ledger rows, mark it living and add its remaining paths to `survivors`.
- One transaction then does three things:
  - For each missing path whose sessions are **all** dead, `clear_seen_requests_for_file`. Keep the keys when a sibling still holds them, or the rewind double-bills.
  - `DELETE FROM seen_tool_calls WHERE session_key = ?` for each living session.
  - For each survivor, clear its ledger and set `bytes_parsed = 0`.
- After the transaction, run `prune_seen_tool_calls`. Return `survivors`.

### Invariants that hold because of the above

- A transcript's deletion never reduces `usage_hourly`.
- A replay from byte 0 never touches `usage_hourly`, because `seen_requests` blocks re-billing. It rewrites the ledger rows from scratch, deduping against the run-scoped `ledger_seen`.
- `seen_requests` is never cleared wholesale. `seen_tool_calls` is cleared wholesale on rewind.

### Tests (`#[cfg(test)]`, temp dirs only)

- **Replay flag**: a rebuild of one file re-derives ledger rows equal to a fresh ingest, and leaves `usage_hourly` unchanged.
- **Shrink detection**: truncating a file below `bytes_parsed` triggers a full rewind, and `rebuilt` is true.
- **Per-session tool dedup across two files**: a tool_use message id repeated in a parent and a subagent transcript of one session counts once. The same id in two different sessions counts twice.
- **Deleted-file pruning**: tokens stay. The ledger rows and `seen_requests` of the deleted file go, unless a sibling in the same session still holds the request. `seen_tool_calls` of a fully deleted session go.
- **Partial trailing line**: `bytes_parsed` stops at the last newline, and the next run picks up the completed line.

## Acceptance criteria

- [ ] Every golden test whose name contains `rollup` passes against Rust: `rollup table <table>` for every table in `_context/contracts.md` §5, `rollup incremental append`, `rollup transcript deleted`, `rollup rebuild`, `rollup migrate v2`, `rollup refuse newer`, and `rollup pre-rust backup`.
- [ ] The same filter still passes against TS (with no `COCKPIT_BIN`), so the golden files were not edited to fit Rust.
- [ ] `cockpit atlas rollup-update --db <tmp>` prints `{"filesScanned", "rebuilt", "usageHourlyRows"}` in that order and exits 0; `--rebuild` sets `rebuilt: true`.
- [ ] Repeated usage snapshots of one request are billed once, first occurrence wins, exactly as TS; `cargo test` covers it.
- [ ] `cargo test` covers the five unit cases listed in Implementation notes, and they pass.
- [ ] The ingest reads only bytes from `bytes_parsed` onward (streamed through the jsonl reader), never a whole-file read on an incremental run.
- [ ] The executor's report gives the wall-clock time of `atlas rollup-update` on the fixture home for Rust and for TS (informational, not a gate).

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "rollup"` passes.
- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "rollup"` passes (TS side, Rust-only test skipped).
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::rollup_update` passes.
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check` and `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings` are clean.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Any golden `rollup` table differs, or a replay changes `usage_hourly` | Tables match on a fresh ingest, but incremental, delete, or rebuild scenarios drift (a double-counted sibling request, zeroed tool_calls, a stale ledger row after truncate-to-empty) | Every golden `rollup` test passes on both TS and Rust; prune-before-ingest, first-wins dedup, and per-session tool dedup match TS line for line |
| Test coverage | ×2 | No cargo tests | Happy-path ingest only | All five named units, including a sibling-held request surviving a delete and a partial trailing line |
| Interface & readability | ×1 | Signatures differ from `engine-api.md`, or `unwrap` on transcript or DB data | Works, but a monolithic function obscures the three phases | `update_rollup` / `ingest_file` / `parse_slice` / `prune_missing_files` mirror the TS phases; clippy clean |
| Assumptions & docs | ×1 | Silent deviations from TS | Deviations present but unexplained | Each non-obvious rule (why prune runs first, why the rebuild gate differs from `start == 0`, first-wins) carries a one-line why comment |

## Out of scope

- Reading the rollup back into Claude aggregates and the ledger for `/api/stats`. Deferred. Reason: the Claude data-source port owns `readRollupAggregates` / `readRollupLedger`.
- Nudging `rollup-update` from the statusline. Deferred. Reason: the statusline subcommand owns the throttle and detached spawn.
- Any change to `rollup_db.rs` schema, migrations, or the pre-rust backup. Deferred. Reason: already implemented by the rollup DB port; this task only calls its accessors.
