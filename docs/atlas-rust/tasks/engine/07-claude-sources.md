# ENGINE-07: Claude usage source and usage limits

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/03, contract/03
> **Blocks**: engine/08, cli/01
> **Status**: done

## Goal

`packages/monitor/cockpit-rs/src/atlas/claude.rs` returns the same Claude usage data as the TS engine: stats-cache, history, the rollup aggregates and ledger, and the statusline rate-limit windows. `cockpit atlas stats --source claude` matches the recorded TS golden.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/claude.rs` (modify — replace the scaffold stub) — Claude source + usage limits.

Edit no other file — not `model.rs`: the scaffold owns `UsageLimits`, `UsageLimitWindow`, and the window helpers in full, and the Codex port reads them in parallel. If one is missing or wrong, stop and report it as a scaffold defect. This task depends on the ingest port rather than just the schema, because `claude::load` runs `update_rollup` first, as TS `parseTranscriptUsage` does.

## Implementation notes

The TS source is `packages/monitor/skills/usage-dashboard/scripts/api.ts`. The line numbers below are verification pointers only.

### Public surface (fixed by `engine-api.md`)

```rust
pub struct ClaudeSource {
    pub usage: ProviderUsage,               // model.rs
    pub ledger: Vec<InternalLedgerRow>,     // model.rs
    pub transcript_file_count: usize,
    pub stats_cache: StatsCache,
    pub history: History,
}
pub fn load(ctx: &Ctx) -> anyhow::Result<ClaudeSource>;
pub fn read_usage_limits(ctx: &Ctx) -> UsageLimits;
pub fn source_json(ctx: &Ctx, src: &ClaudeSource) -> serde_json::Value;
```

Add `pub` fields to `ClaudeSource`, `StatsCache`, and `History` freely. Do not change the three function signatures.

### `parseStatsCache` (api.ts ~1194)

- Read `~/.claude/stats-cache.json` (`atlas/paths.rs`).
- Missing or unparseable is an **error**: `Missing or unreadable: <path>`. TS throws there, so `load` returns `Err`.
- `StatsCache` mirrors the TS type (api.ts ~333). Every field is optional, with `version`, `lastComputedDate`, `dailyActivity[]`, `dailyModelTokens[]`, `modelUsage`, `hourCounts`, `totalSessions`, `totalMessages`, `longestSession`, and `firstSessionDate`.
- Serialize with `skip_serializing_if = "Option::is_none"`. Unknown keys are ignored.

### `parseHistory` (api.ts ~1200)

`History` holds `by_project`, `week_hour_matrix`, `daily_history`, and `daily_hour_counts`:

- `by_project`: `IndexMap<String, {messageCount, firstSeen, lastSeen, path}>`, in first-seen order.
- `week_hour_matrix`: `[[i64; 24]; 7]`, indexed by local weekday with 0 = Sunday, then local hour.
- `daily_history`: `IndexMap<date, {messageCount, sessionIds: set}>`.
- `daily_hour_counts`: `IndexMap<date, [i64; 24]>`.

Behavior:

- A missing `~/.claude/history.jsonl` returns all-empty maps and a zero matrix.
- Read lines with `atlas::jsonl`. Skip blank lines and lines that are not valid JSON, silently.
- Take `ts = entry.timestamp` (use 0 when absent).
- When `ts != 0`, bump `week_hour_matrix[local weekday][local hour]`. Bump `daily_history[fmt_date(ts)]`, and add `sessionId` to its set when present. Bump `daily_hour_counts[date][local hour]`.
- Skip `by_project` when `project` is absent or empty. Otherwise, a new entry is `{messageCount: 1, firstSeen: ts || now, lastSeen: ts || 0, path}`, where **now is `model::now_ms()`, not the system clock**. An existing entry adds 1 to `messageCount`, lowers `firstSeen` / raises `lastSeen` only when `ts != 0`.
- Compute local time with `jiff` in the process TZ, exactly as `fmt_date` does.

### `readRollupAggregates` (api.ts ~1451)

Read every `usage_hourly` row. Build each row's `ModelUsage` from `input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `reasoning`, then fold it in:

- `model_usage[raw model]` receives every row. It is keyed by the **raw** model; stats assembly applies `model_key`.
- `project_model_usage[project][raw model]` and `project_tokens[project] += model_usage_total` receive only rows with a non-empty `project`.
- `hourly_usage[hour_ms]` (keyed by `model_key(Claude, model)`, as TS `addHourlyUsage`) and `daily_model_usage[fmt_date(hour_ms)][raw model]` receive only rows with `hour_ms != 0`.
- `hour_ms = 0` rows therefore count in model and project totals but never in the hourly or daily maps.
- Iterate rows in the order the rollup-db accessor returns them (the TS `allHourlyRows`), so the `IndexMap` insertion order matches.

### `readRollupLedger` (api.ts ~1506)

Sum per-file `session_ledger` rows into one row per `session_key`. Read the rows in the TS order, `(project_ts_ms, path)`, so the first non-empty `project` a session supplies becomes its origin cwd.

1. **Create a row** the first time a `session_key` appears: `id = "claude:<session_key>"`, `provider = "claude"`, `timestampMs 0`, `date ""`, `projectPath ""`, `projectName "n/a"`, `model "n/a"`, zero counts, `costBasis "unavailable"`, and an empty `usageByModel`.
2. **Fold each ledger row** into its session row:
   - A larger `last_ts_ms` sets `timestampMs` and `date = fmt_date`.
   - The first non-empty project sets `projectPath` and `projectName` (TS `projectName(path)`).
   - `interactions` and `toolCalls` add up.
3. **Fold `session_model_usage` rows** into `usageByModel[model_key(Claude, model)]`:
   - Add `input`, `output`, `cache_read`, and `cache_creation` into it.
   - Add `tokens += input + output + cache_read + cache_creation`.
   - Set `costBasis = "usage"`.
   - Skip rows whose session is unknown.
4. **Set `model`**: the single key when `usageByModel` has exactly one entry, `"mixed"` when it has more, `"n/a"` otherwise.
5. **Filter**: keep rows where `timestampMs > 0` and any of `interactions`, `tokens`, or `toolCalls` is > 0.

`date`, `projectName`, `model`, and `tokens` are derived here on every read, never stored.

### `parseTranscriptUsage` (api.ts ~1572) → `load`

1. List transcript files with `dedup::walk_files(<projects dir>, ".jsonl")`. This is a directory listing only: **never read transcript contents in this module**. The projects dir is `TOKEN_ATLAS_PROJECTS_DIR` or `~/.claude/projects`.
2. Open the rollup with `rollup_db::open_rollup_db(paths::rollup_db_path())`. That path is `TOKEN_ATLAS_ROLLUP_DB`, or `$XDG_DATA_HOME/q-lab/token-atlas/rollup.db`.
3. Call `rollup_update::update_rollup(&mut db, projects_dir, UpdateOptions { rebuild: false })`, then read the aggregates and the ledger.
4. If opening, updating, or reading fails, swallow the error as TS does and return empty aggregates plus an empty ledger. `transcript_file_count` still equals the number of listed files.
5. Call `parseStatsCache`, whose error propagates, and `parseHistory` inside `load` too.

### Usage limits (api.ts ~557–653)

- **`coerce_number` / `build_usage_limit_window`**: already ported in `model.rs` by the scaffold; call them, do not re-port.
- **`read_usage_limits`**: read `~/.cache/token-atlas/rate-limits.json`. Start from a base of `source "statusline-cache"`, `path = displayPath(...)` (the home prefix replaced by `~`), `capturedAt null`, `stale true`, `error null`, `fiveHour null`, `weekly null`.
  - Missing file: set `error: "missing"`.
  - Unparseable file: set `error` to the parse error message, or `"unreadable"`. This message may differ from JS's `SyntaxError` text; list the key in the golden volatile set only if the fixture exercises it (it does not by default).
  - Stale check: `capturedAtMs = capturedAtEpochMs ?? parse(capturedAt)`. `stale` is true when that is not finite or when `now_ms() - capturedAtMs > 5 * 60 * 1000`.
  - No `rate_limits`: set `capturedAt`, `stale`, and `error: "missing-rate-limits"`.
  - Otherwise set `fiveHour` with a 5 h window (`18_000_000` ms) and `weekly` with a 7 d window (`604_800_000` ms).
  - `plan` stays absent, since only Codex sets it.

### `source_json` (`--source claude`)

Emit `{usage, ledger, transcriptFileCount, statsCache, history, usageLimits}`, the same serialization the TS `--source claude` flag uses:

- `usage` is the five `ProviderUsage` maps in camelCase: `modelUsage`, `dailyModelUsage`, `hourlyUsage`, `projectTokens`, `projectModelUsage`.
- Numeric map keys (`hour_ms`) become strings.
- `ledger` is `InternalLedgerRow[]` with `usageByModel` as an object.
- `history` is `{byProject, weekHourMatrix, dailyHistory, dailyHourCounts}`, where each `sessionIds` set is a **sorted array**.
- `usageLimits` is `read_usage_limits(ctx)`.

Deep-equality ignores object key order, but array order must match TS.

## Acceptance criteria

- [x] `claude.rs` exposes exactly the `engine-api.md` signatures for `ClaudeSource`, `load`, `read_usage_limits`, and `source_json`. `model.rs` is unchanged.
- [x] Under the fixture home, `cockpit atlas stats --source claude` deep-equals the recorded TS golden (golden test `source claude` passes against Rust).
- [x] `load` never opens a `.jsonl` transcript itself. Transcript bytes are read only by `update_rollup`.
- [x] `hour_ms = 0` rows appear in `modelUsage` and `projectTokens` but not in `hourlyUsage` or `dailyModelUsage`. A session spanning two files yields one ledger row whose counts are summed and whose project is the earliest-`project_ts_ms` cwd. Each has a `cargo test`.
- [x] `cargo test` units cover the missing, unreadable, missing-rate-limits, and stale `read_usage_limits` branches
  - a history file with malformed and blank lines skipped
- [x] An unopenable rollup DB (for example, `TOKEN_ATLAS_ROLLUP_DB` pointing into a non-directory) makes `load` return empty aggregates with the correct `transcript_file_count`. A missing `stats-cache.json` makes `load` return `Err`.
- [x] The rollup golden tests stay green against Rust.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source claude"`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "rollup"`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::claude`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | `source claude` golden fails, or `load` reads transcript contents | golden passes, but the `hour_ms = 0` exclusion, ledger origin-cwd order, empty-string coercion, or the stale threshold drifts from TS | golden and rollup tests pass; every rule in Implementation notes matches TS, including the clock going through `now_ms()` |
| Test coverage | ×2 | no `cargo test` for this module | happy path only | units cover coercion, window clamps, all `read_usage_limits` branches, malformed history lines, `hour_ms = 0`, and a multi-file session |
| Interface & readability | ×1 | signatures differ from `engine-api.md`, or `unwrap` on file or JSON data | signatures match but TS helpers are split into one-caller abstractions | one module mirroring the TS sections, clear types, clippy clean |
| Assumptions & docs | ×1 | silent divergences from TS | divergences exist without a comment | each deliberate difference (for example, the parse-error message text) has a one-line why comment |

## Out of scope

- Reading `~/.claude/sessions/*.json` — Deferred. Reason: `atlas/session_files.rs` already ports it.
- Budget (`loadBudgetConfig`), data health, insights, and applying `model_key` to Claude model usage — Deferred. Reason: these belong to stats assembly in `stats.rs`.
- Transcript tail-parsing and rollup writes — Deferred. Reason: `rollup_update.rs` owns them; this module only calls `update_rollup`.
- Codex usage limits — Deferred. Reason: `codex.rs` owns them; the shared `UsageLimits` types come complete from the scaffold.
