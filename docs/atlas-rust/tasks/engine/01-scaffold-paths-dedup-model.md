# ENGINE-01: Atlas scaffold, paths, dedup, and model types

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: none — foundation task
> **Blocks**: engine/02, engine/04, engine/05, engine/06, server/01
> **Status**: done

## Goal

`cockpit atlas <sub>` exists and dispatches; every atlas module exists with the signatures in `engine-api.md` (`todo!()` bodies where a later port fills them); the small shared modules (paths, dedup, jsonl reader, model types, session files) are fully ported; reqwest can do HTTPS; cockpit's static file server serves any root dir.

## Files to create / modify

- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — reqwest gains rustls with bundled webpki roots (feature name for reqwest ~0.12 is expected to be `rustls-tls-webpki-roots`; confirm with context7 before editing); add `indexmap` as a direct dependency with its `serde` feature. One-line justification comment on each.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — add `mod atlas;` and an `Atlas(TrailingArgs)` variant to `Command` whose arm calls `atlas::run(&args.args)`.
- `packages/monitor/cockpit-rs/src/atlas/mod.rs` (new) — `pub mod` for every atlas module; dispatch per `engine-api.md`.
- `packages/monitor/cockpit-rs/src/atlas/paths.rs` (new) — port of `usage-dashboard/scripts/paths.ts` plus `rollup_db_path()` and `codex_cache_path()`.
- `packages/monitor/cockpit-rs/src/atlas/dedup.rs` (new) — port of `usage-dashboard/scripts/dedup.ts`.
- `packages/monitor/cockpit-rs/src/atlas/jsonl.rs` (new) — port of `shared/scripts/jsonl-lines.ts`.
- `packages/monitor/cockpit-rs/src/atlas/model.rs` (new) — `Ctx`, `now_ms`, model-usage types and helpers, `UsageLimits` / `UsageLimitWindow`.
- `packages/monitor/cockpit-rs/src/atlas/session_files.rs` (new) — port of `usage-dashboard/scripts/session-files.ts`.
- `packages/monitor/cockpit-rs/src/atlas/{rollup_db,rollup_update,claude,codex,opencode,pricing,stats,server,live,statusline,push_usage}.rs` (new) — stubs with the exact `engine-api.md` signatures and `todo!()` bodies; `stats::run_cli` written completely.
- `packages/monitor/cockpit-rs/src/server/static_files.rs` (modify) — extract a root-taking `serve_dir`; cockpit's handler calls it.

## Implementation notes

### Dispatch (`atlas/mod.rs`)

```rust
pub fn run(args: &[String]) -> std::process::ExitCode
```

First arg: `serve` → `server::run`, `stats` → `stats::run_cli`, `live` → `live::run_cli`, `rollup-update` → `rollup_update::run`, `statusline` → `statusline::run`, `push-usage` → `push_usage::run`, each receiving the remaining args. Anything else (including no arg) prints `usage: cockpit atlas <serve|stats|live|rollup-update|statusline|push-usage>` to stderr and exits 2.

`main.rs` uses clap with `TrailingArgs { #[arg(trailing_var_arg = true, allow_hyphen_values = true)] args: Vec<String> }` for every subcommand; follow that pattern so `cockpit atlas stats --source codex` reaches `atlas::run` intact.

### `stats::run_cli` (complete, not a stub)

- No args → build a `current_thread` runtime (`tokio::runtime::Builder::new_current_thread().enable_all().build()`), `Ctx::from_env()`, `block_on(stats::build(&ctx))`, print the JSON to stdout, exit 0. `build` itself stays `todo!()` here.
- `--source claude` → `claude::source_json(&ctx, &claude::load(&ctx)?)`; `--source codex` → `codex::source_json(&codex::load(&ctx)?, &codex::read_codex_usage_limits(&ctx).await)`, which returns the whole `{usage, usageLimits}` object; `--source opencode` → `opencode::source_json(&opencode::load(&ctx)?)`; `--source pricing` → `pricing::source_json(&pricing::load_pricing_with_meta(&ctx).await?)`. Where the shape in `contracts.md` §4 is `{usage, ...}`, `run_cli` does the wrapping only if the module's `source_json` does not; pick one owner and write a one-line comment saying which (recommended: each module's `source_json` returns the full `--source` shape; for codex, `source_json` takes the limits as a second argument — if so, update `engine-api.md` in the same change).
- `--source <unknown>` or `--source` with no value → stderr `usage: cockpit atlas stats [--source claude|codex|opencode|pricing]`, exit 2, before any module is called.
- A module error prints `atlas: <error>` to stderr and exits 1.

### Stubs

Each stub module carries the exact `engine-api.md` signature, `todo!()` bodies, and its structs with at least the fields `engine-api.md` names (`ClaudeSource`, `CodexSource`, `OpenCodeSource`, `PricingLoad`, `PricingTable`, `ModelPrice`, `PricingMeta`, `PricingRefreshResult`, `UpdateResult`, `UpdateOptions`, `LiveSession`, `StatsCache`, `History`). Add `#[allow(dead_code)]` only at module level on stubs, with a one-line comment that the port removes it. `rollup_db.rs` also carries `pub const SCHEMA_VERSION: i64 = 3;`.

### `model.rs`

```rust
pub fn now_ms() -> i64; // TOKEN_ATLAS_NOW_MS when it parses as a positive integer, else SystemTime
pub struct Ctx { pub now_ms: i64, pub plugin_root: std::path::PathBuf }
impl Ctx { pub fn from_env() -> anyhow::Result<Ctx>; } // plugin_root = crate::paths::plugin_root()
```

Plus `ModelUsage`, `TranscriptUsage`, `HourlyUsageBucket`, `InternalLedgerRow`, `ProviderUsage`, `Provider`, `UsageLimits`, `UsageLimitWindow`, and the helpers `model_key`, `provider_from_model_key`, `raw_model_from_key`, `empty_model_usage`, `add_usage`, `add_model_usage`, `model_usage_total`, `fmt_date`. Mirror the TS types in `usage-dashboard/scripts/api.ts` field for field (`ModelUsage` ~line 198, `TranscriptUsage` ~365, `HourlyUsageBucket` ~240, `LedgerRow`/`InternalLedgerRow` ~210–229, `UsageLimitWindow`/`UsageLimits` ~133–151) with `#[serde(rename_all = "camelCase")]` and `skip_serializing_if` where TS omits. `Provider` serializes lowercase. `fmt_date` is local time, as `fmtDate` (~2377). `provider_from_model_key` and `raw_model_from_key` follow `providerFromModelKey` / `rawModelFromKey` (~1291–1300), including a key with no `provider:` prefix.

Also port these shared helpers into `model.rs`, because the Claude, Codex, and OpenCode sources all need them and run in parallel: `add_hourly_usage` (api.ts `addHourlyUsage`), `add_nested_model_usage` (`addNestedModelUsage`), `project_name` (`projectName`), `display_path` (`displayPath`, home prefix → `~`), `coerce_number`, and `build_usage_limit_window`. Port every `api.test.ts` case for `coerceNumber` and `buildUsageLimitWindow` as cargo tests. Their exact semantics:

- **`coerceNumber`**:
  - A finite number stays as is. A non-finite number, null, or a non-string gives `None`.
  - A string is trimmed and parsed as JS `Number()` does. Pin the edge cases: an empty or whitespace-only string gives `0` (JS `Number("") === 0`), `"nope"` gives `None`, and `"Infinity"` gives `None` because it is not finite.
- **`buildUsageLimitWindow(bucket, duration_ms, now_ms)`**:
  - No bucket gives `None`.
  - `usedPercent = coerce(used_percentage)`.
  - When `resets_at` does not coerce, return `{usedPercent, resetAt: null, elapsedPercent: null, remainingMs: null, durationMs}`.
  - Otherwise compute:
    - `resetAtMs = resets_at * 1000`.
    - `resetAt` is the ISO-8601 UTC string with milliseconds, like JS `toISOString()` (`2026-10-01T12:00:00.000Z`).
    - `elapsedMs = clamp(now - (resetAtMs - duration), 0, duration)`.
    - `remainingMs = duration - elapsedMs`.
    - `elapsedPercent = elapsedMs / duration * 100` as f64.

### `dedup.rs`

Port `dedup.ts` exports: `walk_files` (same recursion, same extension filter, same order as `walkFiles`; unreadable dirs skipped silently), `DedupEntry`, `DedupUsage`, `dedup_key` (`requestId:messageId`; returns `None` exactly when TS returns null), `usage_token_total`, `count_claude_tool_calls`, `BilledTokens`, `add_billed_tokens`, `hour_start_ms`.

`hour_start_ms(ts_ms)` is the **local** hour start in epoch ms, matching `hourStartMs` (`new Date(ts); setMinutes(0,0,0)`). Use jiff with the system time zone (`jiff::tz::TimeZone::system()`, which honors `TZ`). Across a DST transition, match what JS does for that instant — write the cargo test first against values computed by `TZ=America/New_York bun -e 'import {hourStartMs} from "./packages/monitor/skills/usage-dashboard/scripts/dedup.ts"; console.log(hourStartMs(<ms>))'` and paste the numbers into the test.

### `jsonl.rs`

Port `readJsonlLines` from `shared/scripts/jsonl-lines.ts`: read from a start byte offset, never split a UTF-8 sequence, and report the byte offset after the last complete newline (`LineCursor.bytesConsumed`). Keep the `emit_partial` option with the TS default **true**: a final line without a trailing newline is still yielded (Claude history and Codex rollouts rely on it); the rollup ingest alone passes `false`, so its partial tail is re-read next run. Test both modes on a file whose last record has no newline. Port the other `JsonlLinesOptions` fields callers use. Port every case from `shared/scripts/jsonl-lines.test.ts` as a cargo test.

### `paths.rs`

All paths from `paths.ts`, derived from `$HOME` (not `dirs`), plus: `projects_dir()` honors `TOKEN_ATLAS_PROJECTS_DIR`; `rollup_db_path()` honors `TOKEN_ATLAS_ROLLUP_DB`, else `$XDG_DATA_HOME/q-lab/token-atlas/rollup.db` (`XDG_DATA_HOME` fallback `~/.local/share`); `codex_cache_path()` is `$XDG_DATA_HOME/q-lab/token-atlas/codex-sessions.db` regardless of `TOKEN_ATLAS_ROLLUP_DB`. OpenCode paths come from `crate::paths::opencode_db()` (its dirname + `storage`, + `project`). Do not use cockpit's `claude_projects_dir`/`codex_dir`/`codex_state_db` — they honor `COCKPIT_*` vars the dashboard never read. Resolve lazily (functions, not statics) so tests can set env.

### `session_files.rs`

`read_session_files() -> Vec<ClaudeSessionFile>` porting `readSessionFiles` (reads `~/.claude/sessions/*.json`, skips unreadable/corrupt files silently). Mirror `ClaudeSessionFile` field for field.

### `server/static_files.rs`

Extract:

```rust
pub async fn serve_dir(root: &Path, uri: &Uri, headers: &HeaderMap) -> Response
```

containing today's body of `serve` (path confinement, MIME, gzip set, base36 ETag with `-gz`, 304). The existing `serve(State(state), uri, headers)` computes `state.plugin_root.join("skills/cockpit/dashboard/dist")` and calls `serve_dir`. Cockpit behavior must not change; its existing unit tests in that file keep passing.

### Cross-build

rustls pulls `ring` (C/asm). CI (`.github/workflows/cockpit-release.yml`) builds `aarch64-apple-darwin`, `x86_64-apple-darwin`, and the two linux-musl targets via `cargo zigbuild` only on a `monitor-v*` tag. If `cargo zigbuild` is installed locally, run `cargo zigbuild --release --target x86_64-unknown-linux-musl --manifest-path packages/monitor/cockpit-rs/Cargo.toml`. If not, run `cargo check --target aarch64-apple-darwin` and state in the task report that the musl build is untested until CI runs.

### Cargo tests (next to the code)

- `hour_start_ms` under `TZ=Asia/Taipei` and `TZ=America/New_York` across a DST transition (values from bun as above). Tests that set `TZ`/env must serialize (a `static Mutex` guard, as `cockpit-rs/src/paths.rs` tests do).
- `dedup_key` present/missing ids; `usage_token_total`; `count_claude_tool_calls` on mixed content.
- `jsonl` cases ported from `jsonl-lines.test.ts`, including a partial last line and a multibyte character straddling the read boundary.
- `model_key` / `provider_from_model_key` / `raw_model_from_key` round-trip.
- `now_ms` with `TOKEN_ATLAS_NOW_MS=1700000000000`, `0`, `-5`, `abc` (only the first pins the clock).
- `paths` env fallbacks for `TOKEN_ATLAS_ROLLUP_DB` and `XDG_DATA_HOME`.

## Acceptance criteria

- [x] `cargo build --release` succeeds with reqwest's rustls feature and `indexmap` enabled; both dependencies carry a justification comment in `Cargo.toml`.
- [x] `cockpit atlas bogus` and bare `cockpit atlas` print the usage line to stderr and exit 2.
- [x] `cockpit atlas stats --source nope` exits 2 with the stats usage line and without calling any stub (no panic output).
- [x] Every module listed in `engine-api.md` exists with its exact public signature; `paths`, `dedup`, `jsonl`, `model`, `session_files` are fully implemented (no `todo!()`).
- [x] The cargo tests listed above exist and pass, including the DST case and the jsonl multibyte boundary case.
- [x] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` are clean.
- [x] Cockpit's contract suite is green against the rebuilt binary after the `serve_dir` extraction.
- [x] The musl cross-build either succeeds locally or is reported as untested with the `cargo check --target aarch64-apple-darwin` result.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `packages/monitor/cockpit-rs/target/release/cockpit atlas bogus; test $? -eq 2`
- [x] `packages/monitor/cockpit-rs/target/release/cockpit atlas stats --source nope; test $? -eq 2`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Build fails, dispatch missing, or `serve_dir` changes cockpit behavior | Dispatch works but `hour_start_ms` is UTC or wrong across DST, or jsonl splits UTF-8, or a signature drifts from `engine-api.md` | Signatures exactly match `engine-api.md`; local-hour, jsonl cursor, dedup, and path fallbacks match the TS; cockpit suite green |
| Test coverage | ×2 | No cargo tests | Happy paths only; no DST or multibyte boundary case | DST, multibyte boundary, partial line, env-seam, and path-fallback cases, with TS-derived expected values |
| Interface & readability | ×1 | A bare or bogus `atlas` subcommand, or an illegal `--source`, reaches a stub or panics; or modules are merged (a `todo!()` panic from a real but not-yet-ported subcommand is expected at this stage) | Usable, but helpers duplicated from cockpit modules or env read in statics | One module per TS module; cockpit helpers reused per `shared.md`; lazily resolved paths |
| Assumptions & docs | ×1 | New deps with no justification | Justified deps, but the rustls feature name or musl status is unverified and unreported | Feature name confirmed via context7; musl build status stated; stub-only `allow(dead_code)` commented |

## Out of scope

- Any engine logic beyond paths, dedup, jsonl, model types, and session files — Deferred. Reason: each data-source module is ported separately against its own golden slice.
- `atlas serve`, `/api/live`, `atlas statusline`, `atlas push-usage` behavior — Deferred. Reason: this task only makes them dispatchable stubs.
- Any change to the TS — Deferred. Reason: the TS stays authoritative until the final deletion.
