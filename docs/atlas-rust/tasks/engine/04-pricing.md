# ENGINE-04: Pricing load, resolution, and override refresh

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/01, contract/03
> **Blocks**: engine/08
> **Status**: done

## Goal

`packages/monitor/cockpit-rs/src/atlas/pricing.rs` resolves every model's price exactly as the TS dashboard does — bundled defaults, then OpenRouter live, then the user override — and refreshes the override file on demand, so `atlas stats --source pricing` matches the recorded TS golden.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/pricing.rs` (modify) — replace the `todo!()` stubs with the port of the `api.ts` pricing section (authoritative source while it exists: `packages/monitor/skills/usage-dashboard/scripts/api.ts`, `// ---------- Pricing ----------`, roughly lines 846–1190, and the types at lines 76–111).

No other file. `Cargo.toml` already carries reqwest with rustls; `model.rs` already provides `raw_model_from_key`, `ModelUsage`, `Ctx`.

## Implementation notes

### Types (mirror TS field for field, `#[serde(rename_all = "camelCase")]`)

```rust
pub struct ModelPrice { pub input: f64, pub output: f64, pub cache_read: Option<f64>, pub cache_write: Option<f64> }
pub struct PricingTable { pub models: IndexMap<String, ModelPrice>, pub fallback: ModelPrice, pub external_model_prefixes: Vec<String> }
pub struct PricingMeta {
    pub defaults_loaded: bool,
    pub open_router: OpenRouterMeta,     // { attempted: bool, used: bool, error: Option<String> } — error serializes as null, never omitted
    pub user_override: UserOverrideMeta, // { path: String, loaded: bool, error: Option<String> } — same
    pub models: PricedCounts,            // { priced, default, fallback: usize, fallbackModels: Vec<String> }
}
pub struct PricingLoad { pub table: PricingTable, pub meta: PricingMeta, pub source_by_model: IndexMap<String, PricingSource> }
pub enum PricingSource { Default, Live, Override }   // serializes "default" | "live" | "override"
pub struct PricingRefreshResult { pub ok: bool, pub override_path: String, pub open_router_error: Option<String>,
    pub resolved: Vec<ResolvedModel /* { model, key } */>, pub unresolved: Vec<String>, pub written_count: usize }
```

- `cache_read` / `cache_write` are `Option<f64>`: some defaults and override entries omit them, and `calcCost` tests `Number.isFinite`, so absence must be representable. Serialize with `skip_serializing_if = "Option::is_none"` so a missing field stays missing when the override file is rewritten.
- `source_by_model` is an added `pub` field on `PricingLoad` (engine-api allows adding fields to your own struct). TS carries it and `pricing_meta_for_models` needs it.
- Unknown keys in `pricing-defaults.json` (`_comment`, `_source`) are ignored on read.

### Loading (`load_pricing_with_meta(ctx) -> anyhow::Result<PricingLoad>`)

1. Read `<ctx.plugin_root>/skills/usage-dashboard/references/pricing-defaults.json`. Missing or unparseable → TS throws `Missing pricing defaults: <path>`. Return `Err` with that exact message — never `expect`: the release profile is `panic = "abort"`, so a panic would kill `atlas serve` instead of answering 500. A failed load is not cached. Add cargo tests for missing and corrupt defaults.
2. Seed `source_by_model` with `Default` for every defaults key. Meta starts `defaultsLoaded: true`, `openRouter: {attempted: true, used: false, error: null}`, `userOverride: {path: <override path with the first occurrence of HOME replaced by "~">, loaded: false, error: null}`, `models: {priced: 0, default: 0, fallback: 0, fallbackModels: []}`.
3. OpenRouter fetch, 3 s timeout, URL from `TOKEN_ATLAS_OPENROUTER_URL` (fallback `https://openrouter.ai/api/v1/models`). Parse `data[]`: skip entries without both `pricing.prompt` and `pricing.completion`; `input = parse(prompt) * 1_000_000`, `output = parse(completion) * 1_000_000`, `cacheRead = input_cache_read ? parse * 1e6 : input * 0.1`, `cacheWrite = input_cache_write ? parse * 1e6 : input * 1.25`; keep only when input and output are finite. Parse strings the way `parseFloat` does for these decimal strings (`str::parse::<f64>` on the trimmed value; a non-numeric string → NaN → skipped). Non-2xx → `error = "HTTP <status>"`. Transport failure or timeout → `error` = the JS error name TS would record: a timeout is `"TimeoutError"` (from `AbortSignal.timeout`), any other failure `"TypeError"` (Bun's fetch network error name). Each live model overwrites the table entry, sets source `Live`, and sets `openRouter.used = true`.
4. User override `~/.config/cc-dashboard/pricing.json`: absent → `loaded: false, error: null`; unreadable/corrupt → `loaded: false, error: <message>`; present and valid → `loaded: true`, every `models` entry overwrites the table and sets source `Override`. The error message text will differ from Bun's `JSON.parse` message; say so in a one-line comment (the golden fixture's override is valid, so no golden key depends on it).
5. Cache the result process-wide (`OnceLock<Mutex<Option<PricingLoad>>>` or equivalent; clone out on read). `clear_pricing_cache()` empties it. Concurrent first calls may each fetch once — TS shared the in-flight promise; mark this as a deliberate corner-cut in one comment only if you do not share it.

### Resolution

- `pricing_model_aliases(model, table) -> Vec<String>`: `raw = raw_model_from_key(model)`; ordered, de-duplicated `[raw, "openai/"+raw, prefix+raw for each externalModelPrefixes]` (insertion order, first occurrence wins — TS uses a `Set`).
- `normalize_model_id(id)`: lowercase; keep text after the last `/`; cut at the first `:`; strip a trailing `-\d{8}`; remove every `.`, `_`, `-`.
- Normalized index: normalized key → table key, built over `table.models` in insertion order, skipping empty normalized keys; a later key replaces an earlier one only when the earlier contains `:` and the later does not. Memoize per table if cheap; rebuilding per call is acceptable (note the ceiling in a comment).
- `resolve_model_key(model, table)`: first alias present in `table.models`; else normalized hit on `normalize_model_id(raw)`; else none.
- `price_for(model, table)`: resolved entry, else `table.fallback`.
- `pricing_meta_for_models(load, models)`: count per model — source of its resolved key via `source_by_model`, `"fallback"` when unresolved or unmapped; returns a clone of `load.meta` with `models = {priced, default, fallback: fallbackModels.len(), fallbackModels}` (fallbackModels in input order). Return it as `serde_json::Value` per engine-api, or as `PricingMeta` if you also update the engine-api signature — do not diverge silently.

### `calc_cost(usage: &ModelUsage, model: &str, table: &PricingTable) -> f64`

Same operation order as TS so the f64 results match bit for bit:

- `has_cache_pricing = cache_read.is_some_and(finite) || cache_write.is_some_and(finite)`.
- With cache pricing: `read_rate = cache_read if finite else input`, `write_rate = cache_write if finite else input`; `(in*p.input)/1e6 + (out*p.output)/1e6 + (cacheRead*read_rate)/1e6 + (cacheCreation*write_rate)/1e6`, summed left to right.
- Without: `input_tokens = in + cacheRead + cacheCreation`; `(input_tokens*p.input)/1e6 + (out*p.output)/1e6`.
- Token counts are `i64`; convert with `as f64` at the multiplication, as JS does.

### Refresh (`refresh_pricing_override(ctx, models: Vec<String>) -> anyhow::Result<PricingRefreshResult>`)

- Defaults unreadable → `Err("Missing pricing defaults: <path>")`.
- Keys = `models` with empty strings dropped. The caller supplies a non-empty list; deriving one from a stats build is the server handler's job.
- Fetch OpenRouter with a **10 s** timeout; build a throwaway table `{models: live, fallback: defaults.fallback, externalModelPrefixes: defaults.externalModelPrefixes}`.
- Existing override unreadable → `Err("Override unreadable: <message>")`. Otherwise start from its `models` (preserving every existing entry and its order).
- For each key: `raw = raw_model_from_key(key)`; skip a `raw` already seen; `resolve_model_key(key, live_table)` hit → `models[raw] = live[hit]`, push `{model: key, key: raw}` to resolved; miss → push `key` to unresolved.
- `mkdir -p` the override dir, write `serde_json::to_string_pretty(&{"models": models})` + `"\n"` (2-space indent, the exact `JSON.stringify(v, null, 2)` form), then `clear_pricing_cache()`.
- Return `{ok: true, overridePath: <path with HOME → "~">, openRouterError: live.error, resolved, unresolved, writtenCount: resolved.len()}`.

### `source_json(load) -> serde_json::Value`

Serializes `PricingLoad` as TS's `loadPricingWithMeta()` result: `{table, meta, sourceByModel}`. This is what `atlas stats --source pricing` prints; the golden `source pricing` test compares it deep-equal.

### Tests (`#[cfg(test)] mod tests` in `pricing.rs`)

Port every pricing case from `packages/monitor/skills/usage-dashboard/scripts/api.test.ts` (`describe("pricing lookup")`, `describe("normalizeModelId")`, `describe("priceFor normalized fallback")`, `describe("calcCost")`), including:

- `pricing_model_aliases("codex:o3", table)` yields raw, `openai/` and each prefixed variant.
- `normalize_model_id`: `anthropic/claude-opus-4.8` and `claude-opus-4-8` → `claudeopus48`; `MiniMax-M3` and `minimax/minimax-m3` → `minimaxm3`; `claude-opus-4-5-20251101` → `claudeopus45`; `moonshotai/kimi-k2.6-20260420` → `kimik26`; `openai/gpt-oss-120b:free` and `openai/gpt-oss-120b` → `gptoss120b`.
- Normalized fallback prefers an untagged key over a `:free` variant, and an unknown model gets `table.fallback`.
- `calc_cost` with distinct cache pricing and with no cache pricing (cache folded into input), against hand-computed values.
- Override merge: in a temp `HOME` (set via the crate's existing test env guard in `paths.rs`, or pass paths explicitly), an existing override holding an unrelated model survives a refresh that adds a resolved one; the written file ends with `\n` and is 2-space indented; a corrupt existing override returns `Err` starting `Override unreadable:`. Point `TOKEN_ATLAS_OPENROUTER_URL` at a local `tokio` listener or `axum` test server returning a canned body.

## Acceptance criteria

- [x] `atlas stats --source pricing` under the fixture home deep-equals the recorded TS golden (golden test `source pricing` passes against Rust).
- [x] Resolution order is defaults → OpenRouter live → user override; each entry's `sourceByModel` value matches that order, and a failed live fetch leaves the defaults in place with `meta.openRouter.error` set.
- [x] `calc_cost` returns bit-identical f64 values to the TS formula for both the cache-priced and cache-folded branches (cargo tests).
- [x] Every pricing case from `api.test.ts` has a passing cargo test counterpart.
- [x] `refresh_pricing_override` preserves existing override entries, writes 2-space JSON with a trailing newline, clears the cache, and returns `PricingRefreshResult` with `writtenCount == resolved.len()` (cargo test with a temp HOME and a local stub).
- [x] Load uses a 3 s timeout and refresh a 10 s timeout; the URL honors `TOKEN_ATLAS_OPENROUTER_URL`.
- [x] No `unwrap()` on network or file data; `cargo clippy -D warnings` and `cargo fmt --check` are clean.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts -t "source pricing"`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::pricing`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | `source pricing` golden fails, or resolution order / override precedence is wrong | golden passes but an edge drifts: `:free` shadowing, alias order, missing `cacheRead` handling, or refresh drops existing override entries | golden passes; alias, normalized-fallback, cost-branch, and refresh-merge behavior all match TS |
| Test coverage | ×2 | no cargo tests | only happy-path lookup and cost | every `api.test.ts` pricing case ported, plus refresh merge, corrupt override, and live-fetch failure cases |
| Interface & readability | ×1 | engine-api signatures changed without updating `engine-api.md`, or `unwrap` on fetched/parsed data | signatures kept but helpers duplicated or types loose (`Value` where a struct fits) | signatures as frozen, structs mirror TS types, one resolver shared by `price_for`, meta, and refresh |
| Assumptions & docs | ×1 | silent differences from TS | differences present but uncommented | one-line comments on JSON error-text drift, JS error-name mapping, and any cache-sharing corner-cut with its ceiling |

## Out of scope

- Deriving the model list when a refresh request carries none — Deferred. Reason: that needs a full stats build, and pricing must not depend on the stats module; the server handler does it.
- Budget config (`budget.json`) — Deferred. Reason: it belongs to stats assembly, not pricing.
- Applying prices to usage across providers (`byModel` costs) — Deferred. Reason: stats assembly calls `calc_cost`; this module only provides it.
