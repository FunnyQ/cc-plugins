// api.ts types and helpers that more than one provider source needs.
use indexmap::IndexMap;
use jiff::{Timestamp, tz::TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub use super::dedup::DedupUsage as TranscriptUsage;

pub fn now_ms() -> i64 {
    if let Some(pinned) = std::env::var("TOKEN_ATLAS_NOW_MS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|&value| value > 0)
    {
        return pinned;
    }
    Timestamp::now().as_millisecond()
}

pub struct Ctx {
    pub now_ms: i64,
    pub plugin_root: PathBuf,
}

impl Ctx {
    pub fn from_env() -> anyhow::Result<Ctx> {
        let plugin_root = crate::paths::plugin_root().map_err(anyhow::Error::msg)?;
        Ok(Ctx {
            now_ms: now_ms(),
            plugin_root,
        })
    }
}

#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search_requests: Option<i64>,
    #[serde(rename = "costUSD", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyUsageBucket {
    pub timestamp_ms: i64,
    pub usage_by_model: IndexMap<String, ModelUsage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Opencode => "opencode",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerCostBasis {
    Usage,
    ThreadTokens,
    Unavailable,
}

// api.ts LedgerRow minus costUSD, with usageByModel still unserialized.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalLedgerRow {
    pub id: String,
    pub provider: Provider,
    pub timestamp_ms: i64,
    pub date: String,
    pub project_path: String,
    pub project_name: String,
    pub model: String,
    pub interactions: i64,
    pub tool_calls: i64,
    pub tokens: i64,
    pub cost_basis: LedgerCostBasis,
    pub usage_by_model: IndexMap<String, ModelUsage>,
}

/// The five aggregates every provider source returns (api.ts `ClaudeAggregates`).
#[derive(Clone, Default, Debug, PartialEq)]
pub struct ProviderUsage {
    pub model_usage: IndexMap<String, ModelUsage>,
    pub daily_model_usage: IndexMap<String, IndexMap<String, ModelUsage>>,
    pub hourly_usage: IndexMap<i64, HourlyUsageBucket>,
    pub project_tokens: IndexMap<String, i64>,
    pub project_model_usage: IndexMap<String, IndexMap<String, ModelUsage>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    pub used_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub elapsed_percent: Option<f64>,
    pub remaining_ms: Option<f64>,
    // The window's own length, so the UI never names a window from the slot it arrived in.
    pub duration_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub source: String,
    pub path: String,
    pub captured_at: Option<String>,
    pub stale: bool,
    pub error: Option<String>,
    // Optional and nullable in TS: None omits the key, Some(None) prints null.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Option<String>>,
    pub five_hour: Option<UsageLimitWindow>,
    pub weekly: Option<UsageLimitWindow>,
}

pub fn model_key(provider: Provider, model: &str) -> String {
    format!("{}:{model}", provider.as_str())
}

pub fn provider_from_model_key(key: &str) -> Provider {
    if key.starts_with("codex:") {
        Provider::Codex
    } else if key.starts_with("opencode:") {
        Provider::Opencode
    } else {
        Provider::Claude
    }
}

pub fn raw_model_from_key(key: &str) -> &str {
    ["claude:", "codex:", "opencode:"]
        .iter()
        .find_map(|prefix| key.strip_prefix(prefix))
        .unwrap_or(key)
}

pub fn empty_model_usage() -> ModelUsage {
    ModelUsage {
        reasoning_output_tokens: Some(0),
        ..Default::default()
    }
}

pub fn add_usage(target: &mut ModelUsage, usage: &TranscriptUsage) {
    target.input_tokens += usage.input_tokens.unwrap_or(0);
    target.output_tokens += usage.output_tokens.unwrap_or(0);
    target.cache_read_input_tokens += usage.cache_read_input_tokens.unwrap_or(0);
    target.cache_creation_input_tokens += usage.cache_creation_input_tokens.unwrap_or(0);
}

pub fn add_model_usage(target: &mut ModelUsage, source: &ModelUsage) {
    target.input_tokens += source.input_tokens;
    target.output_tokens += source.output_tokens;
    target.cache_read_input_tokens += source.cache_read_input_tokens;
    target.cache_creation_input_tokens += source.cache_creation_input_tokens;
    target.reasoning_output_tokens = Some(
        target.reasoning_output_tokens.unwrap_or(0) + source.reasoning_output_tokens.unwrap_or(0),
    );
    if source.cost_usd.is_some() || target.cost_usd.is_some() {
        target.cost_usd = Some(target.cost_usd.unwrap_or(0.0) + source.cost_usd.unwrap_or(0.0));
    }
}

pub fn model_usage_total(usage: &ModelUsage) -> i64 {
    usage.input_tokens
        + usage.output_tokens
        + usage.cache_read_input_tokens
        + usage.cache_creation_input_tokens
        + usage.reasoning_output_tokens.unwrap_or(0)
}

pub fn add_hourly_usage(
    buckets: &mut IndexMap<i64, HourlyUsageBucket>,
    timestamp_ms: i64,
    model: &str,
    usage: &ModelUsage,
) {
    if timestamp_ms == 0 {
        return;
    }
    let hour_ms = super::dedup::hour_start_ms(timestamp_ms);
    let bucket = buckets.entry(hour_ms).or_insert_with(|| HourlyUsageBucket {
        timestamp_ms: hour_ms,
        usage_by_model: IndexMap::new(),
    });
    let current = bucket
        .usage_by_model
        .entry(model.to_owned())
        .or_insert_with(empty_model_usage);
    add_model_usage(current, usage);
}

pub fn add_nested_model_usage(
    outer: &mut IndexMap<String, IndexMap<String, ModelUsage>>,
    key: &str,
    model: &str,
    usage: &ModelUsage,
) {
    let target = outer
        .entry(key.to_owned())
        .or_default()
        .entry(model.to_owned())
        .or_insert_with(empty_model_usage);
    add_model_usage(target, usage);
}

pub fn project_name(path: &str) -> String {
    path.split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or(path)
        .to_owned()
}

// String.replace semantics: the first occurrence of HOME anywhere, not only as a prefix.
pub fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    let home = super::paths::home();
    let home = home.to_string_lossy();
    if home.is_empty() {
        return path.into_owned();
    }
    path.replacen(home.as_ref(), "~", 1)
}

pub fn fmt_date(ms: i64) -> String {
    if ms == 0 {
        return String::new();
    }
    let Ok(ts) = Timestamp::from_millisecond(ms) else {
        return String::new();
    };
    // Local date, matching the activity heatmap's local hour-of-day semantics.
    ts.to_zoned(TimeZone::system())
        .date()
        .strftime("%Y-%m-%d")
        .to_string()
}

// JS Number(): whitespace-only is 0, radix prefixes parse, anything non-finite is rejected.
fn js_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix)
                .ok()
                .filter(|_| !digits.starts_with('+'))
                .map(|value| value as f64);
        }
    }
    // Rust also accepts "inf" and "nan", which JS Number() does not.
    if !text
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    text.parse::<f64>().ok()
}

pub fn coerce_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()),
        Value::String(text) => js_number(text).filter(|n| n.is_finite()),
        _ => None,
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn build_usage_limit_window(
    bucket: Option<&Value>,
    duration_ms: i64,
    now_ms: i64,
) -> Option<UsageLimitWindow> {
    let bucket = bucket.filter(|bucket| js_truthy(bucket))?;
    let used_percent = bucket.get("used_percentage").and_then(coerce_number);
    let Some(reset_at_seconds) = bucket.get("resets_at").and_then(coerce_number) else {
        return Some(UsageLimitWindow {
            used_percent,
            reset_at: None,
            elapsed_percent: None,
            remaining_ms: None,
            duration_ms,
        });
    };
    let reset_at_ms = reset_at_seconds * 1000.0;
    // new Date(x) truncates to whole milliseconds before toISOString.
    let reset_at = Timestamp::from_millisecond(reset_at_ms.trunc() as i64)
        .ok()
        .map(|ts| ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
    let duration = duration_ms as f64;
    let start_at_ms = reset_at_ms - duration;
    let elapsed_ms = 0f64.max(duration.min(now_ms as f64 - start_at_ms));
    Some(UsageLimitWindow {
        used_percent,
        reset_at,
        elapsed_percent: Some(elapsed_ms / duration * 100.0),
        remaining_ms: Some(duration - elapsed_ms),
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use serde_json::json;

    #[test]
    fn now_ms_pins_only_positive_integers() {
        let _env = TestEnv::new();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", "1700000000000");
        assert_eq!(now_ms(), 1_700_000_000_000);
        for bad in ["0", "-5", "abc"] {
            TestEnv::set("TOKEN_ATLAS_NOW_MS", bad);
            assert!(now_ms() > 1_700_000_000_000, "{bad}");
        }
    }

    #[test]
    fn model_key_round_trip() {
        for provider in [Provider::Claude, Provider::Codex, Provider::Opencode] {
            let key = model_key(provider, "gpt-5");
            assert_eq!(provider_from_model_key(&key), provider);
            assert_eq!(raw_model_from_key(&key), "gpt-5");
        }
        assert_eq!(
            model_key(Provider::Claude, "claude-opus-4-7"),
            "claude:claude-opus-4-7"
        );
        assert_eq!(provider_from_model_key("claude-opus-4-7"), Provider::Claude);
        assert_eq!(raw_model_from_key("claude-opus-4-7"), "claude-opus-4-7");
        assert_eq!(raw_model_from_key("openai:gpt"), "openai:gpt");
        assert_eq!(
            serde_json::to_value(Provider::Opencode).unwrap(),
            json!("opencode")
        );
    }

    #[test]
    fn coerce_number_matches_api_test() {
        assert_eq!(coerce_number(&json!(42)), Some(42.0));
        assert_eq!(coerce_number(&json!(" 3.5 ")), Some(3.5));
        assert_eq!(coerce_number(&json!("nope")), None);
        assert_eq!(coerce_number(&Value::Null), None);
        assert_eq!(coerce_number(&json!("")), Some(0.0));
        assert_eq!(coerce_number(&json!("   ")), Some(0.0));
        assert_eq!(coerce_number(&json!("Infinity")), None);
        assert_eq!(coerce_number(&json!("inf")), None);
        assert_eq!(coerce_number(&json!("0x10")), Some(16.0));
        assert_eq!(coerce_number(&json!(true)), None);
    }

    #[test]
    fn usage_limit_window_matches_api_test() {
        assert_eq!(build_usage_limit_window(None, 1000, 0), None);
        assert_eq!(build_usage_limit_window(Some(&Value::Null), 1000, 0), None);
        let bucket = json!({"used_percentage": "50", "resets_at": 1000});
        assert_eq!(
            build_usage_limit_window(Some(&bucket), 1000, 999_500),
            Some(UsageLimitWindow {
                used_percent: Some(50.0),
                reset_at: Some("1970-01-01T00:16:40.000Z".into()),
                elapsed_percent: Some(50.0),
                remaining_ms: Some(500.0),
                duration_ms: 1000,
            })
        );
        let partial = json!({"used_percentage": 12});
        assert_eq!(
            build_usage_limit_window(Some(&partial), 1000, 0),
            Some(UsageLimitWindow {
                used_percent: Some(12.0),
                reset_at: None,
                elapsed_percent: None,
                remaining_ms: None,
                duration_ms: 1000,
            })
        );
        let iso = json!({"resets_at": 1_790_856_000});
        assert_eq!(
            build_usage_limit_window(Some(&iso), 1000, 0)
                .unwrap()
                .reset_at,
            Some("2026-10-01T12:00:00.000Z".into())
        );
    }

    #[test]
    fn usage_arithmetic_and_nesting_keep_order() {
        let mut target = empty_model_usage();
        add_usage(
            &mut target,
            &TranscriptUsage {
                input_tokens: Some(1),
                output_tokens: Some(2),
                ..Default::default()
            },
        );
        let source = ModelUsage {
            cache_read_input_tokens: 3,
            cost_usd: Some(0.5),
            reasoning_output_tokens: Some(4),
            ..Default::default()
        };
        add_model_usage(&mut target, &source);
        assert_eq!(model_usage_total(&target), 10);
        assert_eq!(target.cost_usd, Some(0.5));
        let mut plain = ModelUsage::default();
        add_model_usage(&mut plain, &ModelUsage::default());
        assert_eq!(plain.cost_usd, None);
        assert_eq!(plain.reasoning_output_tokens, Some(0));

        let mut outer = IndexMap::new();
        add_nested_model_usage(&mut outer, "b", "m", &source);
        add_nested_model_usage(&mut outer, "a", "m", &source);
        add_nested_model_usage(&mut outer, "b", "m", &source);
        assert_eq!(outer.keys().collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(outer["b"]["m"].cache_read_input_tokens, 6);

        let mut buckets = IndexMap::new();
        add_hourly_usage(&mut buckets, 0, "m", &source);
        assert!(buckets.is_empty());
        add_hourly_usage(&mut buckets, 1_790_858_096_789, "m", &source);
        assert_eq!(buckets.len(), 1);
        let json = serde_json::to_value(&target).unwrap();
        assert_eq!(json["costUSD"], json!(0.5));
        assert_eq!(json["cacheReadInputTokens"], json!(3));
    }

    #[test]
    fn project_and_display_paths() {
        assert_eq!(project_name("/a/b/"), "b");
        assert_eq!(project_name("/"), "/");
        assert_eq!(project_name("repo"), "repo");
        let env = TestEnv::new();
        let home = env.dir.path();
        assert_eq!(display_path(&home.join("x/y")), "~/x/y");
        assert_eq!(display_path(Path::new("/other")), "/other");
    }

    #[test]
    fn fmt_date_zero_is_empty() {
        assert_eq!(fmt_date(0), "");
        assert_eq!(fmt_date(1_790_858_096_789).len(), 10);
    }
}
