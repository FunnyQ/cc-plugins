# ENGINE-08: Stats assembly and fingerprint

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/03, engine/04, engine/05, engine/06, engine/07
> **Blocks**: server/02
> **Status**: done
> **Models**: dev=opus/high, judge=opus/high

## Goal

`cockpit atlas stats` prints a `/api/stats` payload that deep-equals the TS golden payload on the fixture home, and `stats::fingerprint` changes exactly when any file the TS fingerprint watches changes.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/stats.rs` (modify stub) — `build`, `fingerprint`, `models_in`, and every private assembly helper; `run_cli` already exists and stays as written unless it needs a fix.
- `packages/monitor/cockpit-rs/src/atlas/model.rs` (modify, only if needed) — add a shared type that a provider source already returns but the scaffold omitted. Additive only; never rename or remove.

## Implementation notes

The TS source is authoritative: `packages/monitor/skills/usage-dashboard/scripts/api.ts` `buildStats()` (~lines 2542–3055) plus its private helpers, `project-cost.ts` (`aggregateProjectCosts`), and `daily-activity.ts` (`mergeDailyActivity`). Read them and port what they do, in the same operation order so f64 rounding matches.

### Signatures (from `engine-api.md`, do not change)

```rust
pub async fn build(ctx: &Ctx) -> anyhow::Result<serde_json::Value>;
pub fn fingerprint(ctx: &Ctx) -> String;
pub fn models_in(stats: &serde_json::Value) -> Vec<String>;
pub fn run_cli(args: &[String]) -> std::process::ExitCode;
```

### `build` shape

1. `tokio::join!(pricing::load_pricing_with_meta(ctx), codex::read_codex_usage_limits(ctx))`, as TS `Promise.all([loadPricingWithMeta(), readCodexUsageLimits()])`; a pricing `Err` propagates out of `build` (the server turns it into a 500).
   Inside the blocking task, honor the `TOKEN_ATLAS_TEST_BUILD_BARRIER` seam from contracts.md §1 first: when set, write `<path>.entered`, then poll every 20 ms until `<path>` exists. It proves in the HTTP contract that a build in progress never blocks `/api/live`.
2. One `tokio::task::spawn_blocking` that does everything else synchronously: stats-cache and history (from `claude::load`), `session_files::read_session_files()`, budget, `claude::read_usage_limits`, the three provider sources (`claude::load`, `codex::load`, `opencode::load`), data health, and assembly. Never call a parse function on the runtime thread; that is what stalled the TS server.
3. Return the `serde_json::Value` built with `preserve_order` so key order matches.

### What to port (private to `stats.rs`)

- `sourceHealth`, `buildDataHealth` — status per source ∈ `ok | missing | unreadable | empty`; counts come from the provider sources (`transcriptFileCount`, `codexSessionFileCount`, `codexThreadRowCount`, `openCodeSessionFileCount`, `openCodeMessageFileCount`, `openCodeSessionRowCount`, `openCodeMessageRowCount`).
- `loadBudgetConfig` — reads `~/.config/cc-dashboard/budget.json`; missing or corrupt file gives the TS default `BudgetMeta`.
- `serializeLedgerRows`, `serializeUsageByModel`, `serializeHourlyUsage`, `serializeProjectModelUsage`, `usageCost`.
- `aggregateProjectCosts` (`project-cost.ts`), `mergeDailyActivity` (`daily-activity.ts`).
- The `insights` block, `meta` block, and everything between.

### Behavior to pin

- **Top-level key order**: `period`, `summary` (with `providers.{claude,codex,opencode}`), `byModel`, `pricingMeta`, `budget`, `usageLimits`, `codexUsageLimits`, `dataHealth`, `daily`, `ledger`, `hourlyUsage`, `activityDays`, `hourlyDistribution`, `weekHourMatrix`, `dailyHourCounts`, `projects`, `sessions`, `insights`, `meta`.
- **Model keys** are namespaced with `model::model_key`. Claude model usage comes from the rollup-derived `ClaudeSource.usage.model_usage`; when that map is empty, fall back to `stats_cache.modelUsage` (TS: `Object.keys(transcriptUsage.modelUsage).length > 0 ? … : cache.modelUsage ?? {}`). Codex and OpenCode keys are already namespaced by their sources and are inserted after Claude's, in that order.
- **Daily merge**: stats-cache `dailyActivity` wins for every date it covers; history only supplements dates after the last cached date (`mergeDailyActivity(dailyActivity, dailyHistory, lastCachedActivityDate)`, where the last date is the max by string compare).
- **Cost** per model via `pricing::calc_cost` against the loaded table; prices are USD per 1M tokens.
- **insights**: `mostActiveDay`, `mostActiveDayMessages`, `mostUsedModel`, `averageMessagesPerSession` rounded as `Math.round(x * 10) / 10` (positive values only, so `f64::round` matches JS), `mostActiveProject`, `firstSessionDate`, `longestSession`; `null` where TS uses `?? null`.
- **meta**: `generatedAt` is an ISO-8601 UTC string with milliseconds (`2026-10-01T12:00:00.000Z`) built from `model::now_ms()`, not the system clock; `cacheVersion`, `lastComputedDate` from stats-cache or `null`.
- **Clock**: every "now" goes through `ctx.now_ms` / `model::now_ms()`.

### `fingerprint`

Port `statsFingerprint()` exactly: return `"<count>:<newest>"` where each existing path increments `count` and raises `newest` to its mtime in ms; a missing path counts nothing. Watch exactly this list (a missing entry means a stale 304 after that source changes):

- Every `.jsonl` under the Claude projects dir (`TOKEN_ATLAS_PROJECTS_DIR`, fallback `~/.claude/projects`), via `dedup::walk_files`.
- Every `.jsonl` under `~/.codex/sessions`.
- For each OpenCode storage root (TS `openCodeStorageRoots()`: `<dirname(opencode db)>/storage` plus each `<dirname(opencode db)>/project/*/storage`), every `.json` under `<root>/session` and `<root>/message`.
- `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.codex/state_5.sqlite`, `~/.codex/auth.json`, the OpenCode DB, `~/.cache/token-atlas/rate-limits.json`, `~/.cache/token-atlas/codex-usage-limits.json`, `~/.config/cc-dashboard/pricing.json`, `~/.config/cc-dashboard/budget.json`.

The string only has to be stable within one Rust process; it does not need to equal the TS string (the per-process boot id already makes ETags differ).

### `models_in`

Return the model list `refreshPricingOverride` derives from a built payload when the request names none (read `refreshPricingOverride` in `api.ts` ~1089 for which payload field it takes and in which order).

### CLI

`atlas stats` prints the payload as `JSON.stringify(data, null, 2)` does (2-space indent, no trailing newline). On error, print the message to stderr and exit 1.

### Timing

Time `atlas stats` for Rust and TS on the fixture home (`hyperfine` or three `time` runs each) and put both numbers in the task's final report. The hard latency gate belongs to the release measurement, not this task.

## Acceptance criteria

- [x] `atlas stats` against Rust passes every golden `stats key <k>` test (all 19 top-level keys).
- [x] The whole `golden.contract.test.ts` file passes against Rust and still passes against TS.
- [x] `build` runs every synchronous source parse and the assembly inside one `spawn_blocking`; only the pricing load and Codex limits run on the runtime.
- [x] `fingerprint` watches exactly the listed trees and files; a cargo test proves touching `budget.json`, adding a transcript, and deleting `rate-limits.json` each change the string, and an unrelated file does not.
- [x] Cargo unit tests port the `api.test.ts`, `project-cost.test.ts`, and `daily-activity.test.ts` cases that cover code in this module (project cost aggregation, daily merge precedence, data-health statuses, Claude stats-cache fallback).
- [x] `meta.generatedAt` and every other clock-derived value follow `TOKEN_ATLAS_NOW_MS`.
- [x] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` are clean.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "stats key"`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts`
- [x] `bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::stats`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Golden `stats key` tests fail on several keys, or key order / Claude fallback / daily merge precedence is wrong | Most keys match; a cost rounding, insights, or data-health status drifts, or the fingerprint misses a watched file | Every golden test passes both ways; fingerprint list identical to TS; clock-derived values follow `TOKEN_ATLAS_NOW_MS` |
| Test coverage | ×2 | No cargo tests | Happy-path assembly only | Ported TS unit cases plus fingerprint change/no-change tests and the stats-cache fallback |
| Interface & readability | ×1 | Signatures differ from `engine-api.md`, or parsing runs on the runtime thread | Correct but one giant function with no helpers, or dead helpers | Mirrors `buildStats` helper boundaries; one `spawn_blocking`; clippy clean |
| Assumptions & docs | ×1 | Silent deviations from TS | Deviations present but uncommented | Each deliberate difference (e.g. fingerprint string format) carries a one-line why; timing numbers reported |

## Out of scope

- ETag, 304, gzip, and in-flight build sharing — Deferred. Reason: the `atlas serve` HTTP layer owns caching; this module only returns the payload and the fingerprint.
- Pricing refresh and override writes — Deferred. Reason: the pricing module owns them; this module only exposes `models_in` for the server handler.
- Provider parsing (Claude rollup readers, Codex, OpenCode) — Deferred. Reason: each source module owns its own parsing; this module consumes their `load` results.
