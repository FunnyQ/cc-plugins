// Port of api.ts `// ---------- Pricing ----------`.
// Stats assembly and the refresh route call the rest; the first of them removes this allow.
#![allow(dead_code)]
use super::model::{Ctx, ModelUsage, raw_model_from_key};
use super::paths;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const OPENROUTER_FALLBACK_URL: &str = "https://openrouter.ai/api/v1/models";

// JSON.stringify writes an integral number without ".0" and NaN as null; the override file must match.
fn js_number<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
    if !value.is_finite() {
        s.serialize_none()
    } else if value.fract() == 0.0 && value.abs() < 1e15 {
        s.serialize_i64(*value as i64)
    } else {
        s.serialize_f64(*value)
    }
}

fn js_opt_number<S: Serializer>(value: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => js_number(v, s),
        None => s.serialize_none(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    #[serde(serialize_with = "js_number")]
    pub input: f64,
    #[serde(serialize_with = "js_number")]
    pub output: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js_opt_number"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js_opt_number"
    )]
    pub cache_write: Option<f64>,
    // TS spreads the whole object, so fields like the defaults' fallback `_comment` survive into the payload.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingTable {
    pub models: IndexMap<String, ModelPrice>,
    pub fallback: ModelPrice,
    #[serde(default)]
    pub external_model_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterMeta {
    pub attempted: bool,
    pub used: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOverrideMeta {
    pub path: String,
    pub loaded: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricedCounts {
    pub priced: usize,
    pub default: usize,
    pub fallback: usize,
    pub fallback_models: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingMeta {
    pub defaults_loaded: bool,
    pub open_router: OpenRouterMeta,
    pub user_override: UserOverrideMeta,
    pub models: PricedCounts,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PricingSource {
    Default,
    Live,
    Override,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingLoad {
    pub table: PricingTable,
    pub meta: PricingMeta,
    pub source_by_model: IndexMap<String, PricingSource>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResolvedModel {
    pub model: String,
    pub key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingRefreshResult {
    pub ok: bool,
    pub override_path: String,
    pub open_router_error: Option<String>,
    pub resolved: Vec<ResolvedModel>,
    pub unresolved: Vec<String>,
    pub written_count: usize,
}

#[derive(Deserialize, Serialize, Default)]
struct OverrideFile {
    #[serde(default)]
    models: Option<IndexMap<String, ModelPrice>>,
}

fn defaults_path(ctx: &Ctx) -> PathBuf {
    ctx.plugin_root
        .join("skills/usage-dashboard/references/pricing-defaults.json")
}

fn override_path() -> PathBuf {
    paths::home().join(".config/cc-dashboard/pricing.json")
}

fn tilde(path: &Path) -> String {
    let home = paths::home();
    path.to_string_lossy()
        .replacen(home.to_string_lossy().as_ref(), "~", 1)
}

fn read_defaults(ctx: &Ctx) -> anyhow::Result<PricingTable> {
    let path = defaults_path(ctx);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<PricingTable>(&text).ok())
        .ok_or_else(|| anyhow::anyhow!("Missing pricing defaults: {}", path.display()))
}

// readJSONWithError: Ok(None) when absent. The Err text is serde's, not Bun's JSON.parse message.
fn read_override(path: &Path) -> Result<Option<OverrideFile>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| e.to_string())
}

struct OpenRouterPricing {
    models: IndexMap<String, ModelPrice>,
    error: Option<String>,
}

// parseFloat on OpenRouter's decimal strings; junk becomes NaN as in JS.
fn parse_js_float(value: &str) -> f64 {
    value.trim().parse::<f64>().unwrap_or(f64::NAN)
}

fn non_empty_str(value: Option<&serde_json::Value>) -> Option<&str> {
    value.and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

async fn fetch_open_router_pricing(timeout: Duration) -> OpenRouterPricing {
    let url = std::env::var("TOKEN_ATLAS_OPENROUTER_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| OPENROUTER_FALLBACK_URL.to_string());
    let mut models = IndexMap::new();
    let error = match fetch_json(&url, timeout).await {
        Ok(Ok(json)) => {
            let data = json.get("data").and_then(|d| d.as_array());
            for entry in data.into_iter().flatten() {
                let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let p = entry.get("pricing");
                let field = |name: &str| non_empty_str(p.and_then(|p| p.get(name)));
                let (Some(prompt), Some(completion)) = (field("prompt"), field("completion"))
                else {
                    continue;
                };
                let input = parse_js_float(prompt) * 1_000_000.0;
                let output = parse_js_float(completion) * 1_000_000.0;
                let cache_read = field("input_cache_read")
                    .map_or(input * 0.1, |v| parse_js_float(v) * 1_000_000.0);
                let cache_write = field("input_cache_write")
                    .map_or(input * 1.25, |v| parse_js_float(v) * 1_000_000.0);
                if input.is_finite() && output.is_finite() {
                    models.insert(
                        id.to_string(),
                        ModelPrice {
                            input,
                            output,
                            cache_read: Some(cache_read),
                            cache_write: Some(cache_write),
                            extra: Default::default(),
                        },
                    );
                }
            }
            None
        }
        Ok(Err(status)) => Some(format!("HTTP {status}")),
        Err(name) => Some(name),
    };
    OpenRouterPricing { models, error }
}

// Outer Err is the JS error name TS records: AbortSignal.timeout → "TimeoutError", Bun network/parse failure → "TypeError"/"SyntaxError".
async fn fetch_json(
    url: &str,
    timeout: Duration,
) -> Result<Result<serde_json::Value, u16>, String> {
    let name = |e: reqwest::Error| {
        if e.is_timeout() {
            "TimeoutError".to_string()
        } else if e.is_decode() {
            "SyntaxError".to_string()
        } else {
            "TypeError".to_string()
        }
    };
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(name)?;
    let res = client.get(url).send().await.map_err(name)?;
    if !res.status().is_success() {
        return Ok(Err(res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(name)?;
    serde_json::from_slice(&bytes)
        .map(Ok)
        .map_err(|_| "SyntaxError".to_string())
}

fn cache() -> &'static Mutex<Option<PricingLoad>> {
    static CACHE: OnceLock<Mutex<Option<PricingLoad>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// Concurrent first calls each fetch once; TS shared the in-flight promise. Share it if cold-start fan-out grows.
pub async fn load_pricing_with_meta(ctx: &Ctx) -> anyhow::Result<PricingLoad> {
    if let Some(load) = cache().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Ok(load);
    }
    let load = build_pricing_load(ctx).await?;
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some(load.clone());
    Ok(load)
}

async fn build_pricing_load(ctx: &Ctx) -> anyhow::Result<PricingLoad> {
    let mut table = read_defaults(ctx)?;
    let mut source_by_model: IndexMap<String, PricingSource> = table
        .models
        .keys()
        .map(|k| (k.clone(), PricingSource::Default))
        .collect();
    let override_file = override_path();
    let mut meta = PricingMeta {
        defaults_loaded: true,
        open_router: OpenRouterMeta {
            attempted: true,
            used: false,
            error: None,
        },
        user_override: UserOverrideMeta {
            path: tilde(&override_file),
            loaded: false,
            error: None,
        },
        models: PricedCounts::default(),
    };

    let live = fetch_open_router_pricing(Duration::from_secs(3)).await;
    meta.open_router.error = live.error;
    for (id, price) in live.models {
        source_by_model.insert(id.clone(), PricingSource::Live);
        table.models.insert(id, price);
        meta.open_router.used = true;
    }

    match read_override(&override_file) {
        Ok(None) => {}
        Err(error) => meta.user_override.error = Some(error),
        Ok(Some(file)) => {
            meta.user_override.loaded = true;
            for (k, v) in file.models.into_iter().flatten() {
                source_by_model.insert(k.clone(), PricingSource::Override);
                table.models.insert(k, v);
            }
        }
    }
    Ok(PricingLoad {
        table,
        meta,
        source_by_model,
    })
}

pub fn clear_pricing_cache() {
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub fn pricing_model_aliases(model: &str, table: &PricingTable) -> Vec<String> {
    let raw = raw_model_from_key(model);
    let mut aliases: Vec<String> = Vec::new();
    let candidates = [raw.to_string(), format!("openai/{raw}")]
        .into_iter()
        .chain(
            table
                .external_model_prefixes
                .iter()
                .map(|p| format!("{p}{raw}")),
        );
    for alias in candidates {
        if !aliases.contains(&alias) {
            aliases.push(alias);
        }
    }
    aliases
}

pub fn normalize_model_id(id: &str) -> String {
    let mut s = id.to_lowercase();
    if let Some(slash) = s.rfind('/') {
        s = s[slash + 1..].to_string();
    }
    if let Some(colon) = s.find(':') {
        s.truncate(colon);
    }
    let bytes = s.as_bytes();
    let n = bytes.len();
    if n >= 9 && bytes[n - 9] == b'-' && bytes[n - 8..].iter().all(u8::is_ascii_digit) {
        s.truncate(n - 9);
    }
    s.chars()
        .filter(|c| !matches!(c, '.' | '_' | '-'))
        .collect()
}

// Rebuilt per call (O(table) each); memoize per table if stats assembly shows it in profiles.
fn normalized_model_index(table: &PricingTable) -> HashMap<String, &str> {
    let mut idx: HashMap<String, &str> = HashMap::new();
    for key in table.models.keys() {
        let n = normalize_model_id(key);
        if n.is_empty() {
            continue;
        }
        match idx.get(&n) {
            Some(prev) if !(prev.contains(':') && !key.contains(':')) => {}
            _ => {
                idx.insert(n, key);
            }
        }
    }
    idx
}

fn resolve_model_key(model: &str, table: &PricingTable) -> Option<String> {
    if let Some(key) = pricing_model_aliases(model, table)
        .into_iter()
        .find(|k| table.models.contains_key(k))
    {
        return Some(key);
    }
    let n = normalize_model_id(raw_model_from_key(model));
    if n.is_empty() {
        return None;
    }
    normalized_model_index(table).get(&n).map(|k| k.to_string())
}

pub fn price_for(model: &str, table: &PricingTable) -> ModelPrice {
    resolve_model_key(model, table)
        .and_then(|k| table.models.get(&k).cloned())
        .unwrap_or_else(|| table.fallback.clone())
}

pub fn calc_cost(usage: &ModelUsage, model: &str, table: &PricingTable) -> f64 {
    let p = price_for(model, table);
    let finite = |v: Option<f64>| v.filter(|x| x.is_finite());
    let (read, write) = (finite(p.cache_read), finite(p.cache_write));
    if read.is_some() || write.is_some() {
        let read_rate = read.unwrap_or(p.input);
        let write_rate = write.unwrap_or(p.input);
        (usage.input_tokens as f64 * p.input) / 1_000_000.0
            + (usage.output_tokens as f64 * p.output) / 1_000_000.0
            + (usage.cache_read_input_tokens as f64 * read_rate) / 1_000_000.0
            + (usage.cache_creation_input_tokens as f64 * write_rate) / 1_000_000.0
    } else {
        let input_tokens =
            usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        (input_tokens as f64 * p.input) / 1_000_000.0
            + (usage.output_tokens as f64 * p.output) / 1_000_000.0
    }
}

fn pricing_meta_for(pricing: &PricingLoad, models: &[String]) -> PricingMeta {
    let mut counts = PricedCounts::default();
    for model in models {
        let source = resolve_model_key(model, &pricing.table)
            .and_then(|k| pricing.source_by_model.get(&k).copied());
        match source {
            None => counts.fallback_models.push(model.clone()),
            Some(source) => {
                counts.priced += 1;
                if source == PricingSource::Default {
                    counts.default += 1;
                }
            }
        }
    }
    counts.fallback = counts.fallback_models.len();
    PricingMeta {
        models: counts,
        ..pricing.meta.clone()
    }
}

pub fn pricing_meta_for_models(pricing: &PricingLoad, models: &[String]) -> serde_json::Value {
    serde_json::to_value(pricing_meta_for(pricing, models)).unwrap_or_default()
}

pub async fn refresh_pricing_override(
    ctx: &Ctx,
    models: Vec<String>,
) -> anyhow::Result<PricingRefreshResult> {
    let defaults = read_defaults(ctx)?;
    let keys: Vec<String> = models.into_iter().filter(|k| !k.is_empty()).collect();

    let live = fetch_open_router_pricing(Duration::from_secs(10)).await;
    let live_table = PricingTable {
        models: live.models,
        fallback: defaults.fallback,
        external_model_prefixes: defaults.external_model_prefixes,
    };

    let path = override_path();
    let existing = read_override(&path).map_err(|e| anyhow::anyhow!("Override unreadable: {e}"))?;
    let mut merged = existing.and_then(|f| f.models).unwrap_or_default();

    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();
    let mut seen = HashSet::new();
    for key in keys {
        let raw = raw_model_from_key(&key).to_string();
        if !seen.insert(raw.clone()) {
            continue;
        }
        match resolve_model_key(&key, &live_table).and_then(|k| live_table.models.get(&k)) {
            Some(price) => {
                merged.insert(raw.clone(), price.clone());
                resolved.push(ResolvedModel {
                    model: key,
                    key: raw,
                });
            }
            None => unresolved.push(key),
        }
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(&OverrideFile {
        models: Some(merged),
    })?;
    std::fs::write(&path, format!("{body}\n"))?;
    clear_pricing_cache();

    Ok(PricingRefreshResult {
        ok: true,
        override_path: tilde(&path),
        open_router_error: live.error,
        written_count: resolved.len(),
        resolved,
        unresolved,
    })
}

/// The full `--source pricing` shape (loadPricingWithMeta's value).
pub fn source_json(load: &PricingLoad) -> serde_json::Value {
    serde_json::to_value(load).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    fn price(input: f64, output: f64, read: Option<f64>, write: Option<f64>) -> ModelPrice {
        ModelPrice {
            input,
            output,
            cache_read: read,
            cache_write: write,
            extra: Default::default(),
        }
    }

    fn table() -> PricingTable {
        PricingTable {
            models: IndexMap::from([
                (
                    "claude-opus".to_string(),
                    price(3.0, 15.0, Some(0.3), Some(3.75)),
                ),
                (
                    "openai/o3".to_string(),
                    price(2.0, 4.0, Some(f64::NAN), None),
                ),
            ]),
            fallback: price(1.0, 1.0, None, None),
            external_model_prefixes: vec!["openai/".into(), "minimax/".into()],
        }
    }

    fn norm_table() -> PricingTable {
        PricingTable {
            models: IndexMap::from([
                (
                    "claude-opus-4-8".to_string(),
                    price(5.0, 25.0, Some(0.5), Some(6.0)),
                ),
                (
                    "anthropic/claude-sonnet-4.5".to_string(),
                    price(3.0, 15.0, Some(0.3), Some(3.75)),
                ),
                (
                    "minimax/minimax-m3:free".to_string(),
                    price(0.0, 0.0, Some(0.0), Some(0.0)),
                ),
                (
                    "minimax/minimax-m3".to_string(),
                    price(0.25, 1.0, Some(0.025), Some(0.3)),
                ),
            ]),
            fallback: price(1.0, 1.0, None, None),
            external_model_prefixes: vec!["openai/".into(), "minimax/".into()],
        }
    }

    fn usage(i: i64, o: i64, r: i64, c: i64) -> ModelUsage {
        ModelUsage {
            input_tokens: i,
            output_tokens: o,
            cache_read_input_tokens: r,
            cache_creation_input_tokens: c,
            ..Default::default()
        }
    }

    #[test]
    fn aliases_raw_openai_and_prefixed_deduplicated() {
        assert_eq!(
            pricing_model_aliases("codex:o3", &table()),
            vec!["o3", "openai/o3", "minimax/o3"]
        );
    }

    #[test]
    fn price_for_alias_and_fallback() {
        let t = table();
        assert_eq!(price_for("codex:o3", &t).input, 2.0);
        assert_eq!(price_for("nope", &t), t.fallback);
    }

    #[test]
    fn normalize_model_id_cases() {
        for (id, want) in [
            ("anthropic/claude-opus-4.8", "claudeopus48"),
            ("claude-opus-4-8", "claudeopus48"),
            ("MiniMax-M3", "minimaxm3"),
            ("minimax/minimax-m3", "minimaxm3"),
            ("claude-opus-4-5-20251101", "claudeopus45"),
            ("moonshotai/kimi-k2.6-20260420", "kimik26"),
            ("openai/gpt-oss-120b:free", "gptoss120b"),
            ("openai/gpt-oss-120b", "gptoss120b"),
        ] {
            assert_eq!(normalize_model_id(id), want, "{id}");
        }
    }

    #[test]
    fn normalized_fallback_cases() {
        let t = norm_table();
        assert_eq!(
            price_for("claude:claude-opus-4-8", &t),
            t.models["claude-opus-4-8"]
        );
        assert_eq!(
            price_for("claude:claude-sonnet-4-5-20250929", &t),
            t.models["anthropic/claude-sonnet-4.5"]
        );
        assert_eq!(
            price_for("opencode:MiniMax-M3", &t),
            t.models["minimax/minimax-m3"]
        );
        assert_eq!(price_for("claude:utterly-unknown-xyz", &t), t.fallback);
    }

    #[test]
    fn calc_cost_distinct_cache_pricing() {
        let m = 1_000_000;
        let cost = calc_cost(&usage(m, m, m, m), "claude-opus", &table());
        let want: f64 =
            (1e6 * 3.0) / 1e6 + (1e6 * 15.0) / 1e6 + (1e6 * 0.3) / 1e6 + (1e6 * 3.75) / 1e6;
        assert_eq!(cost.to_bits(), want.to_bits());
        assert!((cost - 22.05).abs() < 1e-5);
    }

    #[test]
    fn calc_cost_folds_cache_without_cache_pricing() {
        let m = 1_000_000;
        let cost = calc_cost(&usage(m, m, m, m), "codex:o3", &table());
        assert_eq!(cost, 10.0);
    }

    #[test]
    fn calc_cost_one_cache_rate_uses_input_for_the_other() {
        let mut t = table();
        t.models
            .insert("half".into(), price(2.0, 4.0, Some(1.0), None));
        let cost = calc_cost(&usage(0, 0, 1_000_000, 1_000_000), "half", &t);
        assert_eq!(cost, 3.0);
    }

    #[test]
    fn meta_counts_sources_and_fallbacks() {
        let load = PricingLoad {
            table: table(),
            meta: PricingMeta {
                defaults_loaded: true,
                open_router: OpenRouterMeta {
                    attempted: true,
                    used: false,
                    error: None,
                },
                user_override: UserOverrideMeta {
                    path: "~/x".into(),
                    loaded: false,
                    error: None,
                },
                models: PricedCounts::default(),
            },
            source_by_model: IndexMap::from([
                ("claude-opus".to_string(), PricingSource::Default),
                ("openai/o3".to_string(), PricingSource::Live),
            ]),
        };
        let v = pricing_meta_for_models(
            &load,
            &["claude-opus".into(), "codex:o3".into(), "zzz".into()],
        );
        assert_eq!(
            v["models"],
            serde_json::json!({"priced": 2, "default": 1, "fallback": 1, "fallbackModels": ["zzz"]})
        );
        assert_eq!(v["openRouter"]["error"], serde_json::Value::Null);
    }

    fn ctx_with_defaults(env: &TestEnv) -> Ctx {
        let root = env.dir.path().join("plugin");
        let refs = root.join("skills/usage-dashboard/references");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(
            refs.join("pricing-defaults.json"),
            r#"{"_comment":"x","models":{"claude-opus-4-7":{"input":5.0,"output":25.0,"cacheRead":0.5,"cacheWrite":6.25}},
               "fallback":{"_comment":"y","input":3.0,"output":15.0},"externalModelPrefixes":["minimax/"]}"#,
        )
        .unwrap();
        Ctx {
            now_ms: 0,
            plugin_root: root,
        }
    }

    // Serves one canned HTTP response per connection until the test ends.
    async fn stub(body: &'static str, status: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let res = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(res.as_bytes()).await;
            }
        });
        format!("http://{addr}/models")
    }

    fn set_url(url: &str) {
        // TestEnv holds the env lock for the test's lifetime.
        unsafe { std::env::set_var("TOKEN_ATLAS_OPENROUTER_URL", url) };
    }

    fn unset_url() {
        unsafe { std::env::remove_var("TOKEN_ATLAS_OPENROUTER_URL") };
    }

    const LIVE: &str = r#"{"data":[
        {"id":"minimax/minimax-m3","pricing":{"prompt":"0.00000025","completion":"0.000001"}},
        {"id":"claude-opus-4-7","pricing":{"prompt":"0.00001","completion":"0.00005","input_cache_read":"0.000001"}},
        {"id":"broken","pricing":{"prompt":"abc","completion":"0.1"}},
        {"id":"noprice"}
    ]}"#;

    #[tokio::test(flavor = "current_thread")]
    async fn load_orders_defaults_live_override() {
        let env = TestEnv::new();
        let ctx = ctx_with_defaults(&env);
        set_url(&stub(LIVE, "200 OK").await);
        let over = env.dir.path().join(".config/cc-dashboard");
        std::fs::create_dir_all(&over).unwrap();
        std::fs::write(
            over.join("pricing.json"),
            r#"{"models":{"minimax/minimax-m3":{"input":9,"output":9}}}"#,
        )
        .unwrap();
        clear_pricing_cache();
        let load = load_pricing_with_meta(&ctx).await.unwrap();
        clear_pricing_cache();
        unset_url();
        assert_eq!(load.source_by_model["claude-opus-4-7"], PricingSource::Live);
        assert_eq!(
            load.source_by_model["minimax/minimax-m3"],
            PricingSource::Override
        );
        assert!(!load.table.models.contains_key("broken"));
        let opus = &load.table.models["claude-opus-4-7"];
        assert_eq!(opus.cache_read, Some(0.000001 * 1e6));
        assert_eq!(opus.cache_write, Some(opus.input * 1.25));
        assert!(load.meta.open_router.used);
        assert!(load.meta.user_override.loaded);
        assert_eq!(
            load.meta.user_override.path,
            "~/.config/cc-dashboard/pricing.json"
        );
        let json = source_json(&load);
        assert_eq!(json["meta"]["openRouter"]["error"], serde_json::Value::Null);
        assert!(json["table"]["fallback"].get("cacheRead").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_live_fetch_keeps_defaults_and_records_error() {
        let env = TestEnv::new();
        let ctx = ctx_with_defaults(&env);
        set_url(&stub("{}", "503 Service Unavailable").await);
        clear_pricing_cache();
        let load = load_pricing_with_meta(&ctx).await.unwrap();
        clear_pricing_cache();
        set_url("http://127.0.0.1:9/");
        let refused = load_pricing_with_meta(&ctx).await.unwrap();
        clear_pricing_cache();
        unset_url();
        assert_eq!(load.meta.open_router.error.as_deref(), Some("HTTP 503"));
        assert!(!load.meta.open_router.used);
        assert_eq!(
            load.source_by_model["claude-opus-4-7"],
            PricingSource::Default
        );
        assert_eq!(load.table.models["claude-opus-4-7"].input, 5.0);
        assert_eq!(refused.meta.open_router.error.as_deref(), Some("TypeError"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn corrupt_override_is_reported_not_fatal() {
        let env = TestEnv::new();
        let ctx = ctx_with_defaults(&env);
        set_url("http://127.0.0.1:9/");
        let over = env.dir.path().join(".config/cc-dashboard");
        std::fs::create_dir_all(&over).unwrap();
        std::fs::write(over.join("pricing.json"), "{nope").unwrap();
        clear_pricing_cache();
        let load = load_pricing_with_meta(&ctx).await.unwrap();
        clear_pricing_cache();
        unset_url();
        assert!(!load.meta.user_override.loaded);
        assert!(load.meta.user_override.error.is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_and_corrupt_defaults_are_errors() {
        let env = TestEnv::new();
        let ctx = Ctx {
            now_ms: 0,
            plugin_root: env.dir.path().join("nowhere"),
        };
        clear_pricing_cache();
        let err = load_pricing_with_meta(&ctx).await.unwrap_err().to_string();
        assert!(err.starts_with("Missing pricing defaults: "), "{err}");
        let ctx = ctx_with_defaults(&env);
        std::fs::write(
            ctx.plugin_root
                .join("skills/usage-dashboard/references/pricing-defaults.json"),
            "{",
        )
        .unwrap();
        let err = load_pricing_with_meta(&ctx).await.unwrap_err().to_string();
        assert!(err.starts_with("Missing pricing defaults: "), "{err}");
        let err = refresh_pricing_override(&ctx, vec!["x".into()])
            .await
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("Missing pricing defaults: "), "{err}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_merges_into_existing_override() {
        let env = TestEnv::new();
        let ctx = ctx_with_defaults(&env);
        set_url(&stub(LIVE, "200 OK").await);
        let over = env.dir.path().join(".config/cc-dashboard");
        std::fs::create_dir_all(&over).unwrap();
        std::fs::write(
            over.join("pricing.json"),
            r#"{"models":{"hand-set":{"input":1,"output":2}}}"#,
        )
        .unwrap();
        // A cached load must be dropped by the refresh.
        let _ = load_pricing_with_meta(&ctx).await.unwrap();
        let result = refresh_pricing_override(
            &ctx,
            vec![
                "opencode:MiniMax-M3".into(),
                "claude:MiniMax-M3".into(),
                "".into(),
                "codex:unknown".into(),
            ],
        )
        .await
        .unwrap();
        assert!(cache().lock().unwrap().is_none());
        unset_url();
        assert_eq!(result.written_count, result.resolved.len());
        assert_eq!(result.resolved.len(), 1);
        assert_eq!(result.resolved[0].key, "MiniMax-M3");
        assert_eq!(result.unresolved, vec!["codex:unknown"]);
        assert_eq!(result.open_router_error, None);
        assert_eq!(result.override_path, "~/.config/cc-dashboard/pricing.json");
        let text = std::fs::read_to_string(over.join("pricing.json")).unwrap();
        assert!(text.ends_with("}\n"));
        assert!(text.starts_with("{\n  \"models\": {\n    \"hand-set\": {\n      \"input\": 1,\n      \"output\": 2\n    },"), "{text}");
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["models"]["MiniMax-M3"]["input"], serde_json::json!(0.25));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refresh_rejects_corrupt_override() {
        let env = TestEnv::new();
        let ctx = ctx_with_defaults(&env);
        set_url("http://127.0.0.1:9/");
        let over = env.dir.path().join(".config/cc-dashboard");
        std::fs::create_dir_all(&over).unwrap();
        std::fs::write(over.join("pricing.json"), "{nope").unwrap();
        let err = refresh_pricing_override(&ctx, vec!["x".into()])
            .await
            .unwrap_err()
            .to_string();
        unset_url();
        assert!(err.starts_with("Override unreadable:"), "{err}");
    }
}
