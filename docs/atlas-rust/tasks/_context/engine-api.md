# Engine module API

> The Rust signatures every `atlas/` module exposes to the others. The scaffold creates each module with these signatures and `todo!()` bodies; each port fills in its own module and never changes another module's signature. A port may add private items freely and add `pub` fields to its own structs; it may not rename or remove anything listed here. If a signature here proves wrong, change this file and PLAN.md, not just the code.

## Conventions

- **Types mirror TS types of the same name, field for field**, with `#[serde(rename_all = "camelCase")]` so JSON matches (`input_tokens` ↔ `inputTokens`). Where TS marks a field optional and omits it, use `Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]`.
- **Maps**: use `indexmap::IndexMap` (direct dependency added by the scaffold; serde_json `preserve_order` already pulls it in) wherever TS builds a `Map` or object whose iteration order later becomes an array order in the payload. Use `BTreeMap` only where TS sorts explicitly.
- **Clock**: every "now" in the engine and the live module goes through `model::now_ms()`, never `SystemTime::now()` directly, so `TOKEN_ATLAS_NOW_MS` pins it. Three exceptions read the real clock because the TS does: the statusline's `rate-limits.json` capture stamp, the statusline nudge throttle, and push-usage's `capturedAt`. `rollup_update`'s `ingested_files.updated_at` is also real-clock.
- **Errors**: `anyhow::Result` at module boundaries. Best-effort reads that TS swallows return the TS fallback value, not an error.
- **Async only for network**: pricing and Codex usage limits do HTTPS and are `async`. Every parse/SQLite function is synchronous; the caller runs it in `spawn_blocking` (server) or directly (CLI).

## `model.rs` (+ `paths.rs`, `dedup.rs`, `jsonl.rs`, `session_files.rs`) — implemented by the scaffold

```rust
pub fn now_ms() -> i64;                                   // TOKEN_ATLAS_NOW_MS or the real clock
pub struct Ctx { pub now_ms: i64, pub plugin_root: std::path::PathBuf }
impl Ctx { pub fn from_env() -> anyhow::Result<Ctx>; }    // plugin_root via crate::paths::plugin_root()

#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ModelUsage { /* api.ts `ModelUsage` */ }
pub struct TranscriptUsage { /* api.ts `TranscriptUsage` */ }
pub struct HourlyUsageBucket { /* api.ts `HourlyUsageBucket` */ }
pub struct InternalLedgerRow { /* api.ts `InternalLedgerRow` */ }

/// The five aggregates every provider source returns (api.ts `ClaudeAggregates`).
#[derive(Default)]
pub struct ProviderUsage {
    pub model_usage: IndexMap<String, ModelUsage>,
    pub daily_model_usage: IndexMap<String, IndexMap<String, ModelUsage>>,
    pub hourly_usage: IndexMap<i64, HourlyUsageBucket>,
    pub project_tokens: IndexMap<String, i64>,
    pub project_model_usage: IndexMap<String, IndexMap<String, ModelUsage>>,
}

pub enum Provider { Claude, Codex, Opencode }            // serializes lowercase
pub fn model_key(provider: Provider, model: &str) -> String;   // "claude:claude-opus-4-7"
pub fn provider_from_model_key(key: &str) -> Provider;
pub fn raw_model_from_key(key: &str) -> &str;
pub fn empty_model_usage() -> ModelUsage;
pub fn add_usage(target: &mut ModelUsage, usage: &TranscriptUsage);
pub fn add_model_usage(target: &mut ModelUsage, source: &ModelUsage);
pub fn model_usage_total(usage: &ModelUsage) -> i64;
pub fn fmt_date(ms: i64) -> String;                       // api.ts fmtDate, local time
// Helpers every provider source needs; owned here so no source keeps a private copy.
pub fn add_hourly_usage(/* api.ts addHourlyUsage params */);
pub fn add_nested_model_usage(/* api.ts addNestedModelUsage params */);
pub fn project_name(path: &str) -> String;                // api.ts projectName
pub fn display_path(path: &Path) -> String;               // api.ts displayPath: home prefix → "~"
pub fn coerce_number(value: &serde_json::Value) -> Option<f64>;           // api.ts coerceNumber
pub fn build_usage_limit_window(/* api.ts buildUsageLimitWindow params */) -> Option<UsageLimitWindow>;
```

`dedup.rs` ports `dedup.ts` (`walk_files`, `dedup_key`, `usage_token_total`, `count_claude_tool_calls`, `add_billed_tokens`, `hour_start_ms` — local hour). `jsonl.rs` ports `shared/scripts/jsonl-lines.ts` (UTF-8-safe cursor reader returning lines + the byte offset after the last complete line). `session_files.rs` ports `session-files.ts` (`read_session_files() -> Vec<ClaudeSessionFile>`; `pub struct ClaudeSessionFile` lives in `session_files.rs`, mirroring the TS type of the same name). `paths.rs` ports `paths.ts` plus `rollup_db_path()` and `codex_cache_path()`.

## `rollup_db.rs`

```rust
pub const SCHEMA_VERSION: i64 = 3;
pub fn open_rollup_db(path: &Path) -> anyhow::Result<rusqlite::Connection>;  // mkdir, WAL, busy_timeout, migrate, pre-rust backup
pub fn open_sqlite_file(path: &Path) -> anyhow::Result<rusqlite::Connection>; // shared opener, also used by codex-sessions.db
// + the rollup-db.ts accessors, as pub(crate) fns with the same names in snake_case
```

## `rollup_update.rs`

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct UpdateResult { /* rollup-update.ts updateRollup return value */ }
pub struct UpdateOptions { pub rebuild: bool }
pub fn update_rollup(db: &mut rusqlite::Connection, projects_dir: &Path, opts: UpdateOptions) -> anyhow::Result<UpdateResult>;
pub fn run(args: &[String]) -> std::process::ExitCode;    // `atlas rollup-update [--rebuild] [--db <path>]`
```

## `claude.rs`

```rust
pub struct ClaudeSource {
    pub usage: ProviderUsage,
    pub ledger: Vec<InternalLedgerRow>,
    pub transcript_file_count: usize,
    pub stats_cache: StatsCache,          // api.ts parseStatsCache
    pub history: History,                 // api.ts parseHistory return value
}
pub fn load(ctx: &Ctx) -> anyhow::Result<ClaudeSource>;  // runs update_rollup first, as parseTranscriptUsage does
pub fn read_usage_limits(ctx: &Ctx) -> UsageLimits;       // api.ts readUsageLimits (rate-limits.json)
pub fn source_json(ctx: &Ctx, src: &ClaudeSource) -> serde_json::Value;  // `atlas stats --source claude`
```

`UsageLimits` and `UsageLimitWindow` live in `model.rs` (both Claude and Codex limits return them).

## `codex.rs`

```rust
pub struct CodexSource { pub usage: ProviderUsage, /* + the rest of api.ts parseCodexUsage's return value */ }
pub fn load(ctx: &Ctx) -> anyhow::Result<CodexSource>;   // state_5 (ro), rollouts, codex-sessions.db cache
pub async fn read_codex_usage_limits(ctx: &Ctx) -> UsageLimits; // cache file, OAuth refresh, usage API
pub fn source_json(src: &CodexSource, limits: &UsageLimits) -> serde_json::Value; // `atlas stats --source codex`
```

## `opencode.rs`

```rust
pub struct OpenCodeSource { pub usage: ProviderUsage, /* + the rest of api.ts parseOpenCodeUsage's return value */ }
pub fn load(ctx: &Ctx) -> anyhow::Result<OpenCodeSource>;
pub fn source_json(src: &OpenCodeSource) -> serde_json::Value;
```

## `pricing.rs`

```rust
pub struct ModelPrice { /* api.ts ModelPrice */ }
pub struct PricingTable { /* api.ts PricingTable */ }
pub struct PricingMeta { /* api.ts PricingMeta */ }
pub struct PricingLoad { pub table: PricingTable, pub meta: PricingMeta }
pub async fn load_pricing_with_meta(ctx: &Ctx) -> anyhow::Result<PricingLoad>; // process-wide cache, as TS pricingCache; Err where TS throws
pub fn clear_pricing_cache();
pub fn price_for(model: &str, table: &PricingTable) -> ModelPrice;
pub fn calc_cost(/* api.ts calcCost params */) -> f64;
pub fn normalize_model_id(id: &str) -> String;
pub fn pricing_model_aliases(/* api.ts params */) -> Vec<String>;
pub fn pricing_meta_for_models(/* api.ts pricingMetaForModels params */) -> serde_json::Value;
#[derive(Serialize)] pub struct PricingRefreshResult { /* api.ts PricingRefreshResult */ }
pub async fn refresh_pricing_override(ctx: &Ctx, models: Vec<String>) -> anyhow::Result<PricingRefreshResult>;
pub fn source_json(load: &PricingLoad) -> serde_json::Value;         // `atlas stats --source pricing`
```

`refresh_pricing_override` takes the model list as given. Deriving it from a full stats build when the request carries none is the server handler's job, because pricing must not depend on `stats.rs`.

## `stats.rs`

```rust
pub async fn build(ctx: &Ctx) -> anyhow::Result<serde_json::Value>;
// join!(pricing::load_pricing_with_meta, codex::read_codex_usage_limits), then one spawn_blocking for every
// sync source + assembly. The CLI calls it on its own current_thread runtime.
pub fn fingerprint(ctx: &Ctx) -> String;                   // api.ts statsFingerprint: "<count>:<newestMtime>"
pub fn models_in(stats: &serde_json::Value) -> Vec<String>; // the list refreshPricingOverride derives
pub fn run_cli(args: &[String]) -> std::process::ExitCode;  // `atlas stats [--source claude|codex|opencode|pricing]`
```

The scaffold writes `run_cli` completely: without `--source` it prints `build()`; with it, it prints that module's `source_json`. Budget (`loadBudgetConfig`), data health, insights, project costs (`project-cost.ts`), and daily activity (`daily-activity.ts`) are private to `stats.rs`.

## `server.rs`, `live.rs`, `statusline.rs`, `push_usage.rs`

```rust
// server.rs
pub fn run(args: &[String]) -> std::process::ExitCode;     // `atlas serve`
// live.rs
#[derive(Serialize)] pub struct LiveSession { /* live-sessions.ts LiveSession */ }
pub fn live_sessions(ctx: &Ctx) -> Vec<LiveSession>;
pub fn cockpit_daemon_port() -> Option<serde_json::Number>; // any JSON number TS accepts, echoed unchanged
pub fn run_cli(args: &[String]) -> std::process::ExitCode; // `atlas live`
// statusline.rs
pub fn run(args: &[String]) -> std::process::ExitCode;     // `atlas statusline`
// push_usage.rs
pub fn run(args: &[String]) -> std::process::ExitCode;     // `atlas push-usage`
```

## `atlas/mod.rs` dispatch

`pub fn run(args: &[String]) -> ExitCode` matches the first arg: `serve` → `server::run`, `stats` → `stats::run_cli`, `live` → `live::run_cli`, `rollup-update` → `rollup_update::run`, `statusline` → `statusline::run`, `push-usage` → `push_usage::run`; anything else prints `usage: cockpit atlas <serve|stats|live|rollup-update|statusline|push-usage>` to stderr and exits 2.
