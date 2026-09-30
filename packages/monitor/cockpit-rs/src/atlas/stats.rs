// Port of api.ts buildStats + statsFingerprint, with project-cost.ts and daily-activity.ts.
use super::claude::{ClaudeSource, HistoryDay, StatsCacheDailyActivity};
use super::codex::CodexSource;
use super::model::{
    Ctx, HourlyUsageBucket, InternalLedgerRow, LedgerCostBasis, ModelUsage, Provider, UsageLimits,
    add_hourly_usage, display_path, fmt_date, iso_ms, model_key, model_usage_total, now_ms,
    project_name, provider_from_model_key, raw_model_from_key,
};
use super::opencode::OpenCodeSource;
use super::pricing::{PricingLoad, PricingTable};
use super::session_files::{ClaudeSessionFile, read_session_files};
use super::{claude, codex, dedup, opencode, paths, pricing};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime};

const USAGE: &str = "usage: cockpit atlas stats [--source claude|codex|opencode|pricing]";

type ProjectModelUsage = IndexMap<String, IndexMap<String, ModelUsage>>;

fn budget_config_path() -> PathBuf {
    paths::home().join(".config/cc-dashboard/budget.json")
}

// ---------- build ----------

pub async fn build(ctx: &Ctx) -> anyhow::Result<Value> {
    let (pricing_load, codex_usage_limits) = tokio::join!(
        pricing::load_pricing_with_meta(ctx),
        codex::read_codex_usage_limits(ctx)
    );
    let pricing_load = pricing_load?;
    let ctx = ctx.clone();
    // Every parse runs off the runtime thread: a blocking build on current_thread stalls /api/live.
    tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        wait_for_test_barrier();
        let loaded = load_sources(&ctx)?;
        Ok(assemble(loaded, &pricing_load, codex_usage_limits))
    })
    .await?
}

// Test seam (contracts.md §1): proves a build in progress never blocks /api/live.
fn wait_for_test_barrier() {
    let Some(barrier) =
        std::env::var_os("TOKEN_ATLAS_TEST_BUILD_BARRIER").filter(|value| !value.is_empty())
    else {
        return;
    };
    let barrier = PathBuf::from(barrier);
    let mut entered = barrier.clone().into_os_string();
    entered.push(".entered");
    let _ = std::fs::write(&entered, "");
    while !barrier.exists() {
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct Loaded {
    claude: ClaudeSource,
    codex: CodexSource,
    opencode: OpenCodeSource,
    sessions: Vec<ClaudeSessionFile>,
    budget: BudgetMeta,
    usage_limits: UsageLimits,
    data_health: DataHealth,
}

fn load_sources(ctx: &Ctx) -> anyhow::Result<Loaded> {
    let claude = claude::load(ctx)?;
    let sessions = read_session_files();
    let budget = load_budget_config();
    let usage_limits = claude::read_usage_limits(ctx);
    let codex = codex::load(ctx)?;
    let opencode = opencode::load(ctx)?;
    let data_health = build_data_health(DataHealthCounts {
        claude_transcript_files: claude.transcript_file_count,
        codex_session_files: codex.codex_session_file_count,
        codex_thread_rows: codex.codex_thread_row_count,
        open_code_session_files: opencode.open_code_session_file_count,
        open_code_message_files: opencode.open_code_message_file_count,
        open_code_session_rows: opencode.open_code_session_row_count,
        open_code_message_rows: opencode.open_code_message_row_count,
    });
    Ok(Loaded {
        claude,
        codex,
        opencode,
        sessions,
        budget,
        usage_limits,
        data_health,
    })
}

// ---------- Data health ----------

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SourceStatus {
    Ok,
    Missing,
    Unreadable,
    Empty,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataHealthSource {
    name: String,
    path: String,
    status: SourceStatus,
    modified_at: Option<String>,
    note: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataHealthCounts {
    claude_transcript_files: usize,
    codex_session_files: usize,
    codex_thread_rows: usize,
    open_code_session_files: usize,
    open_code_message_files: usize,
    open_code_session_rows: usize,
    open_code_message_rows: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct DataHealth {
    sources: Vec<DataHealthSource>,
    counts: DataHealthCounts,
}

fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let since = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?;
    Some(since.as_nanos() as f64 / 1_000_000.0)
}

// Node's `CODE: text, syscall 'path'` for the one errno a present source realistically hits.
fn node_error(err: &std::io::Error, syscall: &str, path: &Path) -> String {
    match err.raw_os_error() {
        Some(libc::EACCES) => format!("EACCES: permission denied, {syscall} '{}'", path.display()),
        _ => err.to_string(),
    }
}

fn readable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: c_path is a valid NUL-terminated string for the duration of the call.
    if unsafe { libc::access(c_path.as_ptr(), libc::R_OK) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn source_health(name: &str, path: &Path, note: &str) -> DataHealthSource {
    let mut source = DataHealthSource {
        name: name.to_owned(),
        path: display_path(path),
        status: SourceStatus::Missing,
        modified_at: None,
        note: note.to_owned(),
    };
    if !path.exists() {
        return source;
    }
    let checked = readable(path)
        .map_err(|e| node_error(&e, "access", path))
        .and_then(|()| std::fs::metadata(path).map_err(|e| node_error(&e, "stat", path)))
        .and_then(|meta| {
            let empty = if meta.is_file() {
                meta.len() == 0
            } else if meta.is_dir() {
                std::fs::read_dir(path)
                    .map_err(|e| node_error(&e, "scandir", path))?
                    .next()
                    .is_none()
            } else {
                false
            };
            Ok((meta, empty))
        });
    match checked {
        Ok((meta, empty)) => {
            source.status = if empty {
                SourceStatus::Empty
            } else {
                SourceStatus::Ok
            };
            // Date#toISOString drops the sub-millisecond part.
            source.modified_at = mtime_ms(&meta).and_then(|ms| iso_ms(ms.floor() as i64));
        }
        Err(message) => {
            source.status = SourceStatus::Unreadable;
            source.note = message;
        }
    }
    source
}

fn build_data_health(counts: DataHealthCounts) -> DataHealth {
    let sources = [
        ("Claude stats cache", paths::stats_cache(), "required"),
        (
            "Claude history",
            paths::history(),
            "optional activity timeline",
        ),
        (
            "Claude sessions",
            paths::sessions_dir(),
            "optional session records",
        ),
        (
            "Claude projects",
            paths::projects_dir(),
            "optional transcript records",
        ),
        (
            "Codex state DB",
            paths::codex_state_db(),
            "optional thread index",
        ),
        (
            "Codex sessions",
            paths::codex_sessions_dir(),
            "optional rollout records",
        ),
        (
            "Codex usage cache",
            paths::codex_usage_cache(),
            "optional live limit cache",
        ),
        (
            "OpenCode storage",
            paths::opencode_storage_dir(),
            "optional root storage",
        ),
        (
            "OpenCode database",
            paths::opencode_db(),
            "optional SQLite usage",
        ),
        (
            "OpenCode projects",
            paths::opencode_project_dir(),
            "optional project storage",
        ),
        (
            "Pricing override",
            pricing::override_path(),
            "optional user pricing",
        ),
        ("Budget config", budget_config_path(), "optional budget"),
    ];
    DataHealth {
        sources: sources
            .iter()
            .map(|(name, path, note)| source_health(name, path, note))
            .collect(),
        counts,
    }
}

// ---------- Budget ----------

#[derive(Clone, Debug, PartialEq, Serialize)]
struct BudgetMeta {
    #[serde(rename = "monthlyBudgetUSD")]
    monthly_budget_usd: Option<serde_json::Number>,
    source: String,
    loaded: bool,
    error: Option<String>,
}

fn load_budget_config() -> BudgetMeta {
    let path = budget_config_path();
    let mut meta = BudgetMeta {
        monthly_budget_usd: None,
        source: display_path(&path),
        loaded: false,
        error: None,
    };
    if !path.exists() {
        return meta;
    }
    // The parse message is serde's, not JSC's SyntaxError text.
    let data = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
    {
        Ok(data) => data,
        Err(message) => {
            meta.error = Some(message);
            return meta;
        }
    };
    match data.get("monthlyBudgetUSD") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(|v| v.is_finite() && v > 0.0) => {
            meta.monthly_budget_usd = Some(n.clone());
            meta.loaded = true;
        }
        _ => meta.error = Some("Expected positive numeric monthlyBudgetUSD".into()),
    }
    meta
}

// ---------- Serializers ----------

fn is_anthropic_model(model: &str) -> bool {
    model.starts_with("claude-") || model.starts_with("anthropic/claude-")
}

fn is_external(model: &str, prefixes: &[String]) -> bool {
    !is_anthropic_model(model) || prefixes.iter().any(|p| model.starts_with(p.as_str()))
}

fn usage_cost(usage: &ModelUsage, model: &str, table: &PricingTable) -> f64 {
    match usage.cost_usd {
        Some(cost) if cost > 0.0 => cost,
        _ => pricing::calc_cost(usage, model, table),
    }
}

// JS `(a, b) => b.costUSD - a.costUSD`: a NaN difference counts as a tie.
fn by_cost_desc(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializedModelUsage {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    reasoning_tokens: i64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    provider: Provider,
    is_external: bool,
}

fn serialize_usage_by_model(
    usage_by_model: &IndexMap<String, ModelUsage>,
    table: &PricingTable,
) -> IndexMap<String, SerializedModelUsage> {
    usage_by_model
        .iter()
        .map(|(model, usage)| {
            let raw = raw_model_from_key(model);
            let row = SerializedModelUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_input_tokens,
                cache_creation_tokens: usage.cache_creation_input_tokens,
                reasoning_tokens: usage.reasoning_output_tokens.unwrap_or(0),
                cost_usd: usage_cost(usage, raw, table),
                provider: provider_from_model_key(model),
                is_external: is_external(raw, &table.external_model_prefixes),
            };
            (model.clone(), row)
        })
        .collect()
}

// One shape for both byModel and a project's models list.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelRow {
    model: String,
    provider: Provider,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    reasoning_tokens: i64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    is_external: bool,
}

impl ModelRow {
    fn new(
        model: String,
        provider: Provider,
        raw: &str,
        usage: &ModelUsage,
        table: &PricingTable,
    ) -> ModelRow {
        ModelRow {
            model,
            provider,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
            reasoning_tokens: usage.reasoning_output_tokens.unwrap_or(0),
            cost_usd: usage_cost(usage, raw, table),
            is_external: is_external(raw, &table.external_model_prefixes),
        }
    }

    fn token_sum(&self) -> i64 {
        self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
            + self.reasoning_tokens
    }
}

fn serialize_project_model_usage(
    provider: Provider,
    by_model: Option<&IndexMap<String, ModelUsage>>,
    table: &PricingTable,
) -> Vec<ModelRow> {
    let Some(by_model) = by_model else {
        return Vec::new();
    };
    let mut rows: Vec<ModelRow> = by_model
        .iter()
        .map(|(model, usage)| {
            // Claude transcript keys are bare model names; the other providers' are already namespaced.
            let (name, raw) = if provider == Provider::Claude {
                (model_key(Provider::Claude, model), model.as_str())
            } else {
                (model.clone(), raw_model_from_key(model))
            };
            ModelRow::new(name, provider, raw, usage, table)
        })
        .filter(|row| row.token_sum() as f64 + row.cost_usd > 0.0)
        .collect();
    rows.sort_by(|a, b| by_cost_desc(a.cost_usd, b.cost_usd));
    rows
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerRow {
    id: String,
    provider: Provider,
    timestamp_ms: i64,
    date: String,
    project_path: String,
    project_name: String,
    model: String,
    interactions: i64,
    tool_calls: i64,
    tokens: i64,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    cost_basis: LedgerCostBasis,
    usage_by_model: IndexMap<String, SerializedModelUsage>,
}

fn serialize_ledger_rows(rows: Vec<InternalLedgerRow>, table: &PricingTable) -> Vec<LedgerRow> {
    let mut out: Vec<LedgerRow> = rows
        .into_iter()
        .map(|row| {
            // Summed off the serialized rows, in the same order: one pricing pass, same bits.
            let usage_by_model = serialize_usage_by_model(&row.usage_by_model, table);
            let cost_usd = (!usage_by_model.is_empty()
                && row.cost_basis != LedgerCostBasis::Unavailable)
                .then(|| {
                    usage_by_model
                        .values()
                        .fold(0.0, |sum, usage| sum + usage.cost_usd)
                });
            LedgerRow {
                usage_by_model,
                id: row.id,
                provider: row.provider,
                timestamp_ms: row.timestamp_ms,
                date: row.date,
                project_path: row.project_path,
                project_name: row.project_name,
                model: row.model,
                interactions: row.interactions,
                tool_calls: row.tool_calls,
                tokens: row.tokens,
                cost_usd,
                cost_basis: row.cost_basis,
            }
        })
        .collect();
    out.sort_by_key(|row| std::cmp::Reverse(row.timestamp_ms));
    out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HourlyRow {
    timestamp_ms: i64,
    date: String,
    tokens: i64,
    tokens_by_model: IndexMap<String, i64>,
    usage_by_model: IndexMap<String, SerializedModelUsage>,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
}

fn serialize_hourly_usage(
    buckets: &IndexMap<i64, HourlyUsageBucket>,
    table: &PricingTable,
) -> Vec<HourlyRow> {
    let mut rows: Vec<HourlyRow> = buckets
        .values()
        .map(|bucket| {
            let tokens_by_model: IndexMap<String, i64> = bucket
                .usage_by_model
                .iter()
                .map(|(model, usage)| (model.clone(), model_usage_total(usage)))
                .collect();
            let usage_by_model = serialize_usage_by_model(&bucket.usage_by_model, table);
            HourlyRow {
                timestamp_ms: bucket.timestamp_ms,
                date: fmt_date(bucket.timestamp_ms),
                tokens: tokens_by_model.values().sum(),
                tokens_by_model,
                cost_usd: usage_by_model
                    .values()
                    .fold(0.0, |sum, usage| sum + usage.cost_usd),
                usage_by_model,
            }
        })
        .collect();
    rows.sort_by_key(|row| row.timestamp_ms);
    rows
}

// ---------- project-cost.ts / daily-activity.ts ----------

#[derive(Debug, Default)]
struct ProjectCosts {
    project_cost: IndexMap<String, f64>,
    claude_project_cost: IndexMap<String, f64>,
    codex_project_cost: IndexMap<String, f64>,
}

// The two cost fns differ because codex keys are namespaced and must be stripped before pricing.
fn aggregate_project_costs(
    claude_usage: &ProjectModelUsage,
    codex_usage: &ProjectModelUsage,
    claude_cost: impl Fn(&str, &ModelUsage) -> f64,
    codex_cost: impl Fn(&str, &ModelUsage) -> f64,
) -> ProjectCosts {
    let mut costs = ProjectCosts::default();
    for (path, by_model) in claude_usage {
        let cost = by_model
            .iter()
            .fold(0.0, |sum, (model, usage)| sum + claude_cost(model, usage));
        costs.claude_project_cost.insert(path.clone(), cost);
        costs.project_cost.insert(path.clone(), cost);
    }
    for (path, by_model) in codex_usage {
        let cost = by_model
            .iter()
            .fold(0.0, |sum, (model, usage)| sum + codex_cost(model, usage));
        costs.codex_project_cost.insert(path.clone(), cost);
        *costs.project_cost.entry(path.clone()).or_insert(0.0) += cost;
    }
    costs
}

#[derive(Clone, Debug, PartialEq)]
struct DayActivity {
    message_count: i64,
    session_count: i64,
    tool_call_count: i64,
}

// The cache is authoritative for its days; history only supplements days strictly after the last one.
fn merge_daily_activity(
    daily_activity: &[StatsCacheDailyActivity],
    daily_history: &IndexMap<String, HistoryDay>,
    last_cached_activity_date: Option<&str>,
) -> (IndexMap<String, DayActivity>, Vec<String>) {
    let mut activity_by_date: IndexMap<String, DayActivity> = daily_activity
        .iter()
        .map(|d| {
            let activity = DayActivity {
                message_count: d.message_count,
                session_count: d.session_count,
                tool_call_count: d.tool_call_count,
            };
            (d.date.clone(), activity)
        })
        .collect();
    let mut supplemental = Vec::new();
    for (date, history) in daily_history {
        if activity_by_date.contains_key(date) {
            continue;
        }
        if last_cached_activity_date.is_some_and(|last| !last.is_empty() && date.as_str() <= last) {
            continue;
        }
        activity_by_date.insert(
            date.clone(),
            DayActivity {
                message_count: history.message_count,
                session_count: history.session_ids.len() as i64,
                tool_call_count: 0,
            },
        );
        supplemental.push(date.clone());
    }
    (activity_by_date, supplemental)
}

// ---------- Assembly ----------

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDay {
    messages: i64,
    sessions: i64,
    tool_calls: i64,
}

#[derive(Debug, Serialize)]
struct Providers<T> {
    claude: T,
    codex: T,
    opencode: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyRow {
    date: String,
    messages: i64,
    sessions: i64,
    tool_calls: i64,
    tokens: i64,
    tokens_by_model: IndexMap<String, i64>,
    usage_by_model: IndexMap<String, SerializedModelUsage>,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    providers: Providers<ProviderDay>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProject {
    messages: i64,
    sessions: i64,
    tool_calls: i64,
    tokens: i64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRow {
    name: String,
    path: String,
    message_count: i64,
    claude_messages: i64,
    codex_messages: i64,
    codex_threads: i64,
    codex_tool_calls: i64,
    open_code_messages: i64,
    open_code_sessions: i64,
    open_code_tool_calls: i64,
    claude_tokens: i64,
    codex_tokens: i64,
    open_code_tokens: i64,
    tokens: i64,
    #[serde(rename = "claudeCostUSD")]
    claude_cost_usd: f64,
    #[serde(rename = "codexCostUSD")]
    codex_cost_usd: f64,
    #[serde(rename = "openCodeCostUSD")]
    open_code_cost_usd: f64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    providers: Providers<ProviderProject>,
    models: Vec<ModelRow>,
    first_seen: String,
    last_seen: String,
    last_seen_ms: i64,
}

fn build_daily(
    loaded: &Loaded,
    activity_by_date: &IndexMap<String, DayActivity>,
    supplemental_history_dates: &[String],
    table: &PricingTable,
) -> Vec<DailyRow> {
    let cache = &loaded.claude.stats_cache;
    let codex = &loaded.codex;
    let opencode = &loaded.opencode;
    let mut tokens_by_date: IndexMap<String, IndexMap<String, i64>> = IndexMap::new();
    for d in cache.daily_model_tokens.iter().flatten() {
        let tokens = d
            .tokens_by_model
            .iter()
            .map(|(model, tokens)| (model_key(Provider::Claude, model), *tokens))
            .collect();
        tokens_by_date.insert(d.date.clone(), tokens);
    }
    let mut combined: IndexMap<String, IndexMap<String, ModelUsage>> = IndexMap::new();
    for (date, usage_by_model) in &loaded.claude.usage.daily_model_usage {
        let day = combined.entry(date.clone()).or_default();
        for (model, usage) in usage_by_model {
            day.insert(model_key(Provider::Claude, model), usage.clone());
        }
        if tokens_by_date.contains_key(date) {
            continue;
        }
        let tokens = usage_by_model
            .iter()
            .map(|(model, usage)| (model_key(Provider::Claude, model), model_usage_total(usage)))
            .collect();
        tokens_by_date.insert(date.clone(), tokens);
    }
    // Codex and OpenCode keys are already namespaced, so both merge the same way.
    for source in [
        &codex.usage.daily_model_usage,
        &opencode.usage.daily_model_usage,
    ] {
        for (date, usage_by_model) in source {
            let day = combined.entry(date.clone()).or_default();
            let day_tokens = tokens_by_date.entry(date.clone()).or_default();
            for (model, usage) in usage_by_model {
                day.insert(model.clone(), usage.clone());
                *day_tokens.entry(model.clone()).or_insert(0) += model_usage_total(usage);
            }
        }
    }

    let mut dates: BTreeSet<&str> = BTreeSet::new();
    dates.extend(
        cache
            .daily_activity
            .iter()
            .flatten()
            .map(|d| d.date.as_str()),
    );
    dates.extend(supplemental_history_dates.iter().map(String::as_str));
    dates.extend(tokens_by_date.keys().map(String::as_str));
    dates.extend(combined.keys().map(String::as_str));
    dates.extend(codex.daily_activity.keys().map(String::as_str));
    dates.extend(opencode.daily_activity.keys().map(String::as_str));

    dates
        .into_iter()
        .map(|date| {
            let activity = activity_by_date.get(date);
            let tokens_by_model = tokens_by_date.get(date).cloned().unwrap_or_default();
            let usage_by_model = combined
                .get(date)
                .map(|by_model| serialize_usage_by_model(by_model, table))
                .unwrap_or_default();
            let cost_usd = usage_by_model
                .values()
                .fold(0.0, |sum, usage| sum + usage.cost_usd);
            let codex_day = codex.daily_activity.get(date);
            let opencode_day = opencode.daily_activity.get(date);
            let codex_threads = codex_day.map_or(0, |a| a.thread_count);
            let opencode_sessions = opencode_day.map_or(0, |a| a.session_count);
            let session_count = activity.map_or(0, |a| a.session_count);
            let providers = Providers {
                claude: ProviderDay {
                    messages: activity.map_or(0, |a| a.message_count),
                    sessions: 0.max(session_count - codex_threads - opencode_sessions),
                    tool_calls: activity.map_or(0, |a| a.tool_call_count),
                },
                codex: ProviderDay {
                    messages: codex_day.map_or(codex_threads, |a| a.interaction_count),
                    sessions: codex_threads,
                    tool_calls: codex_day.map_or(0, |a| a.tool_call_count),
                },
                opencode: ProviderDay {
                    messages: opencode_day.map_or(0, |a| a.interaction_count),
                    sessions: opencode_sessions,
                    tool_calls: opencode_day.map_or(0, |a| a.tool_call_count),
                },
            };
            DailyRow {
                date: date.to_owned(),
                messages: providers.claude.messages
                    + providers.codex.messages
                    + providers.opencode.messages,
                sessions: session_count,
                tool_calls: providers.claude.tool_calls
                    + providers.codex.tool_calls
                    + providers.opencode.tool_calls,
                tokens: tokens_by_model.values().sum(),
                tokens_by_model,
                usage_by_model,
                cost_usd,
                providers,
            }
        })
        .collect()
}

fn build_projects(loaded: &Loaded, table: &PricingTable) -> Vec<ProjectRow> {
    let claude = &loaded.claude;
    let codex = &loaded.codex;
    let opencode = &loaded.opencode;
    let costs = aggregate_project_costs(
        &claude.usage.project_model_usage,
        &codex.usage.project_model_usage,
        |model, usage| usage_cost(usage, model, table),
        |model, usage| usage_cost(usage, raw_model_from_key(model), table),
    );
    let mut project_cost = costs.project_cost;
    let mut open_code_project_cost: IndexMap<String, f64> = IndexMap::new();
    for (path, by_model) in &opencode.usage.project_model_usage {
        let cost = by_model.iter().fold(0.0, |sum, (model, usage)| {
            sum + usage_cost(usage, raw_model_from_key(model), table)
        });
        open_code_project_cost.insert(path.clone(), cost);
        *project_cost.entry(path.clone()).or_insert(0.0) += cost;
    }

    // Insertion order matters: the message-count sort below is stable.
    let mut project_paths: IndexSet<&str> = IndexSet::new();
    project_paths.extend(claude.history.by_project.keys().map(String::as_str));
    project_paths.extend(codex.project_activity.keys().map(String::as_str));
    project_paths.extend(opencode.project_activity.keys().map(String::as_str));

    let mut projects: Vec<ProjectRow> = project_paths
        .into_iter()
        .map(|path| {
            let claude_activity = claude.history.by_project.get(path);
            let codex_activity = codex.project_activity.get(path);
            let opencode_activity = opencode.project_activity.get(path);
            let mut models = serialize_project_model_usage(
                Provider::Claude,
                claude.usage.project_model_usage.get(path),
                table,
            );
            models.extend(serialize_project_model_usage(
                Provider::Codex,
                codex.usage.project_model_usage.get(path),
                table,
            ));
            models.extend(serialize_project_model_usage(
                Provider::Opencode,
                opencode.usage.project_model_usage.get(path),
                table,
            ));
            models.sort_by(|a, b| by_cost_desc(a.cost_usd, b.cost_usd));
            let first_seen = [
                claude_activity.map(|a| a.first_seen),
                codex_activity.map(|a| a.first_seen),
                opencode_activity.map(|a| a.first_seen),
            ]
            .into_iter()
            .flatten()
            .min();
            let last_seen = [
                claude_activity.map_or(0, |a| a.last_seen),
                codex_activity.map_or(0, |a| a.last_seen),
                opencode_activity.map_or(0, |a| a.last_seen),
            ]
            .into_iter()
            .fold(0, i64::max);
            let claude_tokens = claude.usage.project_tokens.get(path).copied().unwrap_or(0);
            let codex_tokens = codex.usage.project_tokens.get(path).copied().unwrap_or(0);
            let open_code_tokens = opencode
                .usage
                .project_tokens
                .get(path)
                .copied()
                .unwrap_or(0);
            let claude_cost = costs.claude_project_cost.get(path).copied().unwrap_or(0.0);
            let codex_cost = costs.codex_project_cost.get(path).copied().unwrap_or(0.0);
            let open_code_cost = open_code_project_cost.get(path).copied().unwrap_or(0.0);
            let providers = Providers {
                claude: ProviderProject {
                    messages: claude_activity.map_or(0, |a| a.message_count),
                    sessions: 0,
                    tool_calls: 0,
                    tokens: claude_tokens,
                    cost_usd: claude_cost,
                },
                codex: ProviderProject {
                    messages: codex_activity.map_or(0, |a| a.interaction_count),
                    sessions: codex_activity.map_or(0, |a| a.thread_count),
                    tool_calls: codex_activity.map_or(0, |a| a.tool_call_count),
                    tokens: codex_tokens,
                    cost_usd: codex_cost,
                },
                opencode: ProviderProject {
                    messages: opencode_activity.map_or(0, |a| a.interaction_count),
                    sessions: opencode_activity.map_or(0, |a| a.session_count),
                    tool_calls: opencode_activity.map_or(0, |a| a.tool_call_count),
                    tokens: open_code_tokens,
                    cost_usd: open_code_cost,
                },
            };
            ProjectRow {
                name: project_name(path),
                path: path.to_owned(),
                message_count: providers.claude.messages
                    + providers.codex.messages
                    + providers.opencode.messages,
                claude_messages: providers.claude.messages,
                codex_messages: providers.codex.messages,
                codex_threads: providers.codex.sessions,
                codex_tool_calls: providers.codex.tool_calls,
                open_code_messages: providers.opencode.messages,
                open_code_sessions: providers.opencode.sessions,
                open_code_tool_calls: providers.opencode.tool_calls,
                claude_tokens,
                codex_tokens,
                open_code_tokens,
                tokens: claude_tokens + codex_tokens + open_code_tokens,
                claude_cost_usd: claude_cost,
                codex_cost_usd: codex_cost,
                open_code_cost_usd: open_code_cost,
                cost_usd: project_cost.get(path).copied().unwrap_or(0.0),
                providers,
                models,
                first_seen: first_seen.map(fmt_date).unwrap_or_default(),
                last_seen: fmt_date(last_seen),
                last_seen_ms: last_seen,
            }
        })
        .collect();
    projects.sort_by_key(|project| std::cmp::Reverse(project.message_count));
    projects
}

fn assemble(loaded: Loaded, pricing_load: &PricingLoad, codex_usage_limits: UsageLimits) -> Value {
    let table = &pricing_load.table;
    let cache = &loaded.claude.stats_cache;
    let history = &loaded.claude.history;
    let codex = &loaded.codex;
    let opencode = &loaded.opencode;

    // The rollup wins; stats-cache totals stand in only while the rollup holds no Claude rows.
    let claude_model_usage = if loaded.claude.usage.model_usage.is_empty() {
        cache.model_usage.clone().unwrap_or_default()
    } else {
        loaded.claude.usage.model_usage.clone()
    };
    let mut model_usage: IndexMap<String, ModelUsage> = IndexMap::new();
    for (model, usage) in claude_model_usage {
        model_usage.insert(model_key(Provider::Claude, &model), usage);
    }
    for source in [&codex.usage.model_usage, &opencode.usage.model_usage] {
        for (model, usage) in source {
            model_usage.insert(model.clone(), usage.clone());
        }
    }

    let daily_activity = cache.daily_activity.as_deref().unwrap_or_default();
    let last_cached_activity_date = daily_activity.iter().map(|d| d.date.as_str()).max();
    let (mut activity_by_date, supplemental_history_dates) = merge_daily_activity(
        daily_activity,
        &history.daily_history,
        last_cached_activity_date,
    );
    let other_sessions = codex
        .daily_activity
        .iter()
        .map(|(date, a)| (date, a.thread_count))
        .chain(
            opencode
                .daily_activity
                .iter()
                .map(|(date, a)| (date, a.session_count)),
        );
    for (date, sessions) in other_sessions {
        match activity_by_date.get_mut(date) {
            Some(current) => current.session_count += sessions,
            None => {
                activity_by_date.insert(
                    date.clone(),
                    DayActivity {
                        message_count: 0,
                        session_count: sessions,
                        tool_call_count: 0,
                    },
                );
            }
        }
    }
    let daily = build_daily(
        &loaded,
        &activity_by_date,
        &supplemental_history_dates,
        table,
    );

    let mut by_model: Vec<ModelRow> = model_usage
        .iter()
        .map(|(model, usage)| {
            let provider = provider_from_model_key(model);
            ModelRow::new(
                model.clone(),
                provider,
                raw_model_from_key(model),
                usage,
                table,
            )
        })
        .filter(|row| row.token_sum() > 0)
        .collect();
    let total_input_tokens: i64 = by_model.iter().map(|m| m.input_tokens).sum();
    let total_output_tokens: i64 = by_model.iter().map(|m| m.output_tokens).sum();
    let total_cache_read_tokens: i64 = by_model.iter().map(|m| m.cache_read_tokens).sum();
    let total_cache_creation_tokens: i64 = by_model.iter().map(|m| m.cache_creation_tokens).sum();
    let total_reasoning_tokens: i64 = by_model.iter().map(|m| m.reasoning_tokens).sum();
    let total_tokens = total_input_tokens
        + total_output_tokens
        + total_cache_read_tokens
        + total_cache_creation_tokens
        + total_reasoning_tokens;
    // Summed before the cost sort, in insertion order, so f64 rounding matches the TS reduce.
    let estimated_cost_usd = by_model.iter().fold(0.0, |sum, m| sum + m.cost_usd);

    let projects = build_projects(&loaded, table);

    let most_active_day = daily.iter().fold(None::<&DailyRow>, |best, d| match best {
        Some(b) if d.messages <= b.messages => Some(b),
        _ => Some(d),
    });
    // Reasoning tokens stay out of this one total, as in the TS.
    let most_used_model = by_model
        .iter()
        .map(|m| {
            let tokens =
                m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
            (m, tokens)
        })
        .fold(None::<(&ModelRow, i64)>, |best, (m, tokens)| match best {
            Some(b) if tokens <= b.1 => Some(b),
            _ => Some((m, tokens)),
        })
        .map(|(m, _)| m.model.clone());
    let mut week_hour_matrix = history.week_hour_matrix;
    for (dow, row) in week_hour_matrix.iter_mut().enumerate() {
        for (hour, value) in row.iter_mut().enumerate() {
            *value += codex.week_hour_matrix[dow][hour] + opencode.week_hour_matrix[dow][hour];
        }
    }
    let mut daily_hour_counts = history.daily_hour_counts.clone();
    for source in [&codex.daily_hour_counts, &opencode.daily_hour_counts] {
        for (date, counts) in source {
            match daily_hour_counts.get_mut(date) {
                Some(existing) => {
                    for (slot, count) in existing.iter_mut().zip(counts) {
                        *slot += count;
                    }
                }
                None => {
                    daily_hour_counts.insert(date.clone(), *counts);
                }
            }
        }
    }
    let claude_sessions = cache.total_sessions.unwrap_or(0);
    let claude_messages = cache.total_messages.unwrap_or(0);
    let total_sessions = claude_sessions + codex.total_threads as i64 + opencode.total_sessions;
    let total_messages = claude_messages + codex.total_interactions + opencode.total_interactions;
    let average_messages_per_session = if total_sessions != 0 {
        total_messages as f64 / total_sessions as f64
    } else {
        0.0
    };

    let period_from = daily.first().map(|d| d.date.clone()).unwrap_or_default();
    let period_to = daily.last().map(|d| d.date.clone()).unwrap_or_default();
    let ledger = serialize_ledger_rows(
        loaded
            .claude
            .ledger
            .iter()
            .chain(&codex.ledger)
            .chain(&opencode.ledger)
            .cloned()
            .collect(),
        table,
    );
    let mut hourly_usage = IndexMap::new();
    for source in [
        &loaded.claude.usage.hourly_usage,
        &codex.usage.hourly_usage,
        &opencode.usage.hourly_usage,
    ] {
        for bucket in source.values() {
            for (model, usage) in &bucket.usage_by_model {
                add_hourly_usage(&mut hourly_usage, bucket.timestamp_ms, model, usage);
            }
        }
    }
    let mut activity_days: Vec<(&String, &DayActivity)> = activity_by_date.iter().collect();
    activity_days.sort_by(|a, b| a.0.cmp(b.0));
    let activity_days: Vec<Value> = activity_days
        .into_iter()
        .map(|(date, a)| {
            json!({
                "date": date,
                "messages": a.message_count,
                "sessions": a.session_count,
                "interactions": a.message_count + a.session_count,
            })
        })
        .collect();

    let total_tool_calls: i64 = daily.iter().map(|d| d.tool_calls).sum();
    let insights = json!({
        "mostActiveDay": most_active_day.map(|d| d.date.clone()),
        "mostActiveDayMessages": most_active_day.map_or(0, |d| d.messages),
        "mostUsedModel": most_used_model,
        "averageMessagesPerSession": (average_messages_per_session * 10.0).round() / 10.0,
        "mostActiveProject": projects.first().map(|p| p.name.clone()),
        "firstSessionDate": cache.first_session_date,
        "longestSession": cache.longest_session,
    });
    // The TS sorts byModel in place before pricingMeta reads it, so pricingMeta sees the sorted order.
    by_model.sort_by(|a, b| by_cost_desc(a.cost_usd, b.cost_usd));
    let by_model_keys: Vec<String> = by_model.iter().map(|m| m.model.clone()).collect();

    json!({
        "period": { "from": period_from, "to": period_to },
        "summary": {
            "totalSessions": total_sessions,
            "totalMessages": total_messages,
            "totalTokens": total_tokens,
            "totalInputTokens": total_input_tokens,
            "totalOutputTokens": total_output_tokens,
            "totalCacheReadTokens": total_cache_read_tokens,
            "totalCacheCreationTokens": total_cache_creation_tokens,
            "totalReasoningTokens": total_reasoning_tokens,
            "totalToolCalls": total_tool_calls,
            "estimatedCostUSD": estimated_cost_usd,
            "providers": {
                "claude": {
                    "totalSessions": claude_sessions,
                    "totalMessages": claude_messages,
                },
                "codex": {
                    "totalSessions": codex.total_threads,
                    "totalMessages": codex.total_interactions,
                    "totalToolCalls": codex.total_tool_calls,
                },
                "opencode": {
                    "totalSessions": opencode.total_sessions,
                    "totalMessages": opencode.total_interactions,
                    "totalToolCalls": opencode.total_tool_calls,
                },
            },
        },
        "byModel": by_model,
        "pricingMeta": pricing::pricing_meta_for_models(pricing_load, &by_model_keys),
        "budget": loaded.budget,
        "usageLimits": loaded.usage_limits,
        "codexUsageLimits": codex_usage_limits,
        "dataHealth": loaded.data_health,
        "daily": daily,
        "ledger": ledger,
        "hourlyUsage": serialize_hourly_usage(&hourly_usage, table),
        "activityDays": activity_days,
        "hourlyDistribution": cache.hour_counts.clone().unwrap_or_default(),
        "weekHourMatrix": week_hour_matrix,
        "dailyHourCounts": daily_hour_counts,
        "projects": projects,
        "sessions": loaded.sessions,
        "insights": insights,
        "meta": {
            "generatedAt": iso_ms(now_ms()),
            "cacheVersion": cache.version,
            "lastComputedDate": cache.last_computed_date,
        },
    })
}

// ---------- fingerprint ----------

// "<count>:<newest mtime ms>" as statsFingerprint; the float prints Rust's way, which is fine
// because the string only has to be stable within one process.
pub fn fingerprint(_ctx: &Ctx) -> String {
    let mut count = 0usize;
    let mut newest = 0f64;
    let mut note = |path: &Path| {
        // An absent source counts nothing, so its disappearance still moves `count`.
        if let Ok(meta) = std::fs::metadata(path) {
            newest = newest.max(mtime_ms(&meta).unwrap_or(0.0));
            count += 1;
        }
    };

    let mut trees: Vec<(PathBuf, &str)> = vec![
        (paths::projects_dir(), ".jsonl"),
        (paths::codex_sessions_dir(), ".jsonl"),
    ];
    for root in opencode::open_code_storage_roots() {
        trees.push((root.join("session"), ".json"));
        trees.push((root.join("message"), ".json"));
    }
    for (dir, ext) in trees {
        let mut files = Vec::new();
        dedup::walk_files(&dir, ext, &mut files);
        for file in files {
            note(&file);
        }
    }
    for file in [
        paths::stats_cache(),
        paths::history(),
        paths::codex_state_db(),
        paths::codex_auth(),
        paths::opencode_db(),
        paths::rate_limits_cache(),
        paths::codex_usage_cache(),
        // Not transcripts, but a pricing refresh or a budget edit changes the numbers.
        pricing::override_path(),
        budget_config_path(),
    ] {
        note(&file);
    }
    format!("{count}:{newest}")
}

// refreshPricingOverride's fallback list when the request names no models.
pub fn models_in(stats: &Value) -> Vec<String> {
    stats
        .get("byModel")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("model").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

// ---------- CLI ----------

#[derive(Clone, Copy)]
enum Source {
    Claude,
    Codex,
    Opencode,
    Pricing,
}

fn parse_args(args: &[String]) -> Option<Option<Source>> {
    match args {
        [] => Some(None),
        [flag, name] if flag == "--source" => match name.as_str() {
            "claude" => Some(Some(Source::Claude)),
            "codex" => Some(Some(Source::Codex)),
            "opencode" => Some(Some(Source::Opencode)),
            "pricing" => Some(Some(Source::Pricing)),
            _ => None,
        },
        _ => None,
    }
}

// Each module's source_json owns the whole `--source` shape; this only prints it.
async fn produce(ctx: &Ctx, source: Option<Source>) -> anyhow::Result<serde_json::Value> {
    Ok(match source {
        None => build(ctx).await?,
        Some(Source::Claude) => claude::source_json(ctx, &claude::load(ctx)?),
        Some(Source::Codex) => codex::source_json(
            &codex::load(ctx)?,
            &codex::read_codex_usage_limits(ctx).await,
        ),
        Some(Source::Opencode) => opencode::source_json(&opencode::load(ctx)?),
        Some(Source::Pricing) => pricing::source_json(&pricing::load_pricing_with_meta(ctx).await?),
    })
}

pub fn run_cli(args: &[String]) -> ExitCode {
    let Some(source) = parse_args(args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| {
            let ctx = Ctx::from_env()?;
            runtime.block_on(produce(&ctx, source))
        });
    match result {
        Ok(value) => {
            // JSON.stringify(data, null, 2) with no trailing newline, as api.ts prints it.
            print!(
                "{}",
                serde_json::to_string_pretty(&value).expect("a Value always serializes")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("atlas: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::claude::{History, HistoryProject, StatsCache};
    use crate::atlas::codex::CodexDailyActivity;
    use crate::atlas::model::ProviderUsage;
    use crate::atlas::pricing::{OpenRouterMeta, PricedCounts, PricingMeta, UserOverrideMeta};
    use crate::paths::tests::TestEnv;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn usage(input: i64) -> ModelUsage {
        ModelUsage {
            input_tokens: input,
            ..Default::default()
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn set_mtime(path: &Path, secs: u64) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    fn pricing_load() -> PricingLoad {
        PricingLoad {
            table: serde_json::from_value(json!({
                "models": {"claude-opus-4-7": {"input": 5.0, "output": 25.0, "cacheRead": 0.5, "cacheWrite": 6.25}},
                "fallback": {"input": 3.0, "output": 15.0},
                "externalModelPrefixes": [],
            }))
            .unwrap(),
            meta: PricingMeta {
                defaults_loaded: true,
                open_router: OpenRouterMeta {
                    attempted: false,
                    used: false,
                    error: None,
                },
                user_override: UserOverrideMeta {
                    path: String::new(),
                    loaded: false,
                    error: None,
                },
                models: PricedCounts::default(),
            },
            source_by_model: IndexMap::new(),
        }
    }

    fn limits() -> UsageLimits {
        UsageLimits {
            source: "test".into(),
            path: String::new(),
            captured_at: None,
            stale: true,
            error: None,
            plan: None,
            five_hour: None,
            weekly: None,
        }
    }

    fn counts() -> DataHealthCounts {
        DataHealthCounts {
            claude_transcript_files: 0,
            codex_session_files: 0,
            codex_thread_rows: 0,
            open_code_session_files: 0,
            open_code_message_files: 0,
            open_code_session_rows: 0,
            open_code_message_rows: 0,
        }
    }

    fn loaded(stats_cache: StatsCache) -> Loaded {
        Loaded {
            claude: ClaudeSource {
                usage: ProviderUsage::default(),
                ledger: Vec::new(),
                transcript_file_count: 0,
                stats_cache,
                history: History::default(),
            },
            codex: CodexSource {
                usage: ProviderUsage::default(),
                project_activity: IndexMap::new(),
                daily_activity: IndexMap::new(),
                week_hour_matrix: [[0; 24]; 7],
                daily_hour_counts: IndexMap::new(),
                total_threads: 0,
                total_interactions: 0,
                total_tool_calls: 0,
                ledger: Vec::new(),
                codex_session_file_count: 0,
                codex_thread_row_count: 0,
            },
            opencode: OpenCodeSource {
                usage: ProviderUsage::default(),
                project_activity: IndexMap::new(),
                daily_activity: IndexMap::new(),
                week_hour_matrix: [[0; 24]; 7],
                daily_hour_counts: IndexMap::new(),
                total_sessions: 0,
                total_interactions: 0,
                total_tool_calls: 0,
                ledger: Vec::new(),
                open_code_session_file_count: 0,
                open_code_message_file_count: 0,
                open_code_session_row_count: 0,
                open_code_message_row_count: 0,
            },
            sessions: Vec::new(),
            budget: BudgetMeta {
                monthly_budget_usd: None,
                source: String::new(),
                loaded: false,
                error: None,
            },
            usage_limits: limits(),
            data_health: DataHealth {
                sources: Vec::new(),
                counts: counts(),
            },
        }
    }

    fn day(date: &str, messages: i64, sessions: i64, tools: i64) -> StatsCacheDailyActivity {
        StatsCacheDailyActivity {
            date: date.into(),
            message_count: messages,
            session_count: sessions,
            tool_call_count: tools,
        }
    }

    fn hist(messages: i64, sessions: &[&str]) -> HistoryDay {
        HistoryDay {
            message_count: messages,
            session_ids: sessions.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn by_path(path: &str, models: &[&str]) -> ProjectModelUsage {
        let inner = models.iter().map(|m| (m.to_string(), usage(0))).collect();
        IndexMap::from([(path.to_string(), inner)])
    }

    #[test]
    fn illegal_source_is_rejected_before_any_module() {
        assert!(matches!(parse_args(&args(&[])), Some(None)));
        assert!(matches!(
            parse_args(&args(&["--source", "codex"])),
            Some(Some(Source::Codex))
        ));
        for bad in [&["--source"][..], &["--source", "nope"], &["--bogus"]] {
            assert!(parse_args(&args(bad)).is_none(), "{bad:?}");
            assert_eq!(run_cli(&args(bad)), ExitCode::from(2));
        }
    }

    // project-cost.test.ts: claude costs 1 per model, codex 10, so each sum shows which fn applied.
    #[test]
    fn project_costs_sum_per_model_per_provider() {
        let claude_cost = |_: &str, _: &ModelUsage| 1.0;
        let codex_cost = |_: &str, _: &ModelUsage| 10.0;
        let costs = aggregate_project_costs(
            &by_path("/p1", &["m1", "m2"]),
            &by_path("/p1", &["o3"]),
            claude_cost,
            codex_cost,
        );
        assert_eq!(costs.claude_project_cost["/p1"], 2.0);
        assert_eq!(costs.codex_project_cost["/p1"], 10.0);
        assert_eq!(costs.project_cost["/p1"], 12.0);

        let costs = aggregate_project_costs(
            &by_path("/only-claude", &["m"]),
            &by_path("/only-codex", &["o3"]),
            claude_cost,
            codex_cost,
        );
        assert_eq!(costs.project_cost["/only-claude"], 1.0);
        assert_eq!(costs.project_cost["/only-codex"], 10.0);

        let empty = IndexMap::new();
        let costs = aggregate_project_costs(&empty, &empty, claude_cost, codex_cost);
        assert!(costs.project_cost.is_empty());
    }

    // daily-activity.test.ts
    #[test]
    fn daily_merge_keeps_cache_and_supplements_only_later_history() {
        let cached = [day("2026-05-20", 5, 1, 2)];
        let (by_date, supplemental) =
            merge_daily_activity(&cached, &IndexMap::new(), Some("2026-05-20"));
        let expected = DayActivity {
            message_count: 5,
            session_count: 1,
            tool_call_count: 2,
        };
        assert_eq!(by_date["2026-05-20"], expected);
        assert!(supplemental.is_empty());

        let history = IndexMap::from([
            ("2026-05-19".to_string(), hist(2, &["a"])),
            ("2026-05-20".to_string(), hist(2, &["a"])),
            ("2026-05-21".to_string(), hist(3, &["a", "b"])),
        ]);
        let (by_date, supplemental) = merge_daily_activity(&cached, &history, Some("2026-05-20"));
        assert_eq!(supplemental, ["2026-05-21"]);
        let expected = DayActivity {
            message_count: 3,
            session_count: 2,
            tool_call_count: 0,
        };
        assert_eq!(by_date["2026-05-21"], expected);
        assert!(!by_date.contains_key("2026-05-19"));

        let cached = [day("2026-05-21", 99, 0, 0)];
        let history = IndexMap::from([("2026-05-21".to_string(), hist(1, &["x"]))]);
        let (by_date, supplemental) = merge_daily_activity(&cached, &history, Some("2026-05-20"));
        assert_eq!(by_date["2026-05-21"].message_count, 99);
        assert!(supplemental.is_empty());

        let (_, supplemental) = merge_daily_activity(&[], &history, None);
        assert_eq!(supplemental, ["2026-05-21"]);
    }

    #[test]
    fn data_health_statuses() {
        let _env = TestEnv::new();
        write(&paths::stats_cache(), "{}");
        write(&paths::history(), "");
        std::fs::create_dir_all(paths::sessions_dir()).unwrap();
        write(&paths::projects_dir().join("p/a.jsonl"), "{}\n");
        set_mtime(&paths::stats_cache(), 1_790_856_000);
        let locked = paths::codex_state_db();
        write(&locked, "x");
        let mut perms = std::fs::metadata(&locked).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o000);
        std::fs::set_permissions(&locked, perms).unwrap();

        let health = build_data_health(counts());
        let source = |name: &str| {
            health
                .sources
                .iter()
                .find(|s| s.name == name)
                .unwrap()
                .clone()
        };
        let cache = source("Claude stats cache");
        assert_eq!(cache.status, SourceStatus::Ok);
        assert_eq!(cache.path, "~/.claude/stats-cache.json");
        assert_eq!(
            cache.modified_at.as_deref(),
            Some("2026-10-01T12:00:00.000Z")
        );
        assert_eq!(source("Claude history").status, SourceStatus::Empty);
        assert_eq!(source("Claude sessions").status, SourceStatus::Empty);
        assert_eq!(source("Claude projects").status, SourceStatus::Ok);
        let missing = source("Budget config");
        assert_eq!(missing.status, SourceStatus::Missing);
        assert_eq!(missing.modified_at, None);
        assert_eq!(missing.note, "optional budget");
        // Root reads through mode 000, so assert the denial only where the OS enforces it.
        if readable(&locked).is_err() {
            let state = source("Codex state DB");
            assert_eq!(state.status, SourceStatus::Unreadable);
            assert_eq!(state.modified_at, None);
            assert!(
                state
                    .note
                    .starts_with("EACCES: permission denied, access '")
            );
        }
        assert_eq!(health.sources.len(), 12);
        let json = serde_json::to_value(&health).unwrap();
        assert_eq!(json["counts"]["openCodeMessageRows"], json!(0));
        assert_eq!(json["sources"][11]["modifiedAt"], Value::Null);
    }

    #[test]
    fn budget_config_branches() {
        let _env = TestEnv::new();
        let path = budget_config_path();
        assert_eq!(
            serde_json::to_value(load_budget_config()).unwrap(),
            json!({"monthlyBudgetUSD": null, "source": "~/.config/cc-dashboard/budget.json", "loaded": false, "error": null})
        );
        write(&path, "{not json");
        let corrupt = load_budget_config();
        assert!(!corrupt.loaded);
        assert!(corrupt.error.is_some());
        for bad in [
            r#"{"monthlyBudgetUSD": 0}"#,
            r#"{"monthlyBudgetUSD": "50"}"#,
            "null",
        ] {
            write(&path, bad);
            assert_eq!(
                load_budget_config().error.as_deref(),
                Some("Expected positive numeric monthlyBudgetUSD"),
                "{bad}"
            );
        }
        write(&path, r#"{"monthlyBudgetUSD": 200}"#);
        let ok = serde_json::to_value(load_budget_config()).unwrap();
        assert_eq!(ok["monthlyBudgetUSD"], json!(200));
        assert_eq!(ok["loaded"], json!(true));
    }

    #[test]
    fn is_external_matches_api_test() {
        assert!(is_anthropic_model("claude-opus-4-7"));
        assert!(is_anthropic_model("anthropic/claude-3"));
        assert!(!is_anthropic_model("gpt-4o"));
        assert!(is_external("gpt-4o", &["openai/".into()]));
        assert!(!is_external("claude-opus", &["openai/".into()]));
        assert!(is_external("anthropic/claude-3", &["anthropic/".into()]));
    }

    #[test]
    fn claude_model_usage_falls_back_to_stats_cache_only_when_rollup_is_empty() {
        let _env = TestEnv::new();
        let cache = StatsCache {
            model_usage: Some(IndexMap::from([(
                "claude-opus-4-7".to_string(),
                usage(1_000_000),
            )])),
            ..Default::default()
        };
        let stats = assemble(loaded(cache.clone()), &pricing_load(), limits());
        assert_eq!(models_in(&stats), ["claude:claude-opus-4-7"]);
        assert_eq!(stats["byModel"][0]["costUSD"], json!(5.0));
        assert_eq!(stats["summary"]["estimatedCostUSD"], json!(5.0));

        let mut with_rollup = loaded(cache);
        with_rollup.claude.usage.model_usage =
            IndexMap::from([("claude-sonnet-4-6".to_string(), usage(10))]);
        let stats = assemble(with_rollup, &pricing_load(), limits());
        assert_eq!(models_in(&stats), ["claude:claude-sonnet-4-6"]);
    }

    #[test]
    fn payload_key_order_clock_daily_merge_and_insights() {
        let _env = TestEnv::new();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", "1790856000000");
        let cache = StatsCache {
            daily_activity: Some(vec![day("2026-09-26", 6, 2, 1)]),
            total_sessions: Some(2),
            total_messages: Some(6),
            version: Some(2),
            ..Default::default()
        };
        let mut src = loaded(cache);
        let history = &mut src.claude.history;
        history
            .daily_history
            .insert("2026-09-25".into(), hist(9, &["old"]));
        history
            .daily_history
            .insert("2026-09-27".into(), hist(4, &["a", "b"]));
        history.by_project.insert(
            "/w/proj-a".into(),
            HistoryProject {
                message_count: 3,
                first_seen: 1_790_856_000_000,
                last_seen: 1_790_856_000_000,
                path: "/w/proj-a".into(),
            },
        );
        src.codex.daily_activity.insert(
            "2026-09-26".into(),
            CodexDailyActivity {
                thread_count: 1,
                interaction_count: 3,
                tool_call_count: 2,
            },
        );
        src.codex.total_threads = 1;
        src.codex.total_interactions = 3;
        let stats = assemble(src, &pricing_load(), limits());

        let keys: Vec<&str> = stats
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "period",
                "summary",
                "byModel",
                "pricingMeta",
                "budget",
                "usageLimits",
                "codexUsageLimits",
                "dataHealth",
                "daily",
                "ledger",
                "hourlyUsage",
                "activityDays",
                "hourlyDistribution",
                "weekHourMatrix",
                "dailyHourCounts",
                "projects",
                "sessions",
                "insights",
                "meta",
            ]
        );
        assert_eq!(
            stats["meta"],
            json!({"generatedAt": "2026-10-01T12:00:00.000Z", "cacheVersion": 2, "lastComputedDate": null})
        );
        // History before the cache's last day is dropped; after it, supplemented.
        let dates: Vec<&str> = stats["daily"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["date"].as_str().unwrap())
            .collect();
        assert_eq!(dates, ["2026-09-26", "2026-09-27"]);
        let first = &stats["daily"][0];
        assert_eq!(first["sessions"], json!(3));
        assert_eq!(first["messages"], json!(9));
        assert_eq!(first["toolCalls"], json!(3));
        assert_eq!(first["providers"]["claude"]["sessions"], json!(2));
        assert_eq!(first["providers"]["codex"]["messages"], json!(3));
        assert_eq!(
            stats["period"],
            json!({"from": "2026-09-26", "to": "2026-09-27"})
        );
        assert_eq!(stats["summary"]["totalToolCalls"], json!(3));
        assert_eq!(
            stats["insights"],
            json!({
                "mostActiveDay": "2026-09-26",
                "mostActiveDayMessages": 9,
                "mostUsedModel": null,
                "averageMessagesPerSession": 3.0,
                "mostActiveProject": "proj-a",
                "firstSessionDate": null,
                "longestSession": null,
            })
        );
        assert_eq!(stats["activityDays"][0]["interactions"], json!(9));
    }

    #[test]
    fn average_messages_rounds_to_one_decimal() {
        let _env = TestEnv::new();
        let cache = StatsCache {
            total_sessions: Some(3),
            total_messages: Some(10),
            ..Default::default()
        };
        let stats = assemble(loaded(cache), &pricing_load(), limits());
        assert_eq!(stats["insights"]["averageMessagesPerSession"], json!(3.3));
    }

    #[test]
    fn fingerprint_moves_exactly_with_watched_files() {
        let env = TestEnv::new();
        TestEnv::set("COCKPIT_OPENCODE_DB", env.dir.path().join("oc/opencode.db"));
        let ctx = Ctx {
            now_ms: 0,
            plugin_root: PathBuf::new(),
        };
        let budget = budget_config_path();
        let rate_limits = paths::rate_limits_cache();
        write(&budget, "{}");
        write(&rate_limits, "{}");
        set_mtime(&budget, 1_000);
        set_mtime(&rate_limits, 1_000);
        let base = fingerprint(&ctx);
        assert_eq!(base, "2:1000000");
        assert_eq!(fingerprint(&ctx), base);

        write(&paths::projects_dir().join("p/notes.txt"), "x");
        write(
            &env.dir.path().join(".config/cc-dashboard/other.json"),
            "{}",
        );
        write(&paths::opencode_storage_dir().join("session/x.txt"), "x");
        assert_eq!(fingerprint(&ctx), base, "unrelated files must not move it");

        set_mtime(&budget, 2_000);
        let touched = fingerprint(&ctx);
        assert_ne!(touched, base);

        let transcript = paths::projects_dir().join("p/s.jsonl");
        write(&transcript, "{}\n");
        set_mtime(&transcript, 1_500);
        let added = fingerprint(&ctx);
        assert_ne!(added, touched);

        std::fs::remove_file(&rate_limits).unwrap();
        let deleted = fingerprint(&ctx);
        assert_ne!(deleted, added);

        let session = paths::opencode_storage_dir().join("session/s.json");
        write(&session, "{}");
        set_mtime(&session, 1_500);
        assert_ne!(fingerprint(&ctx), deleted);
    }

    #[test]
    fn models_in_reads_by_model_in_order() {
        let stats = json!({"byModel": [{"model": "codex:gpt-5"}, {"model": "claude:x"}]});
        assert_eq!(models_in(&stats), ["codex:gpt-5", "claude:x"]);
        assert!(models_in(&json!({})).is_empty());
    }
}
