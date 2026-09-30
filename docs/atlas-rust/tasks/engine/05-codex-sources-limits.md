# ENGINE-05: Codex usage source and usage limits

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/01, engine/02, contract/03
> **Blocks**: engine/08, cli/01
> **Status**: todo
> **Models**: dev=opus/high

## Goal

`packages/monitor/cockpit-rs/src/atlas/codex.rs` reproduces the TS Codex data source: it returns the same usage aggregates and ledger from `state_5.sqlite` and the rollouts, keeps the `codex-sessions.db` cache, and fetches Codex usage limits. The golden `source codex` test then passes against the Rust binary.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/codex.rs` (modify — the scaffold left it as a stub with the signatures below) — the whole port plus its `#[cfg(test)] mod tests`.

Edit no other file. Do not edit `model.rs` or `dedup.rs`: other data-source ports run in parallel against them.

## Implementation notes

The TS is the authoritative behavior. Port from:

- `packages/monitor/skills/usage-dashboard/scripts/codex-cache.ts`: `openCodexCache`, `summariseSessions`, `pruneCache`.
- `packages/monitor/skills/usage-dashboard/scripts/api.ts`:
  - Rollout and thread parsing (~1615–2020): `readCodexSession`, `codexUsageFromTokenUsage`, `codexTokenUsageDelta`, `codexUsageFromThread`, `parseCodexUsage`.
  - Usage limits (~655–850): `codexUsageBase`, `buildCodexUsageLimits`, `fetchCodexUsageWithToken`, `refreshCodexAccessToken`, `fetchCodexUsage`, `readCodexUsageCache`, `readCodexUsageLimits`.
  - Constants: `CODEX_CLIENT_ID`, `RATE_LIMITS_STALE_AFTER_MS`, `FIVE_HOUR_MS`, `SEVEN_DAY_MS`, `CODEX_WEEKLY_MIN_MS`.

### Public signatures (frozen, from `engine-api.md`)

```rust
pub struct CodexSource {
    pub usage: ProviderUsage,              // modelUsage, dailyModelUsage, hourlyUsage, projectTokens, projectModelUsage
    pub project_activity: IndexMap<String, CodexProjectActivity>, // {threadCount, interactionCount, toolCallCount, firstSeen, lastSeen, path}
    pub daily_activity: IndexMap<String, CodexDailyActivity>,     // {threadCount, interactionCount, toolCallCount}
    pub week_hour_matrix: [[i64; 24]; 7],  // [getDay()][getHours()], local time
    pub daily_hour_counts: IndexMap<String, [i64; 24]>,
    pub total_threads: usize,              // sessionFiles.size
    pub total_interactions: i64,
    pub total_tool_calls: i64,
    pub ledger: Vec<InternalLedgerRow>,
    pub codex_session_file_count: usize,
    pub codex_thread_row_count: usize,
}
pub fn load(ctx: &Ctx) -> anyhow::Result<CodexSource>;
pub async fn read_codex_usage_limits(ctx: &Ctx) -> UsageLimits;
pub fn source_json(src: &CodexSource, limits: &UsageLimits) -> serde_json::Value; // the whole `--source codex` object
```

`CodexSource` field names mirror `parseCodexUsage`'s return value. `source_json` returns the whole `--source codex` object `{usage, usageLimits}`, exactly as the TS `--source codex` serializer emits it (a `Map` becomes an object with number keys stringified). The dispatcher in `stats.rs` (already written) calls `source_json(&load(&ctx)?, &read_codex_usage_limits(&ctx).await)`.

### Paths

- `~/.codex/state_5.sqlite`, `~/.codex/sessions/**/*.jsonl` and `~/.codex/auth.json` are all under `$HOME`. Take them from `atlas::paths`, and never from cockpit's `paths::codex_*`, because those honor `COCKPIT_CODEX_*`.
- Codex usage cache: `~/.cache/token-atlas/codex-usage-limits.json`.
- Rollout summary cache: `$XDG_DATA_HOME/q-lab/token-atlas/codex-sessions.db` (`atlas::paths::codex_cache_path()`). It is **not** placed next to a `TOKEN_ATLAS_ROLLUP_DB` override.

### `threads` query (read-only)

Open with `OpenFlags::SQLITE_OPEN_READ_ONLY`. A missing file, or any open or query error, gives zero rows, as the TS `catch { rows = [] }` does. The SQL must stay exactly:

```sql
select id, rollout_path, created_at, updated_at, cwd, title, model, tokens_used
from threads
where tokens_used > 0 or rollout_path != ''
order by created_at asc
```

`created_at` and `updated_at` are epoch **seconds**; multiply them by 1000.

### Rollout summary (`readCodexSession`)

The TS `CodexSessionSummary` is `{id, timestampMs, cwd, model, tokenUsage, tokenEvents[{timestampMs, usage}], userMessages, toolCalls}`.

1. A missing file gives `null`. Any other read error yields zero lines, not `null`.
2. Skip blank lines and unparseable lines.
3. The first parseable `timestamp` sets `timestampMs`.
4. `session_meta` sets `id`, `cwd` and `model`, and falls back to `payload.timestamp` for `timestampMs`.
5. `turn_context` updates `cwd` and `model`.
6. `response_item`: `function_call` counts a tool call, and a `message` with role `user` counts a response-user message.
7. `event_msg`: `user_message` counts an event-user message. `token_count` with `info.total_token_usage` sets `latest`, which means last wins, and pushes a token event only when the entry timestamp parses to a finite, non-zero value.
8. `userMessages = max(responseUserMessages, eventUserMessages)`.

Read lines with `atlas::jsonl`, the UTF-8-safe reader.

### Summary cache (`summariseSessions`)

1. Bulk-read `session_summary(path, size, mtime_ms, summary)`.
2. For each file, `stat` it. If `stat` fails, compute the summary and skip caching.
3. `mtime_ms = floor(mtimeMs)`. A row matches when `size` and `mtime_ms` are equal and `summary` parses. A corrupt row is recomputed.
4. Cache a `null` summary too, as the JSON text `null`.
5. Write every new row in one transaction with `INSERT … ON CONFLICT(path) DO UPDATE`.
6. Prune every row whose path is not in **this run's file set**. That set is the current thread rollouts plus the walked files, so a row is pruned even when its file still exists but has left the set.
7. If opening the cache fails, compute every summary directly.

**Mixed fleet:** a TS dashboard and a Rust dashboard share this DB. The summary JSON Rust writes must be the TS `JSON.stringify(summary)` shape: camelCase keys, and `tokenUsage` keeps the snake_case `CodexTokenUsage` field names (`input_tokens`, `cached_input_tokens`, …). Rust must also read rows the TS wrote. A cargo test round-trips a TS-shaped literal.

### Aggregation (`parseCodexUsage`)

These rules must match exactly:

- **Session set:** the thread `rollout_path`s that are non-empty, then the walked `.jsonl` files, deduped in insertion order (a JS `Set`). Iterate in that order, because it becomes ledger order.
- **Per file:**
  - `model = row.model || session.model || "unknown"`. Any empty string falls through (JS `||`).
  - `key = "codex:" + model`.
  - `usage = codexUsageFromThread`: from `session.tokenUsage` when it is present, else `{inputTokens: tokens_used}` with the rest set to 0.
  - `tokenTotal = row.tokens_used || modelUsageTotal(usage)`. A 0 falls through.
  - `createdMs = row.created_at*1000`, else `session.timestampMs`, else 0. Skip the file when it is 0.
  - `updatedMs = row.updated_at*1000`, else `createdMs`.
  - `cwd = row.cwd || session.cwd || ""`.
  - `interactionCount = session.userMessages || 1`. A 0 becomes 1.
  - `toolCallCount = session.toolCalls ?? 0`.
- **`codexUsageFromTokenUsage`:**
  - `inputTokens = max(0, input_tokens - cached_input_tokens)`
  - `cacheReadInputTokens = cached_input_tokens`
  - `cacheCreationInputTokens = 0`
  - `reasoningOutputTokens = reasoning_output_tokens`
- **Hourly usage:** with token events, add a delta for each event against the previous event's cumulative usage (`codexTokenUsageDelta`, every field `max(0, cur - prev)`; the first event is taken whole). Without token events, add the whole usage at `updatedMs || createdMs`.
- **Local-time buckets:** `dailyModelUsage`, `projectTokens` and `projectModelUsage` follow the TS rules, and project entries require a non-empty `cwd`. `projectActivity` uses min `firstSeen` and max `lastSeen`. `dailyActivity`, `weekHourMatrix[getDay()][getHours()]` and `dailyHourCounts` all use **local time** from `createdMs` (`TZ` is pinned in tests).
- **Ledger row:**
  - `id = "codex:" + (row.id ?? session.id ?? file)`
  - `timestampMs = updatedMs || createdMs`; `date = fmt_date(that)`
  - `projectName = projectName(cwd)` when `cwd` is set, else `"n/a"`
  - `costBasis` is `usage` when the session has a `tokenUsage`, else `thread_tokens` when `tokens_used` is non-zero, else `unavailable`
  - `usageByModel = {key: usage}`
- **Second loop:** threads with an empty `rollout_path` add hourly usage at `(updated_at || created_at)*1000`, plus model, daily and project usage. Their ledger row has `interactions 1`, `toolCalls 0`, `tokens = tokens_used`, and `costBasis` of `thread_tokens` or `unavailable`. These threads do not touch `projectActivity`, `dailyActivity`, `weekHourMatrix`, `dailyHourCounts` or the totals.
- **Counts:** `total_threads` is the session-set size, `codex_session_file_count` is the number of walked files, and `codex_thread_row_count` is the number of rows.

### Usage limits (`readCodexUsageLimits`)

1. **Read the cache file.**
   - A missing file gives `codexUsageBase("missing")`.
   - An unreadable or corrupt file gives `codexUsageBase(<the readJSONWithError message>)`. Port its messages.
   - Otherwise `capturedAtMs = capturedAtEpochMs ?? Date.parse(capturedAt) ?? NaN`, and the result is `buildCodexUsageLimits(usage, capturedAt, capturedAtMs, null, now_ms())`.
2. **Return the cached limits** when they are neither stale nor in error. Stale means `now - capturedAtMs > 5 min`, or `capturedAtMs` is not finite.
3. **Fetch** (`fetchCodexUsage`):
   - Read `auth.json`. The errors are `missing-auth`, `unreadable-auth` or the parse message, and `missing-access-token`. The account id is `tokens.account_id ?? ""`.
   - GET `TOKEN_ATLAS_CODEX_USAGE_URL`, falling back to `https://chatgpt.com/backend-api/codex/usage`, with a **4 s** timeout.
   - Send exactly these headers: `Authorization: Bearer <token>`, `Accept: application/json`, `chatgpt-account-id: <id>`, and `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36`.
   - A non-2xx response is the error `http-<status>`.
4. **Refresh the token only when the usage call failed with `http-401` or `http-403`.**
   - POST form-urlencoded `grant_type=refresh_token&refresh_token=<rt>&client_id=app_EMoamEEZ73f0CkXaXp7hrann` to `TOKEN_ATLAS_CODEX_TOKEN_URL`, falling back to `https://auth.openai.com/oauth/token`, with a 4 s timeout.
   - The errors are `missing-refresh-token`, `refresh-http-<status>` and `missing-refreshed-access-token`.
   - Retry the usage call once with the new token.
   - **The refreshed token is never written back to `auth.json`**, because the TS does not write it. Pin that with a comment.
   - An "expired" token matters only through the 401. The fixture's stub has to answer the stale token with 401 for this path to run.
5. **On success**, write `{capturedAt: ISO string of now, capturedAtEpochMs: now, usage}` with 2-space indent and a trailing newline. Create the cache dir first. Then return `buildCodexUsageLimits(usage, capturedAt, now, null, now)`.
6. **On any fetch error**, return the cached value with `stale: true` and `error` set to the message if the cache had a `capturedAt`. Otherwise return `codexUsageBase(message)`, with `"fetch-failed"` for a non-Error.
7. **Build the limits** (`buildCodexUsageLimits`):
   - Place each bucket by its window length, not by field name. Use `limit_window_seconds*1000` when it coerces to a number, else fall back to 5 h for primary and 7 d for secondary.
   - A window `≥ CODEX_WEEKLY_MIN_MS` goes to `weekly`, and anything shorter goes to `fiveHour`. The first bucket wins each slot.
   - The error is `missing-rate-limits` when both buckets are absent.
   - `plan = usage.plan_type ?? null`.
   - `codexUsageBase` returns `{source: "codex-api", path: displayPath(cache), capturedAt: null, stale: true, error, plan: null, fiveHour: null, weekly: null}`. Here `displayPath` replaces `$HOME` with `~`; port it.

Use `reqwest` with the rustls feature the scaffold enabled. Take the clock from `model::now_ms()`, and never from `SystemTime::now()`.

### Shared helpers

The port needs `add_model_usage`, `model_usage_total`, `empty_model_usage`, `model_key` and `fmt_date` from `model.rs`, and `walk_files` from `dedup.rs`. It also uses `add_hourly_usage`, `add_nested_model_usage`, `project_name`, `coerce_number`, `build_usage_limit_window` and `display_path`, which the scaffold already ported into `model.rs`. Call them; never copy them.

## Acceptance criteria

- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source codex"` passes. The fixture home's 401 → refresh → retry path runs, and the stub records one token POST carrying the fixed `client_id`.
- [ ] Every `CodexSource` field is populated per the aggregation rules above. The ledger keeps session-set insertion order, and threads with an empty `rollout_path` appear after the rollout-backed rows.
- [ ] The `codex-sessions.db` cache hits when size and floor(mtime) are unchanged, recomputes on a change or a corrupt row, caches `null` summaries, and prunes rows outside the current file set. Each case has a cargo test on a temp DB.
- [ ] A summary JSON row written by the TS (a literal in a cargo test) deserializes, and a Rust-written row serializes to the same camelCase / snake_case shape.
- [ ] The usage-limit error paths each return the TS error string: `missing` cache, `missing-auth`, `missing-access-token`, `http-500` without a refresh, `refresh-http-<status>`, and a stale cache that keeps `capturedAt` on fetch failure. These are cargo tests or golden-fixture variants.
- [ ] `auth.json` is byte-identical after a refresh, and a fresh cache (under 5 min old) makes no HTTP request.
- [ ] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` are clean.
- [ ] (human) In two roots built by the real-data recipe in `../_context/shared.md` (skip its `codex-usage-limits.json` copy so both runs fetch), run `packages/monitor/cockpit-rs/target/release/cockpit atlas stats --source codex` in one and `bun packages/monitor/skills/usage-dashboard/scripts/api.ts --source codex` in the other, back to back. The two `usageLimits` show the same plan, the same windows and the same `usedPercent`. This calls the real Codex API with the real `auth.json` (read through the symlink); every write stays in the temp roots.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::codex`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source codex"`
- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source codex"` still passes against TS, which proves the fixture was not bent to fit Rust.
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | `source codex` golden fails, or the refresh token is written back / refresh fires on non-401 | Golden passes, but a JS-falsy fallback (`\|\|` on 0 or `""`), local-time bucketing, the second thread loop, or a usage-limit error string drifts from the TS | Golden passes against Rust and TS; every fallback, error string, cache rule and header matches the TS |
| Test coverage | ×2 | Only the golden test | Golden plus the happy-path cache hit | Cargo tests cover the token delta (first event whole, negative clamps to 0), thread fallback, cache hit/miss/corrupt/prune/null, the TS-shaped summary round-trip, and every usage-limit error path |
| Interface & readability | ×1 | Changes a frozen signature or edits a shared module | Frozen signatures kept, but `unwrap` on external data or helpers with one caller | Frozen signatures intact; `codex.rs` mirrors the TS function by function; no `unwrap` on I/O or JSON; clippy clean |
| Assumptions & docs | ×1 | Deliberate differences from the TS go unmarked | Some differences marked | One-line comments pin the no-write-back rule, the 401/403-only refresh, the prune-by-file-set rule, and any private copy of a shared helper |

## Out of scope

- Codex live sessions for `/api/live` — Deferred. Reason: the live-sessions port owns the `threads` columns `created_at_ms`, `updated_at_ms` and `archived`.
- OpenCode and Claude sources — Deferred. Reason: separate data-source ports own them.
- Assembling the Codex aggregates into `/api/stats` (`summary.providers.codex`, `byModel`, cost) — Deferred. Reason: the stats assembly owns the payload. This task only returns `CodexSource`.
- Writing a refreshed token back to `auth.json` — Rejected. Reason: the TS never does it, and the file belongs to the Codex CLI.
