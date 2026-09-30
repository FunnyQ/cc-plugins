# ENGINE-06: OpenCode usage source

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/01, contract/03
> **Blocks**: engine/08
> **Status**: done

## Goal

`packages/monitor/cockpit-rs/src/atlas/opencode.rs` reproduces the TS OpenCode data source (`parseOpenCodeUsage` and its helpers in `usage-dashboard/scripts/api.ts`), so that `cockpit atlas stats --source opencode` prints JSON deep-equal to the recorded TS golden.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/opencode.rs` (modify) — replace the `todo!()` stubs with the port: `load`, `source_json`, the `OpenCodeSource` struct fields, private helpers, and a `#[cfg(test)] mod tests`.

No other file. `Cargo.toml`, `atlas/mod.rs`, `model.rs`, and `stats.rs` belong to other work; the `--source opencode` dispatch in `stats.rs` already calls this module.

## Implementation notes

The TS source is authoritative while it exists: `api.ts` lines ~275–332 (types), ~1424–1434 (`openCodeStorageRoots`), ~2021–2376 (`openCodeUsageFromTokens`, `countOpenCodeToolCalls`, `parseOpenCodeUsage`), and `shared/scripts/opencode.ts` (`openCodeTimestampMs`). Port behavior, not structure.

### Public API (fixed by `engine-api.md`)

```rust
pub struct OpenCodeSource {
    pub usage: ProviderUsage,            // modelUsage, dailyModelUsage, hourlyUsage, projectTokens, projectModelUsage
    pub project_activity: IndexMap<String, OpenCodeProjectActivity>,
    pub daily_activity: IndexMap<String, OpenCodeDailyActivity>,
    pub week_hour_matrix: [[i64; 24]; 7],
    pub daily_hour_counts: IndexMap<String, [i64; 24]>,
    pub total_sessions: i64,
    pub total_interactions: i64,
    pub total_tool_calls: i64,
    pub ledger: Vec<InternalLedgerRow>,
    pub open_code_session_file_count: usize,
    pub open_code_message_file_count: usize,
    pub open_code_session_row_count: usize,
    pub open_code_message_row_count: usize,
}
#[serde(rename_all = "camelCase")]
pub struct OpenCodeProjectActivity { session_count, interaction_count, tool_call_count, first_seen, last_seen, path }
pub struct OpenCodeDailyActivity { session_count, interaction_count, tool_call_count }

pub fn load(ctx: &Ctx) -> anyhow::Result<OpenCodeSource>;
pub fn source_json(src: &OpenCodeSource) -> serde_json::Value;
```

Field order in each struct follows the TS return object, so JSON key order matches. Use `IndexMap` for every TS `Map` (insertion order becomes array order downstream).

### `source_json` shape

`{"usage": <parseOpenCodeUsage() result>}` — the whole TS return object under `usage`, with every `Map` serialized as an object (numeric keys such as `hourlyUsage`'s `hour_ms` stringified) and `InternalLedgerRow.usageByModel` (a `Map`) as an object. Everything else as plain JSON.

### Paths and DB access

- DB path: the existing `crate::paths::opencode_db()` — honors `COCKPIT_OPENCODE_DB`, else `$OPENCODE_DATA_DIR/opencode.db`, else `~/.local/share/opencode/opencode.db`. Do not add a second resolver.
- Storage roots (`openCodeStorageRoots`): `<dirname(db)>/storage` if it exists, plus `<dirname(db)>/project/<name>/storage` for each entry that exists, deduplicated, in that order.
- Session files: `walk_files(<root>/session, ".json")` over all roots; message files: `walk_files(<root>/message, ".json")`. Use `dedup::walk_files` from the scaffold. Their counts are `open_code_session_file_count` / `open_code_message_file_count` — counted even when the DB is used.
- Open the DB only if the file exists, with `OpenFlags::SQLITE_OPEN_READ_ONLY`. Queries, verbatim:
  - `select id, directory, time_created, time_updated from session`
  - `select message_id, count(*) as tool_calls from part where json_extract(data, '$.type') = 'tool' group by message_id`
  - `select id, session_id, time_created, time_updated, data from message`
- **Any DB error swallows silently** (TS `catch {}`): keep whatever row counts were already set, and fall through to the JSON fallback rules below. A missing DB is not an error.

### Merge rules between DB and legacy JSON

- Sessions: DB rows fill `sessions_by_id` as `{id, directory, time: {created: time_created, updated: time_updated}}`. **Only when the DB produced 0 session rows**, read each session file; a parsed session with an `id` is inserted.
- Messages from the DB: parse `data` as JSON (skip on parse failure). Override `id` = row id, `sessionID` = `session_id`, `time.created` = `info.time.created ?? row.time_created`, `time.completed` = `info.time.completed ?? row.time_updated`; `fallbackTimestampMs` = `row.time_updated || row.time_created`; `toolCalls` = the per-message count from the `part` query, else 0.
- **Only when the DB produced 0 message rows**, read each message file: `info = stored.info ?? stored`; `sessionId = info.sessionID ?? stored.sessionID ?? <parent dir name of the file> ?? <file path>`; `fallbackTimestampMs = 0`; `toolCalls = count of stored.parts entries with type == "tool"` (0 when `parts` is not an array).
- Note the ordering in TS: DB messages are ingested inside the DB block, *before* the legacy session files are read. A DB message whose session is only in a legacy file therefore sees no session. Port that order exactly.

### Timestamps (`openCodeTimestampMs`)

`fn open_code_timestamp_ms(v: f64) -> i64`: non-finite or `<= 0` → `0`; `< 1_000_000_000_000` → seconds, multiply by 1000; else already ms. Port exactly, including that the check is on the raw number.

Per message: `created = ts(info.time.created) || ts(session.time.created) || ts(fallback)`; `completed = ts(info.time.completed) || ts(session.time.updated) || created`; `timestamp = completed || created`; `0` → skip the message entirely.

### Ingest per message

- `cwd = info.path.cwd ?? session.directory ?? ""`.
- Ledger row per session, keyed by `sessionId`, created on first sight: `id: "opencode:<sessionId>"`, `provider: opencode`, `timestampMs`, `date: fmt_date(ts)`, `projectPath: cwd`, `projectName: cwd ? project_name(cwd) : "n/a"`, `model: "n/a"`, `interactions 0`, `toolCalls 0`, `tokens 0`, `costBasis: "unavailable"`, empty `usageByModel`; private `project_first_seen = ts`, `user_message_ids = {}`. On every message: `timestampMs = max`, recompute `date`, `project_first_seen = min`, fill `projectPath`/`projectName` if still empty and `cwd` is non-empty.
- `role == "user"`: id = `info.id ?? "<sessionId>:<ts>"`; count one interaction per unique id; stop.
- Skip unless `role == "assistant"` and `tokens` present. `model = info.modelID || "unknown"` (empty string also → unknown); key = `model_key(Opencode, model)` → `opencode:<modelID>` — **not** `providerID/modelID`.
- `usage = open_code_usage_from_tokens(tokens)`: `inputTokens = input ?? 0`, `outputTokens = output ?? 0`, `cacheReadInputTokens = cache.read ?? 0`, `cacheCreationInputTokens = cache.write ?? 0`, `reasoningOutputTokens = reasoning ?? 0` (always present); `webSearchRequests` absent. If `cost` is a finite number, set `costUSD = cost`.
- Skip when `model_usage_total(usage) <= 0` and not `cost > 0`.
- Otherwise: add into the ledger's `usageByModel[key]`; `tokens += total`; `costBasis = "usage"`; `model = key` if the ledger has exactly one model key, else `"mixed"`; `toolCalls += toolCalls` (tool calls count only on assistant messages that pass the filter). Add into `modelUsage[key]`, hourly (`add_hourly_usage`: skip `ts == 0`, bucket at `hour_start_ms`), `dailyModelUsage[fmt_date(ts)][key]`, and — only when `cwd` is non-empty — `projectTokens[cwd] += total` and `projectModelUsage[cwd][key]`.

### Post-pass over ledger rows (in insertion order)

- Drop a row when `timestampMs <= 0`, or when interactions, tokens, and toolCalls are all `<= 0`.
- Kept rows (without the private fields) go into `ledger`; add interactions/toolCalls to the totals; `total_sessions = kept count`.
- `daily_activity[fmt_date(ts)]`: `sessionCount += 1`, `interactionCount += interactions`, `toolCallCount += toolCalls`.
- `week_hour_matrix[local weekday (Sun = 0)][local hour] += interactions`; `daily_hour_counts[date][local hour] += interactions` (24 zeros on first sight). Use `jiff` in the process's local time zone, matching `fmt_date`.
- `project_activity[projectPath]` when `projectPath` is non-empty: create `{sessionCount 1, interactionCount, toolCallCount, firstSeen: project_first_seen, lastSeen: timestampMs, path}`, or add counts, `firstSeen = min`, `lastSeen = max`.

### Shared helpers

`add_hourly_usage`, `add_nested_model_usage`, and `project_name` (`live-sessions.ts` `projectNameFor`) are needed by all three provider sources. The scaffold already ported them into `model.rs`; call them, never copy them.

### Numbers

Token counts are `i64`. `costUSD` is `f64`. `timestampMs` values from JSON may be floats in TS; read them as `f64`, convert through `open_code_timestamp_ms`.

## Acceptance criteria

- [x] `cockpit atlas stats --source opencode` under the fixture home prints JSON deep-equal to the recorded TS golden (golden test `source opencode` passes against Rust).
- [x] `open_code_usage_from_tokens` maps `{input 10, output 5, reasoning 3, cache {read 2, write 1}}` to `{inputTokens 10, outputTokens 5, cacheReadInputTokens 2, cacheCreationInputTokens 1, reasoningOutputTokens 3}`, and an empty token object to all zeros (cargo unit test).
- [x] `open_code_timestamp_ms` returns `0` for `0`, negative, and NaN, multiplies `1_700_000_000` by 1000, and leaves `1_700_000_000_000` unchanged (cargo unit test).
- [x] With no DB file and no storage dirs, `load` returns `Ok` with empty usage, empty ledger, and all four counts `0` (cargo unit test using a temp dir via `COCKPIT_OPENCODE_DB`).
- [x] When the DB has message rows, legacy message files are counted in `open_code_message_file_count` but not ingested; when it has none, they are ingested (cargo unit test with a temp DB and temp storage).
- [x] An assistant message with zero tokens and no positive cost adds nothing, and a user message repeated with the same id counts one interaction (cargo unit test).
- [x] The DB is opened read-only; a DB file whose schema lacks the `part` table leaves counts as TS would and does not error out of `load`.
- [x] `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` are clean.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source opencode"`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::opencode`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | `source opencode` golden fails, or model keys / timestamps differ from TS | golden passes, but a merge rule (DB-vs-legacy gating, message ordering before legacy sessions, seconds-vs-ms detection) drifts from TS on an input the fixture lacks | golden passes and every rule under Implementation notes matches TS, including the skip conditions and the ledger post-pass |
| Test coverage | ×2 | no cargo tests | token mapping only | unit tests for token mapping, timestamp detection, missing DB, DB-vs-legacy gating, zero-token skip, and user-message dedup |
| Interface & readability | ×1 | signatures differ from `engine-api.md`, or `unwrap` on DB/JSON data | matches the API but mixes I/O into helpers that could be pure | matches `engine-api.md`; ingest logic is one private function like TS; no one-caller abstractions |
| Assumptions & docs | ×1 | silent deviations from TS | deviations present but uncommented | every deliberate difference (e.g. helpers kept local until hoisted) has a one-line why comment |

## Out of scope

- OpenCode live sessions for `/api/live` — Deferred. Reason: they live in the live-sessions module, which reads different columns.
- Pricing or cost computation for OpenCode models — Deferred. Reason: cost is computed during stats assembly; this module only carries `costUSD` from the message.
- Changing `crate::paths::opencode_db()` — Deferred. Reason: cockpit already relies on it and it already matches the TS resolver.
