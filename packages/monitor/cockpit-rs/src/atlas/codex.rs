// Port of codex-cache.ts plus api.ts's Codex source (parseCodexUsage) and Codex usage limits.
use super::dedup::walk_files;
use super::jsonl::read_jsonl_lines;
use super::model::{
    Ctx, FIVE_HOUR_MS, InternalLedgerRow, LedgerCostBasis, ModelUsage, Provider, ProviderUsage,
    RATE_LIMITS_STALE_AFTER_MS, SEVEN_DAY_MS, UsageLimitWindow, UsageLimits, add_hourly_usage,
    add_model_usage, add_nested_model_usage, build_usage_limit_window, coerce_number, display_path,
    empty_model_usage, fmt_date, iso_ms, js_date_parse, ledger_project_name, model_key,
    model_usage_total, now_ms,
};
use super::paths;
use super::rollup_db::open_sqlite_file;
use crate::server::opencode::js_truthy;
use indexmap::{IndexMap, IndexSet};
use jiff::{Timestamp, tz::TimeZone};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Duration;

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/codex/usage";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
// Anything longer than a day is a weekly Codex window; see build_codex_usage_limits.
const CODEX_WEEKLY_MIN_MS: i64 = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(4);
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const THREADS_SQL: &str =
    "select id, rollout_path, created_at, updated_at, cwd, title, model, tokens_used
from threads
where tokens_used > 0 or rollout_path != ''
order by created_at asc";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProjectActivity {
    pub thread_count: i64,
    pub interaction_count: i64,
    pub tool_call_count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDailyActivity {
    pub thread_count: i64,
    pub interaction_count: i64,
    pub tool_call_count: i64,
}

pub struct CodexSource {
    pub usage: ProviderUsage,
    pub project_activity: IndexMap<String, CodexProjectActivity>,
    pub daily_activity: IndexMap<String, CodexDailyActivity>,
    pub week_hour_matrix: [[i64; 24]; 7],
    pub daily_hour_counts: IndexMap<String, [i64; 24]>,
    pub total_threads: usize,
    pub total_interactions: i64,
    pub total_tool_calls: i64,
    pub ledger: Vec<InternalLedgerRow>,
    pub codex_session_file_count: usize,
    pub codex_thread_row_count: usize,
}

// ---------- Rollout summaries (readCodexSession) ----------

// Snake_case on purpose: the TS caches the rollout's own total_token_usage object verbatim.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct CodexTokenUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cached_input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_tokens: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexTokenEvent {
    timestamp_ms: i64,
    usage: CodexTokenUsage,
}

// Stored as JSON in codex-sessions.db, which a TS dashboard shares: keep JSON.stringify's shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexSessionSummary {
    id: Option<String>,
    timestamp_ms: i64,
    cwd: String,
    model: Option<String>,
    token_usage: Option<CodexTokenUsage>,
    token_events: Vec<CodexTokenEvent>,
    user_messages: i64,
    tool_calls: i64,
}

fn json_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|n| n as i64))
}

// A truthy non-object reads as every field undefined, which the TS arithmetic treats as 0.
fn token_usage_from(value: &Value) -> CodexTokenUsage {
    let field = |name: &str| value.get(name).and_then(json_i64);
    CodexTokenUsage {
        input_tokens: field("input_tokens"),
        cached_input_tokens: field("cached_input_tokens"),
        output_tokens: field("output_tokens"),
        reasoning_output_tokens: field("reasoning_output_tokens"),
        total_tokens: field("total_tokens"),
    }
}

fn read_codex_session(file: &Path) -> Option<CodexSessionSummary> {
    // Only a missing file is null; any other read error yields zero lines.
    if !file.exists() {
        return None;
    }
    let mut latest: Option<CodexTokenUsage> = None;
    let mut id: Option<String> = None;
    let mut timestamp_ms = 0;
    let mut cwd = String::new();
    let mut model: Option<String> = None;
    let mut response_user_messages = 0;
    let mut event_user_messages = 0;
    let mut tool_calls = 0;
    let mut token_events = Vec::new();
    for line in read_jsonl_lines(file, Default::default()) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry_timestamp = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .filter(|ts| !ts.is_empty());
        if timestamp_ms == 0
            && let Some(parsed) = entry_timestamp.and_then(js_date_parse)
        {
            timestamp_ms = parsed;
        }
        let payload = entry.get("payload");
        let payload_str = |key: &str| {
            payload
                .and_then(|payload| payload.get(key))
                .and_then(Value::as_str)
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                id = payload_str("id").map(String::from).or(id);
                cwd = payload_str("cwd").map(String::from).unwrap_or(cwd);
                model = payload_str("model").map(String::from).or(model);
                if timestamp_ms == 0
                    && let Some(parsed) = payload_str("timestamp")
                        .filter(|ts| !ts.is_empty())
                        .and_then(js_date_parse)
                {
                    timestamp_ms = parsed;
                }
            }
            Some("turn_context") => {
                cwd = payload_str("cwd").map(String::from).unwrap_or(cwd);
                model = payload_str("model").map(String::from).or(model);
            }
            Some("response_item") => match payload_str("type") {
                Some("function_call") => tool_calls += 1,
                Some("message") if payload_str("role") == Some("user") => {
                    response_user_messages += 1;
                }
                _ => {}
            },
            Some("event_msg") => match payload_str("type") {
                Some("user_message") => event_user_messages += 1,
                Some("token_count") => {
                    let total = payload
                        .and_then(|payload| payload.get("info"))
                        .and_then(|info| info.get("total_token_usage"))
                        .filter(|total| js_truthy(total));
                    if let Some(total) = total {
                        let usage = token_usage_from(total);
                        let event_ms = entry_timestamp.map_or(Some(0), js_date_parse);
                        if let Some(event_ms) = event_ms.filter(|&ms| ms != 0) {
                            token_events.push(CodexTokenEvent {
                                timestamp_ms: event_ms,
                                usage: usage.clone(),
                            });
                        }
                        latest = Some(usage);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    Some(CodexSessionSummary {
        id,
        timestamp_ms,
        cwd,
        model,
        token_usage: latest,
        token_events,
        user_messages: response_user_messages.max(event_user_messages),
        tool_calls,
    })
}

fn codex_usage_from_token_usage(usage: &CodexTokenUsage) -> ModelUsage {
    let cached_input = usage.cached_input_tokens.unwrap_or(0);
    ModelUsage {
        input_tokens: 0.max(usage.input_tokens.unwrap_or(0) - cached_input),
        output_tokens: usage.output_tokens.unwrap_or(0),
        cache_read_input_tokens: cached_input,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: Some(usage.reasoning_output_tokens.unwrap_or(0)),
        ..Default::default()
    }
}

fn codex_token_usage_delta(
    current: &CodexTokenUsage,
    previous: Option<&CodexTokenUsage>,
) -> CodexTokenUsage {
    let Some(previous) = previous else {
        return current.clone();
    };
    let delta =
        |cur: Option<i64>, prev: Option<i64>| Some(0.max(cur.unwrap_or(0) - prev.unwrap_or(0)));
    CodexTokenUsage {
        input_tokens: delta(current.input_tokens, previous.input_tokens),
        cached_input_tokens: delta(current.cached_input_tokens, previous.cached_input_tokens),
        output_tokens: delta(current.output_tokens, previous.output_tokens),
        reasoning_output_tokens: delta(
            current.reasoning_output_tokens,
            previous.reasoning_output_tokens,
        ),
        total_tokens: delta(current.total_tokens, previous.total_tokens),
    }
}

fn codex_usage_from_thread(tokens_used: i64, session: Option<&CodexSessionSummary>) -> ModelUsage {
    match session.and_then(|session| session.token_usage.as_ref()) {
        Some(usage) => codex_usage_from_token_usage(usage),
        None => ModelUsage {
            input_tokens: tokens_used,
            reasoning_output_tokens: Some(0),
            ..Default::default()
        },
    }
}

// ---------- Summary cache (codex-cache.ts) ----------

fn open_codex_cache(path: &Path) -> anyhow::Result<Connection> {
    let conn = open_sqlite_file(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_summary (
          path     TEXT PRIMARY KEY,
          size     INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          summary  TEXT NOT NULL
        );",
    )?;
    Ok(conn)
}

type Summaries = IndexMap<String, Option<CodexSessionSummary>>;

// One bulk read and one write transaction rather than a query per file: the cold path writes ~2,000 rows.
fn summarise_sessions(
    db: &mut Connection,
    files: &IndexSet<String>,
    compute: impl Fn(&Path) -> Option<CodexSessionSummary>,
) -> anyhow::Result<Summaries> {
    let mut cached: IndexMap<String, (i64, i64, String)> = IndexMap::new();
    {
        let mut stmt = db.prepare("SELECT path, size, mtime_ms, summary FROM session_summary")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?, row.get(3)?)))
        })?;
        for row in rows {
            let (path, entry) = row?;
            cached.insert(path, entry);
        }
    }

    let mut out = Summaries::new();
    let mut writes: Vec<(String, i64, i64, String)> = Vec::new();
    for file in files {
        let Ok(meta) = std::fs::metadata(file) else {
            out.insert(file.clone(), compute(Path::new(file)));
            continue;
        };
        let size = meta.len() as i64;
        // Math.floor(mtimeMs): nsec is never negative, so integer division floors.
        let mtime_ms = meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000;

        if let Some((row_size, row_mtime, summary)) = cached.get(file)
            && *row_size == size
            && *row_mtime == mtime_ms
            && let Ok(summary) = serde_json::from_str::<Option<CodexSessionSummary>>(summary)
        {
            out.insert(file.clone(), summary);
            continue;
        }

        // A null summary is cached too; re-reading an unreadable file every load is the cost avoided.
        let summary = compute(Path::new(file));
        let text = serde_json::to_string(&summary)?;
        out.insert(file.clone(), summary);
        writes.push((file.clone(), size, mtime_ms, text));
    }

    if !writes.is_empty() {
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO session_summary (path, size, mtime_ms, summary)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET
                   size = excluded.size,
                   mtime_ms = excluded.mtime_ms,
                   summary = excluded.summary",
            )?;
            for (path, size, mtime_ms, summary) in &writes {
                insert.execute(params![path, size, mtime_ms, summary])?;
            }
        }
        tx.commit()?;
    }

    prune_cache(db, &out)?;
    Ok(out)
}

// Prunes by this run's file set, not by existence: a rollout that left the set goes even if on disk.
fn prune_cache(db: &mut Connection, present: &Summaries) -> anyhow::Result<()> {
    let known: Vec<String> = db
        .prepare("SELECT path FROM session_summary")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let gone: Vec<&String> = known
        .iter()
        .filter(|path| !present.contains_key(*path))
        .collect();
    if gone.is_empty() {
        return Ok(());
    }
    let tx = db.transaction()?;
    {
        let mut del = tx.prepare("DELETE FROM session_summary WHERE path = ?")?;
        for path in gone {
            del.execute([path])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------- Aggregation (parseCodexUsage) ----------

struct CodexThreadRow {
    id: Option<String>,
    rollout_path: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    cwd: Option<String>,
    model: Option<String>,
    tokens_used: Option<i64>,
}

fn query_thread_rows(path: &Path) -> rusqlite::Result<Vec<CodexThreadRow>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare(THREADS_SQL)?;
    let rows = stmt.query_map([], |row| {
        Ok(CodexThreadRow {
            id: row.get(0)?,
            rollout_path: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            cwd: row.get(4)?,
            model: row.get(6)?,
            tokens_used: row.get(7)?,
        })
    })?;
    rows.collect()
}

// Any open or query failure is zero rows, as the TS `catch { rows = [] }`.
fn read_thread_rows() -> Vec<CodexThreadRow> {
    let path = paths::codex_state_db();
    if !path.exists() {
        return Vec::new();
    }
    query_thread_rows(&path).unwrap_or_default()
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

// JS `x || y` on numbers: 0 falls through.
fn or_nonzero(value: i64, fallback: impl FnOnce() -> i64) -> i64 {
    if value != 0 { value } else { fallback() }
}

// [getDay()][getHours()] in local time.
fn local_day_hour(ms: i64) -> Option<(usize, usize)> {
    let zoned = Timestamp::from_millisecond(ms)
        .ok()?
        .to_zoned(TimeZone::system());
    Some((
        zoned.weekday().to_sunday_zero_offset() as usize,
        zoned.hour() as usize,
    ))
}

pub fn load(_ctx: &Ctx) -> anyhow::Result<CodexSource> {
    let rows = read_thread_rows();
    // A JS Map built from the rows: a repeated rollout_path keeps the last row.
    let mut row_by_rollout: IndexMap<&str, &CodexThreadRow> = IndexMap::new();
    for row in &rows {
        if let Some(path) = row.rollout_path.as_deref() {
            row_by_rollout.insert(path, row);
        }
    }
    let mut walked = Vec::new();
    walk_files(&paths::codex_sessions_dir(), ".jsonl", &mut walked);
    let mut session_files: IndexSet<String> = rows
        .iter()
        .filter_map(|row| non_empty(row.rollout_path.as_deref()).map(String::from))
        .collect();
    session_files.extend(
        walked
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );

    // Summaries come from the cache where the rollout is unchanged; without it every build
    // re-read every rollout in full. Any cache failure computes every summary directly.
    let summaries = open_codex_cache(&paths::codex_cache_path())
        .and_then(|mut cache| summarise_sessions(&mut cache, &session_files, read_codex_session))
        .unwrap_or_else(|_| {
            session_files
                .iter()
                .map(|file| (file.clone(), read_codex_session(Path::new(file))))
                .collect()
        });

    let mut usage = ProviderUsage::default();
    let mut project_activity: IndexMap<String, CodexProjectActivity> = IndexMap::new();
    let mut daily_activity: IndexMap<String, CodexDailyActivity> = IndexMap::new();
    let mut week_hour_matrix = [[0i64; 24]; 7];
    let mut daily_hour_counts: IndexMap<String, [i64; 24]> = IndexMap::new();
    let mut ledger = Vec::new();
    let mut total_interactions = 0;
    let mut total_tool_calls = 0;

    for file in &session_files {
        let row = row_by_rollout.get(file.as_str()).copied();
        let session = summaries.get(file).and_then(Option::as_ref);
        let model = non_empty(row.and_then(|row| row.model.as_deref()))
            .or_else(|| non_empty(session.and_then(|s| s.model.as_deref())))
            .unwrap_or("unknown");
        let key = model_key(Provider::Codex, model);
        let row_tokens = row.and_then(|row| row.tokens_used).unwrap_or(0);
        let thread_usage = codex_usage_from_thread(row_tokens, session);
        let token_total = or_nonzero(row_tokens, || model_usage_total(&thread_usage));
        let created_ms = match row.and_then(|row| row.created_at).filter(|&s| s != 0) {
            Some(seconds) => seconds * 1000,
            None => session.map_or(0, |s| s.timestamp_ms),
        };
        let updated_ms = row
            .and_then(|row| row.updated_at)
            .filter(|&s| s != 0)
            .map_or(created_ms, |seconds| seconds * 1000);
        if created_ms == 0 {
            continue;
        }
        let cwd = non_empty(row.and_then(|row| row.cwd.as_deref()))
            .or_else(|| non_empty(session.map(|s| s.cwd.as_str())))
            .unwrap_or("");
        let interaction_count = or_nonzero(session.map_or(0, |s| s.user_messages), || 1);
        let tool_call_count = session.map_or(0, |s| s.tool_calls);
        let date = fmt_date(created_ms);
        total_interactions += interaction_count;
        total_tool_calls += tool_call_count;

        add_model_usage(
            usage
                .model_usage
                .entry(key.clone())
                .or_insert_with(empty_model_usage),
            &thread_usage,
        );
        match session.filter(|s| !s.token_events.is_empty()) {
            Some(session) => {
                let mut previous: Option<&CodexTokenUsage> = None;
                for event in &session.token_events {
                    let delta = codex_token_usage_delta(&event.usage, previous);
                    previous = Some(&event.usage);
                    add_hourly_usage(
                        &mut usage.hourly_usage,
                        event.timestamp_ms,
                        &key,
                        &codex_usage_from_token_usage(&delta),
                    );
                }
            }
            None => add_hourly_usage(
                &mut usage.hourly_usage,
                or_nonzero(updated_ms, || created_ms),
                &key,
                &thread_usage,
            ),
        }

        add_nested_model_usage(&mut usage.daily_model_usage, &date, &key, &thread_usage);

        if !cwd.is_empty() {
            *usage.project_tokens.entry(cwd.to_owned()).or_insert(0) += token_total;
            add_nested_model_usage(&mut usage.project_model_usage, cwd, &key, &thread_usage);
            project_activity
                .entry(cwd.to_owned())
                .and_modify(|current| {
                    current.thread_count += 1;
                    current.interaction_count += interaction_count;
                    current.tool_call_count += tool_call_count;
                    current.first_seen = current.first_seen.min(created_ms);
                    current.last_seen = current.last_seen.max(updated_ms);
                })
                .or_insert_with(|| CodexProjectActivity {
                    thread_count: 1,
                    interaction_count,
                    tool_call_count,
                    first_seen: created_ms,
                    last_seen: updated_ms,
                    path: cwd.to_owned(),
                });
        }

        let daily = daily_activity.entry(date.clone()).or_default();
        daily.thread_count += 1;
        daily.interaction_count += interaction_count;
        daily.tool_call_count += tool_call_count;
        if let Some((day, hour)) = local_day_hour(created_ms) {
            week_hour_matrix[day][hour] += interaction_count;
            daily_hour_counts.entry(date).or_insert([0; 24])[hour] += interaction_count;
        }

        let timestamp_ms = or_nonzero(updated_ms, || created_ms);
        let id = row
            .and_then(|row| row.id.as_deref())
            .or_else(|| session.and_then(|s| s.id.as_deref()))
            .unwrap_or(file);
        ledger.push(InternalLedgerRow {
            id: format!("codex:{id}"),
            provider: Provider::Codex,
            timestamp_ms,
            date: fmt_date(timestamp_ms),
            project_path: cwd.to_owned(),
            project_name: ledger_project_name(cwd),
            model: key.clone(),
            interactions: interaction_count,
            tool_calls: tool_call_count,
            tokens: token_total,
            cost_basis: if session.is_some_and(|s| s.token_usage.is_some()) {
                LedgerCostBasis::Usage
            } else if row_tokens != 0 {
                LedgerCostBasis::ThreadTokens
            } else {
                LedgerCostBasis::Unavailable
            },
            usage_by_model: IndexMap::from([(key, thread_usage)]),
        });
    }

    // Threads with no rollout bill from the row alone and touch no activity counter or total.
    for row in &rows {
        if non_empty(row.rollout_path.as_deref()).is_some() {
            continue;
        }
        let model = non_empty(row.model.as_deref()).unwrap_or("unknown");
        let key = model_key(Provider::Codex, model);
        let tokens_used = row.tokens_used.unwrap_or(0);
        let thread_usage = codex_usage_from_thread(tokens_used, None);
        let timestamp_ms =
            or_nonzero(row.updated_at.unwrap_or(0), || row.created_at.unwrap_or(0)) * 1000;
        if timestamp_ms == 0 {
            continue;
        }
        add_hourly_usage(&mut usage.hourly_usage, timestamp_ms, &key, &thread_usage);
        add_model_usage(
            usage
                .model_usage
                .entry(key.clone())
                .or_insert_with(empty_model_usage),
            &thread_usage,
        );
        let date = fmt_date(timestamp_ms);
        add_nested_model_usage(&mut usage.daily_model_usage, &date, &key, &thread_usage);
        let cwd = row.cwd.as_deref().unwrap_or("");
        if !cwd.is_empty() {
            let token_total = or_nonzero(tokens_used, || model_usage_total(&thread_usage));
            *usage.project_tokens.entry(cwd.to_owned()).or_insert(0) += token_total;
            add_nested_model_usage(&mut usage.project_model_usage, cwd, &key, &thread_usage);
        }
        ledger.push(InternalLedgerRow {
            // Template-literal interpolation of a null id.
            id: format!("codex:{}", row.id.as_deref().unwrap_or("null")),
            provider: Provider::Codex,
            timestamp_ms,
            date,
            project_path: cwd.to_owned(),
            project_name: ledger_project_name(cwd),
            model: key.clone(),
            interactions: 1,
            tool_calls: 0,
            tokens: tokens_used,
            cost_basis: if tokens_used != 0 {
                LedgerCostBasis::ThreadTokens
            } else {
                LedgerCostBasis::Unavailable
            },
            usage_by_model: IndexMap::from([(key, thread_usage)]),
        });
    }

    Ok(CodexSource {
        usage,
        project_activity,
        daily_activity,
        week_hour_matrix,
        daily_hour_counts,
        total_threads: session_files.len(),
        total_interactions,
        total_tool_calls,
        ledger,
        codex_session_file_count: walked.len(),
        codex_thread_row_count: rows.len(),
    })
}

// ---------- Usage limits ----------

enum JsonRead {
    Missing,
    Error(String),
    Data(Value),
}

// Node's error wording for the two read failures a user can cause; the rest keep the OS text.
fn io_message(error: &std::io::Error, syscall: &str, path: &Path) -> String {
    match error.kind() {
        std::io::ErrorKind::IsADirectory => {
            "EISDIR: illegal operation on a directory, read".to_owned()
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, {syscall} '{}'", path.display())
        }
        _ => error.to_string(),
    }
}

// Bun's JSON.parse wording for the common failures; rarer syntax errors keep its generic line.
fn json_parse_message(text: &str) -> String {
    let body = text.trim_start_matches([' ', '\t', '\n', '\r']);
    let word: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    let identifier = body.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && !["true", "false", "null"].contains(&word.as_str());
    let detail = if body.is_empty() {
        "Unexpected EOF".to_owned()
    } else if identifier {
        format!("Unexpected identifier \"{word}\"")
    } else {
        "Unable to parse JSON string".to_owned()
    };
    format!("JSON Parse error: {detail}")
}

// Private copy of api.ts readJSONWithError: model.rs, the shared home, is outside this task.
fn read_json_with_error(path: &Path) -> JsonRead {
    if !path.exists() {
        return JsonRead::Missing;
    }
    let text = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) => return JsonRead::Error(io_message(&error, "open", path)),
    };
    match serde_json::from_str(&text) {
        Ok(value) => JsonRead::Data(value),
        Err(_) => JsonRead::Error(json_parse_message(&text)),
    }
}

fn codex_usage_base(error: Option<String>) -> UsageLimits {
    UsageLimits {
        source: "codex-api".to_owned(),
        path: display_path(&paths::codex_usage_cache()),
        captured_at: None,
        stale: true,
        error,
        plan: Some(None),
        five_hour: None,
        weekly: None,
    }
}

fn build_codex_usage_limits(
    usage: Option<&Value>,
    captured_at: Option<String>,
    captured_at_ms: f64,
    error: Option<String>,
    now_ms: i64,
) -> UsageLimits {
    let rate_limit = usage.and_then(|usage| usage.get("rate_limit"));
    let bucket = |name: &str| {
        rate_limit
            .and_then(|limits| limits.get(name))
            .filter(|bucket| js_truthy(bucket))
    };
    let primary = bucket("primary_window");
    let secondary = bucket("secondary_window");
    let next_error = error.or_else(|| {
        (primary.is_none() && secondary.is_none()).then(|| "missing-rate-limits".to_owned())
    });

    // Slot each bucket by the window length the API reports, not by the field it arrived in:
    // OpenAI dropped Codex's 5-hour limit, so primary_window can carry the weekly window alone.
    let mut five_hour: Option<UsageLimitWindow> = None;
    let mut weekly: Option<UsageLimitWindow> = None;
    for (bucket, fallback_duration_ms) in [(primary, FIVE_HOUR_MS), (secondary, SEVEN_DAY_MS)] {
        let Some(bucket) = bucket else {
            continue;
        };
        let duration_ms = bucket
            .get("limit_window_seconds")
            .and_then(coerce_number)
            .map_or(fallback_duration_ms, |seconds| (seconds * 1000.0) as i64);
        let field = |name: &str| bucket.get(name).cloned().unwrap_or(Value::Null);
        let window = build_usage_limit_window(
            Some(&json!({
                "used_percentage": field("used_percent"),
                "resets_at": field("reset_at"),
            })),
            duration_ms,
            now_ms,
        );
        let slot = if duration_ms >= CODEX_WEEKLY_MIN_MS {
            &mut weekly
        } else {
            &mut five_hour
        };
        if slot.is_none() {
            *slot = window;
        }
    }

    UsageLimits {
        captured_at,
        stale: !captured_at_ms.is_finite()
            || now_ms as f64 - captured_at_ms > RATE_LIMITS_STALE_AFTER_MS,
        plan: Some(
            usage
                .and_then(|usage| usage.get("plan_type"))
                .and_then(Value::as_str)
                .map(String::from),
        ),
        five_hour,
        weekly,
        ..codex_usage_base(next_error)
    }
}

// Bun's fetch wording, so a mixed fleet reports the same error text.
fn fetch_error_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The operation timed out.".to_owned()
    } else if error.is_connect() {
        "Unable to connect. Is the computer able to access the url?".to_owned()
    } else {
        error.to_string()
    }
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let text = response
        .text()
        .await
        .map_err(|error| fetch_error_message(&error))?;
    serde_json::from_str(&text).map_err(|_| json_parse_message(&text))
}

async fn refresh_codex_access_token(
    client: &reqwest::Client,
    token_url: &str,
    auth: &Value,
) -> Result<String, String> {
    let refresh_token = auth
        .get("tokens")
        .and_then(|tokens| tokens.get("refresh_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or("missing-refresh-token")?;
    let response = client
        .post(token_url)
        .timeout(FETCH_TIMEOUT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CODEX_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|error| fetch_error_message(&error))?;
    if !response.status().is_success() {
        return Err(format!("refresh-http-{}", response.status().as_u16()));
    }
    response_json(response)
        .await?
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(String::from)
        .ok_or_else(|| "missing-refreshed-access-token".to_owned())
}

async fn fetch_codex_usage_with_token(
    client: &reqwest::Client,
    usage_url: &str,
    access_token: &str,
    account_id: &str,
) -> Result<Value, String> {
    let response = client
        .get(usage_url)
        .timeout(FETCH_TIMEOUT)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
        .header("chatgpt-account-id", account_id)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|error| fetch_error_message(&error))?;
    if !response.status().is_success() {
        return Err(format!("http-{}", response.status().as_u16()));
    }
    response_json(response).await
}

async fn fetch_codex_usage(usage_url: &str, token_url: &str) -> Result<Value, String> {
    let auth = match read_json_with_error(&paths::codex_auth()) {
        JsonRead::Missing => return Err("missing-auth".to_owned()),
        JsonRead::Error(error) => return Err(error),
        JsonRead::Data(auth) if !js_truthy(&auth) => return Err("unreadable-auth".to_owned()),
        JsonRead::Data(auth) => auth,
    };
    let tokens = auth.get("tokens");
    let access_token = tokens
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or("missing-access-token")?;
    let account_id = tokens
        .and_then(|tokens| tokens.get("account_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())?;

    match fetch_codex_usage_with_token(&client, usage_url, access_token, account_id).await {
        // Refresh only when the usage call was refused for auth; every other failure surfaces as-is.
        Err(message) if message.contains("http-401") || message.contains("http-403") => {
            // Never written back to auth.json: the TS never does, and the file is the Codex CLI's.
            let refreshed = refresh_codex_access_token(&client, token_url, &auth).await?;
            fetch_codex_usage_with_token(&client, usage_url, &refreshed, account_id).await
        }
        other => other,
    }
}

fn read_codex_usage_cache() -> UsageLimits {
    let cache = match read_json_with_error(&paths::codex_usage_cache()) {
        JsonRead::Missing => return codex_usage_base(Some("missing".to_owned())),
        JsonRead::Error(error) => return codex_usage_base(Some(error)),
        JsonRead::Data(cache) if !js_truthy(&cache) => {
            return codex_usage_base(Some("unreadable".to_owned()));
        }
        JsonRead::Data(cache) => cache,
    };
    let captured_at = cache.get("capturedAt");
    // `capturedAtEpochMs ?? Date.parse(capturedAt)`; a non-number fails Number.isFinite as NaN does.
    let captured_at_ms = match cache.get("capturedAtEpochMs").filter(|ms| !ms.is_null()) {
        Some(ms) => ms.as_f64().unwrap_or(f64::NAN),
        None => captured_at
            .filter(|at| js_truthy(at))
            .and_then(Value::as_str)
            .and_then(js_date_parse)
            .map_or(f64::NAN, |ms| ms as f64),
    };
    build_codex_usage_limits(
        cache.get("usage"),
        captured_at.and_then(Value::as_str).map(String::from),
        captured_at_ms,
        None,
        now_ms(),
    )
}

fn env_url(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

pub async fn read_codex_usage_limits(_ctx: &Ctx) -> UsageLimits {
    read_codex_usage_limits_from(
        &env_url("TOKEN_ATLAS_CODEX_USAGE_URL", CODEX_USAGE_URL),
        &env_url("TOKEN_ATLAS_CODEX_TOKEN_URL", CODEX_TOKEN_URL),
    )
    .await
}

fn write_codex_usage_cache(cache: &Value) -> Result<(), String> {
    let dir = paths::token_atlas_cache_dir();
    std::fs::create_dir_all(&dir).map_err(|error| io_message(&error, "mkdir", &dir))?;
    let path = paths::codex_usage_cache();
    let text = serde_json::to_string_pretty(cache).map_err(|error| error.to_string())?;
    std::fs::write(&path, format!("{text}\n")).map_err(|error| io_message(&error, "open", &path))
}

async fn read_codex_usage_limits_from(usage_url: &str, token_url: &str) -> UsageLimits {
    let cached = read_codex_usage_cache();
    if !cached.stale && cached.error.is_none() {
        return cached;
    }

    let fetched = async {
        let usage = fetch_codex_usage(usage_url, token_url).await?;
        let captured_at_epoch_ms = now_ms();
        let captured_at = iso_ms(captured_at_epoch_ms);
        write_codex_usage_cache(&json!({
            "capturedAt": captured_at,
            "capturedAtEpochMs": captured_at_epoch_ms,
            "usage": usage,
        }))?;
        Ok::<_, String>(build_codex_usage_limits(
            Some(&usage),
            captured_at,
            captured_at_epoch_ms as f64,
            None,
            captured_at_epoch_ms,
        ))
    }
    .await;

    match fetched {
        Ok(limits) => limits,
        Err(error)
            if cached
                .captured_at
                .as_deref()
                .is_some_and(|at| !at.is_empty()) =>
        {
            UsageLimits {
                stale: true,
                error: Some(error),
                ..cached
            }
        }
        Err(error) => codex_usage_base(Some(error)),
    }
}

/// The full `--source codex` shape: `{usage, usageLimits}`.
pub fn source_json(src: &CodexSource, limits: &UsageLimits) -> serde_json::Value {
    json!({
        "usage": {
            "modelUsage": src.usage.model_usage,
            "dailyModelUsage": src.usage.daily_model_usage,
            "hourlyUsage": src.usage.hourly_usage,
            "projectTokens": src.usage.project_tokens,
            "projectModelUsage": src.usage.project_model_usage,
            "projectActivity": src.project_activity,
            "dailyActivity": src.daily_activity,
            "weekHourMatrix": src.week_hour_matrix,
            "dailyHourCounts": src.daily_hour_counts,
            "totalThreads": src.total_threads,
            "totalInteractions": src.total_interactions,
            "totalToolCalls": src.total_tool_calls,
            "ledger": src.ledger,
            "codexSessionFileCount": src.codex_session_file_count,
            "codexThreadRowCount": src.codex_thread_row_count,
        },
        "usageLimits": limits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    const NOW: i64 = 1_790_870_400_000;

    fn totals(input: i64, cached: i64, output: i64, reasoning: i64) -> CodexTokenUsage {
        CodexTokenUsage {
            input_tokens: Some(input),
            cached_input_tokens: Some(cached),
            output_tokens: Some(output),
            reasoning_output_tokens: Some(reasoning),
            total_tokens: Some(input + output),
        }
    }

    #[test]
    fn token_delta_takes_first_event_whole_and_clamps_negatives() {
        let first = totals(8000, 5000, 900, 300);
        assert_eq!(codex_token_usage_delta(&first, None), first);
        let partial = CodexTokenUsage {
            input_tokens: Some(10),
            ..Default::default()
        };
        assert_eq!(codex_token_usage_delta(&partial, None), partial);

        let second = totals(15000, 11000, 2100, 700);
        assert_eq!(
            codex_token_usage_delta(&second, Some(&first)),
            totals(7000, 6000, 1200, 400)
        );
        // A counter that went backwards clamps to 0; a missing field counts as 0.
        let shrunk = CodexTokenUsage {
            input_tokens: Some(100),
            cached_input_tokens: None,
            ..Default::default()
        };
        assert_eq!(
            codex_token_usage_delta(&shrunk, Some(&first)),
            CodexTokenUsage {
                input_tokens: Some(0),
                cached_input_tokens: Some(0),
                output_tokens: Some(0),
                reasoning_output_tokens: Some(0),
                total_tokens: Some(0),
            }
        );
    }

    #[test]
    fn token_usage_subtracts_cached_input_and_clamps() {
        let usage = codex_usage_from_token_usage(&totals(7000, 6000, 1200, 400));
        assert_eq!(
            usage,
            ModelUsage {
                input_tokens: 1000,
                output_tokens: 1200,
                cache_read_input_tokens: 6000,
                cache_creation_input_tokens: 0,
                reasoning_output_tokens: Some(400),
                ..Default::default()
            }
        );
        let over_cached = codex_usage_from_token_usage(&totals(10, 50, 0, 0));
        assert_eq!(over_cached.input_tokens, 0);
        assert_eq!(over_cached.cache_read_input_tokens, 50);
        assert_eq!(
            codex_usage_from_token_usage(&CodexTokenUsage::default()),
            ModelUsage {
                reasoning_output_tokens: Some(0),
                ..Default::default()
            }
        );
    }

    fn summary(token_usage: Option<CodexTokenUsage>) -> CodexSessionSummary {
        CodexSessionSummary {
            id: None,
            timestamp_ms: 0,
            cwd: String::new(),
            model: None,
            token_usage,
            token_events: Vec::new(),
            user_messages: 0,
            tool_calls: 0,
        }
    }

    #[test]
    fn thread_usage_falls_back_to_tokens_used() {
        let billed_as_input = ModelUsage {
            input_tokens: 4500,
            reasoning_output_tokens: Some(0),
            ..Default::default()
        };
        assert_eq!(codex_usage_from_thread(4500, None), billed_as_input);
        assert_eq!(
            codex_usage_from_thread(4500, Some(&summary(None))),
            billed_as_input
        );
        let from_rollout =
            codex_usage_from_thread(4500, Some(&summary(Some(totals(4000, 1000, 500, 120)))));
        assert_eq!(from_rollout.input_tokens, 3000);
        assert_eq!(from_rollout.cache_read_input_tokens, 1000);
    }

    #[test]
    fn date_parse_covers_iso_forms() {
        assert_eq!(
            js_date_parse("2026-09-27T10:00:00.000Z"),
            Some(1_790_503_200_000)
        );
        assert_eq!(
            js_date_parse("2026-09-27T18:00:00+08:00"),
            Some(1_790_503_200_000)
        );
        assert_eq!(js_date_parse("2026-09-27"), Some(1_790_467_200_000));
        assert!(js_date_parse("2026-09-27T10:00:00").is_some());
        assert_eq!(js_date_parse("yesterday"), None);
        assert_eq!(js_date_parse(""), None);
    }

    fn write_lines(path: &Path, rows: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body: String = rows.iter().map(|row| format!("{row}\n")).collect();
        std::fs::write(path, body).unwrap();
    }

    fn rollout(
        id: &str,
        cwd: &str,
        model: &str,
        start: &str,
        events: &[(&str, Value)],
    ) -> Vec<Value> {
        let mut rows = vec![
            json!({"timestamp": start, "type": "session_meta", "payload": {"id": id, "timestamp": start, "cwd": cwd}}),
            json!({"timestamp": start, "type": "turn_context", "payload": {"cwd": cwd, "model": model}}),
            json!({"timestamp": start, "type": "response_item", "payload": {"type": "message", "role": "user"}}),
            json!({"timestamp": start, "type": "event_msg", "payload": {"type": "user_message"}}),
        ];
        for (ts, total) in events {
            rows.push(json!({"timestamp": ts, "type": "response_item", "payload": {"type": "function_call"}}));
            rows.push(json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": total}}}));
        }
        rows
    }

    #[test]
    fn read_codex_session_follows_the_ts_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.jsonl");
        let mut rows = vec![
            json!({"type": "session_meta", "payload": {"id": "s1", "timestamp": "2026-09-27T10:00:00.000Z", "cwd": "/w/meta", "model": "meta-model"}}),
            json!({"timestamp": "2026-09-27T10:01:00.000Z", "type": "turn_context", "payload": {"cwd": "/w/turn", "model": "turn-model"}}),
            json!({"timestamp": "2026-09-27T10:02:00.000Z", "type": "turn_context", "payload": {}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "assistant"}}),
            json!({"type": "event_msg", "payload": {"type": "user_message"}}),
            json!({"type": "event_msg", "payload": {"type": "user_message"}}),
            json!({"type": "response_item", "payload": {"type": "message", "role": "user"}}),
            json!({"type": "response_item", "payload": {"type": "function_call"}}),
            // No timestamp: sets latest but pushes no token event.
            json!({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 5}}}}),
            json!({"timestamp": "2026-09-27T10:05:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 9, "output_tokens": 2}}}}),
            json!({"timestamp": "2026-09-27T10:06:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": null}}),
        ];
        rows.insert(0, json!(7));
        write_lines(&path, &rows);
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("\n   \nnot json\n");
        std::fs::write(&path, body).unwrap();

        let parsed = read_codex_session(&path).unwrap();
        assert_eq!(parsed.id.as_deref(), Some("s1"));
        // session_meta's payload timestamp stands in until an entry timestamp parses.
        assert_eq!(parsed.timestamp_ms, 1_790_503_200_000);
        assert_eq!(parsed.cwd, "/w/turn");
        assert_eq!(parsed.model.as_deref(), Some("turn-model"));
        assert_eq!(parsed.user_messages, 2);
        assert_eq!(parsed.tool_calls, 1);
        assert_eq!(
            parsed.token_usage,
            Some(CodexTokenUsage {
                input_tokens: Some(9),
                output_tokens: Some(2),
                ..Default::default()
            })
        );
        assert_eq!(parsed.token_events.len(), 1);
        assert_eq!(parsed.token_events[0].timestamp_ms, 1_790_503_500_000);

        assert_eq!(read_codex_session(&dir.path().join("missing.jsonl")), None);
        let empty = dir.path().join("empty.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(read_codex_session(&empty), Some(summary(None)));
    }

    #[test]
    fn ts_written_summary_round_trips() {
        // JSON.stringify(readCodexSession(...)) as the TS writes it into codex-sessions.db.
        let ts = r#"{"id":"019a-1","timestampMs":1790503200000,"cwd":"/work/a","model":"gpt-5.1-codex","tokenUsage":{"input_tokens":15000,"cached_input_tokens":11000,"output_tokens":2100,"reasoning_output_tokens":700,"total_tokens":17100},"tokenEvents":[{"timestampMs":1790503500000,"usage":{"input_tokens":8000,"cached_input_tokens":5000,"output_tokens":900,"reasoning_output_tokens":300,"total_tokens":8900}}],"userMessages":1,"toolCalls":2}"#;
        let parsed: Option<CodexSessionSummary> = serde_json::from_str(ts).unwrap();
        let parsed = parsed.unwrap();
        assert_eq!(parsed.token_usage, Some(totals(15000, 11000, 2100, 700)));
        assert_eq!(parsed.token_events[0].usage, totals(8000, 5000, 900, 300));
        assert_eq!(serde_json::to_string(&Some(parsed)).unwrap(), ts);

        let bare = r#"{"id":null,"timestampMs":0,"cwd":"","model":null,"tokenUsage":null,"tokenEvents":[],"userMessages":0,"toolCalls":0}"#;
        let parsed: CodexSessionSummary = serde_json::from_str(bare).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), bare);
        let null: Option<CodexSessionSummary> = serde_json::from_str("null").unwrap();
        assert_eq!(null, None);
        assert_eq!(serde_json::to_string(&null).unwrap(), "null");
    }

    // ---------- summary cache ----------

    struct CacheFixture {
        dir: tempfile::TempDir,
        db: Connection,
        calls: Cell<usize>,
    }

    impl CacheFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = open_codex_cache(&dir.path().join("nested/codex-sessions.db")).unwrap();
            Self {
                dir,
                db,
                calls: Cell::new(0),
            }
        }

        fn file(&self, name: &str, body: &str) -> String {
            let path = self.dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn run(&mut self, files: &[&String]) -> Summaries {
            let set: IndexSet<String> = files.iter().map(|file| (*file).clone()).collect();
            let calls = &self.calls;
            summarise_sessions(&mut self.db, &set, |path| {
                calls.set(calls.get() + 1);
                read_codex_session(path)
            })
            .unwrap()
        }

        fn run_with(
            &mut self,
            files: &[&String],
            compute: impl Fn(&Path) -> Option<CodexSessionSummary>,
        ) -> Summaries {
            let set: IndexSet<String> = files.iter().map(|file| (*file).clone()).collect();
            summarise_sessions(&mut self.db, &set, compute).unwrap()
        }

        fn row(&self, path: &str) -> Option<String> {
            self.db
                .query_row(
                    "SELECT summary FROM session_summary WHERE path = ?",
                    [path],
                    |row| row.get(0),
                )
                .ok()
        }

        fn take_calls(&self) -> usize {
            self.calls.replace(0)
        }
    }

    const ROLLOUT_LINE: &str =
        r#"{"timestamp":"2026-09-27T10:00:00.000Z","type":"session_meta","payload":{"id":"a"}}"#;

    #[test]
    fn cache_hits_when_size_and_mtime_are_unchanged() {
        let mut f = CacheFixture::new();
        let a = f.file("a.jsonl", ROLLOUT_LINE);
        let first = f.run(&[&a]);
        assert_eq!(f.take_calls(), 1);
        let second = f.run(&[&a]);
        assert_eq!(f.take_calls(), 0);
        assert_eq!(first, second);
        assert_eq!(second[&a].as_ref().unwrap().id.as_deref(), Some("a"));
    }

    #[test]
    fn cache_recomputes_when_size_or_mtime_changes() {
        let mut f = CacheFixture::new();
        let a = f.file("a.jsonl", ROLLOUT_LINE);
        f.run(&[&a]);
        f.take_calls();

        std::fs::write(&a, format!("{ROLLOUT_LINE}\n{ROLLOUT_LINE}\n")).unwrap();
        f.run(&[&a]);
        assert_eq!(f.take_calls(), 1);

        // Same size, new mtime.
        let file = std::fs::File::options().write(true).open(&a).unwrap();
        file.set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000))
            .unwrap();
        f.run(&[&a]);
        assert_eq!(f.take_calls(), 1);
        let mtime: i64 =
            f.db.query_row("SELECT mtime_ms FROM session_summary", [], |row| row.get(0))
                .unwrap();
        assert_eq!(mtime, 1_000_000_000);
        f.run(&[&a]);
        assert_eq!(f.take_calls(), 0);
    }

    #[test]
    fn cache_recomputes_a_corrupt_row() {
        let mut f = CacheFixture::new();
        let a = f.file("a.jsonl", ROLLOUT_LINE);
        f.run(&[&a]);
        f.take_calls();
        f.db.execute("UPDATE session_summary SET summary = '{'", [])
            .unwrap();
        let out = f.run(&[&a]);
        assert_eq!(f.take_calls(), 1);
        assert!(out[&a].is_some());
        let row = f.row(&a).unwrap();
        assert!(
            serde_json::from_str::<CodexSessionSummary>(&row).is_ok(),
            "{row}"
        );
    }

    #[test]
    fn cache_stores_a_null_summary() {
        let mut f = CacheFixture::new();
        let a = f.file("a.jsonl", ROLLOUT_LINE);
        let out = f.run_with(&[&a], |_| None);
        assert_eq!(out[&a], None);
        assert_eq!(f.row(&a).as_deref(), Some("null"));
        let again = f.run(&[&a]);
        assert_eq!(f.take_calls(), 0);
        assert_eq!(again[&a], None);
    }

    #[test]
    fn cache_prunes_rows_outside_the_file_set_and_skips_unstatable_files() {
        let mut f = CacheFixture::new();
        let a = f.file("a.jsonl", ROLLOUT_LINE);
        let b = f.file("b.jsonl", ROLLOUT_LINE);
        let gone = f
            .dir
            .path()
            .join("gone.jsonl")
            .to_string_lossy()
            .into_owned();
        let out = f.run(&[&a, &gone]);
        assert_eq!(f.take_calls(), 2);
        assert_eq!(out.keys().collect::<Vec<_>>(), [&a, &gone]);
        assert_eq!(out[&gone], None);
        assert_eq!(
            f.row(&gone),
            None,
            "an unstatable file is computed, never cached"
        );

        // a still exists on disk, but it left the set, so its row goes.
        f.run(&[&b]);
        assert_eq!(f.row(&a), None);
        assert!(f.row(&b).is_some());
    }

    // ---------- aggregation ----------

    fn create_threads(path: &Path) -> Connection {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(path).unwrap();
        db.execute_batch(
            "create table threads (
               id text primary key, rollout_path text, created_at integer, updated_at integer,
               cwd text, title text, model text, tokens_used integer
             )",
        )
        .unwrap();
        db
    }

    fn insert_thread(db: &Connection, row: (&str, &str, i64, i64, &str, Option<&str>, i64)) {
        let (id, rollout, created, updated, cwd, model, tokens) = row;
        db.execute(
            "insert into threads values (?, ?, ?, ?, ?, 't', ?, ?)",
            params![id, rollout, created, updated, cwd, model, tokens],
        )
        .unwrap();
    }

    fn ctx() -> Ctx {
        Ctx {
            now_ms: NOW,
            plugin_root: PathBuf::new(),
        }
    }

    #[test]
    fn load_aggregates_rollouts_then_rolloutless_threads() {
        let env = TestEnv::new();
        let home = env.dir.path();
        let sessions = home.join(".codex/sessions/2026/09");
        let t1 = sessions.join("rollout-t1.jsonl");
        write_lines(
            &t1,
            &rollout(
                "t1",
                "/w/a",
                "gpt-rollout",
                "2026-09-27T10:00:00.000Z",
                &[
                    (
                        "2026-09-27T10:05:00.000Z",
                        json!(totals(8000, 5000, 900, 300)),
                    ),
                    (
                        "2026-09-27T11:20:00.000Z",
                        json!(totals(15000, 11000, 2100, 700)),
                    ),
                ],
            ),
        );
        let orphan = sessions.join("rollout-orphan.jsonl");
        write_lines(
            &orphan,
            &[
                json!({"timestamp": "2026-09-28T16:00:00.000Z", "type": "session_meta", "payload": {"id": "orphan", "cwd": "/w/c"}}),
            ],
        );
        let missing = home.join(".codex/sessions/missing.jsonl");

        let db = create_threads(&home.join(".codex/state_5.sqlite"));
        let t1_path = t1.to_string_lossy().into_owned();
        let missing_path = missing.to_string_lossy().into_owned();
        // Earliest row, yet it bills after every rollout-backed row.
        insert_thread(&db, ("no-rollout", "", 1_790_300_000, 0, "/w/b", None, 700));
        insert_thread(
            &db,
            (
                "t1-row",
                &t1_path,
                1_790_503_200,
                1_790_508_000,
                "",
                Some(""),
                500,
            ),
        );
        insert_thread(
            &db,
            (
                "gone-row",
                &missing_path,
                1_790_600_000,
                1_790_600_060,
                "",
                Some("gpt-x"),
                0,
            ),
        );
        insert_thread(&db, ("empty", "", 1_790_700_000, 0, "", None, 0));
        drop(db);

        let src = load(&ctx()).unwrap();
        let ids: Vec<&str> = src.ledger.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "codex:t1-row",
                "codex:gone-row",
                "codex:orphan",
                "codex:no-rollout"
            ]
        );
        assert_eq!(src.total_threads, 3);
        assert_eq!(src.codex_session_file_count, 2);
        // "empty" has neither tokens nor a rollout, so the query drops it.
        assert_eq!(src.codex_thread_row_count, 3);

        let t1_row = &src.ledger[0];
        // An empty row model falls through to the rollout's turn_context model.
        assert_eq!(t1_row.model, "codex:gpt-rollout");
        assert_eq!(t1_row.tokens, 500);
        assert_eq!(t1_row.project_path, "/w/a");
        assert_eq!(t1_row.project_name, "a");
        assert_eq!(t1_row.timestamp_ms, 1_790_508_000_000);
        assert_eq!(t1_row.cost_basis, LedgerCostBasis::Usage);
        assert_eq!((t1_row.interactions, t1_row.tool_calls), (1, 2));

        let gone = &src.ledger[1];
        assert_eq!(gone.model, "codex:gpt-x");
        assert_eq!(gone.project_name, "n/a");
        assert_eq!(gone.cost_basis, LedgerCostBasis::Unavailable);
        assert_eq!((gone.interactions, gone.tokens), (1, 0));

        let orphan_row = &src.ledger[2];
        assert_eq!(orphan_row.model, "codex:unknown");
        assert_eq!(orphan_row.timestamp_ms, 1_790_611_200_000);

        let no_rollout = &src.ledger[3];
        assert_eq!(no_rollout.model, "codex:unknown");
        assert_eq!(no_rollout.cost_basis, LedgerCostBasis::ThreadTokens);
        assert_eq!(no_rollout.timestamp_ms, 1_790_300_000_000);
        assert_eq!(
            (
                no_rollout.interactions,
                no_rollout.tool_calls,
                no_rollout.tokens
            ),
            (1, 0, 700)
        );

        assert_eq!(src.total_interactions, 3);
        assert_eq!(src.total_tool_calls, 2);
        let matrix: i64 = src.week_hour_matrix.iter().flatten().sum();
        assert_eq!(matrix, 3);
        let hours: i64 = src.daily_hour_counts.values().flatten().sum();
        assert_eq!(hours, 3);
        let threads: i64 = src.daily_activity.values().map(|d| d.thread_count).sum();
        assert_eq!(threads, 3);
        assert_eq!(
            src.project_activity.keys().collect::<Vec<_>>(),
            ["/w/a", "/w/c"]
        );
        assert_eq!(src.project_activity["/w/a"].first_seen, 1_790_503_200_000);
        assert_eq!(src.usage.project_tokens["/w/a"], 500);
        assert_eq!(src.usage.project_tokens["/w/b"], 700);

        // Hourly usage is the per-event delta; totals are the last cumulative snapshot.
        let rollout_key = "codex:gpt-rollout";
        assert_eq!(src.usage.model_usage[rollout_key].input_tokens, 4000);
        let hourly_input: i64 = src
            .usage
            .hourly_usage
            .values()
            .filter_map(|bucket| bucket.usage_by_model.get(rollout_key))
            .map(|usage| usage.input_tokens)
            .sum();
        assert_eq!(hourly_input, 3000 + 1000);
        assert_eq!(src.usage.model_usage["codex:unknown"].input_tokens, 700);

        // The second load reads every summary from the cache and agrees.
        assert!(paths::codex_cache_path().exists());
        let again = load(&ctx()).unwrap();
        assert_eq!(again.ledger, src.ledger);

        let json = source_json(&src, &codex_usage_base(None));
        assert_eq!(
            json["usage"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "modelUsage",
                "dailyModelUsage",
                "hourlyUsage",
                "projectTokens",
                "projectModelUsage",
                "projectActivity",
                "dailyActivity",
                "weekHourMatrix",
                "dailyHourCounts",
                "totalThreads",
                "totalInteractions",
                "totalToolCalls",
                "ledger",
                "codexSessionFileCount",
                "codexThreadRowCount",
            ]
        );
        assert_eq!(json["usage"]["ledger"][0]["costBasis"], json!("usage"));
        assert_eq!(json["usageLimits"]["plan"], Value::Null);
    }

    #[test]
    fn load_without_state_db_reads_walked_rollouts_only() {
        let _env = TestEnv::new();
        let src = load(&ctx()).unwrap();
        assert!(src.ledger.is_empty());
        assert_eq!((src.total_threads, src.codex_thread_row_count), (0, 0));
    }

    // ---------- usage limits ----------

    #[test]
    fn limits_slot_by_window_length_not_field() {
        let _env = TestEnv::new();
        let weekly_only = json!({"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 5, "limit_window_seconds": 604800, "reset_at": NOW / 1000 + 3600}}});
        let limits = build_codex_usage_limits(Some(&weekly_only), None, NOW as f64, None, NOW);
        assert!(limits.five_hour.is_none());
        assert_eq!(limits.weekly.as_ref().unwrap().used_percent, Some(5.0));
        assert_eq!(limits.plan, Some(Some("pro".to_owned())));
        assert!(!limits.stale);

        // No limit_window_seconds: primary falls back to 5 h, secondary to 7 d.
        let fallback = json!({"rate_limit": {"primary_window": {"used_percent": 1}, "secondary_window": {"used_percent": 2}}});
        let limits = build_codex_usage_limits(Some(&fallback), None, f64::NAN, None, NOW);
        assert_eq!(limits.five_hour.unwrap().duration_ms, FIVE_HOUR_MS);
        assert_eq!(limits.weekly.unwrap().duration_ms, SEVEN_DAY_MS);
        assert!(limits.stale);
        assert_eq!(limits.plan, Some(None));

        let empty = build_codex_usage_limits(None, None, NOW as f64, None, NOW);
        assert_eq!(empty.error.as_deref(), Some("missing-rate-limits"));
        let stale =
            build_codex_usage_limits(Some(&weekly_only), None, (NOW - 300_001) as f64, None, NOW);
        assert!(stale.stale);
    }

    #[derive(Clone, Debug)]
    struct Seen {
        method: String,
        path: String,
        header: IndexMap<String, String>,
        body: String,
    }

    fn usage_body() -> Value {
        json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 42, "limit_window_seconds": 18000, "reset_at": NOW / 1000 + 7200},
                "secondary_window": {"used_percent": 17, "limit_window_seconds": 604800, "reset_at": NOW / 1000 + 259_200},
            },
        })
    }

    // Answers the fresh token with usage and anything else with `usage_status`, as the golden stub does.
    fn fetch_limits(usage_status: u16, token_status: u16) -> (UsageLimits, Vec<Seen>) {
        use axum::http::{HeaderMap, Method, StatusCode, Uri};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
            let log = seen.clone();
            let app = axum::Router::new().fallback(
                move |method: Method, uri: Uri, headers: HeaderMap, body: String| {
                    let log = log.clone();
                    async move {
                        let header = headers
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
                            .collect::<IndexMap<_, _>>();
                        let fresh =
                            header.get("authorization").map(String::as_str) == Some("Bearer fresh");
                        log.lock().unwrap().push(Seen {
                            method: method.to_string(),
                            path: uri.path().to_owned(),
                            header,
                            body,
                        });
                        let (status, body) = match uri.path() {
                            "/usage" if fresh => (200, usage_body()),
                            "/usage" => (usage_status, json!({"detail": "token expired"})),
                            "/token" => (token_status, json!({"access_token": "fresh"})),
                            _ => (404, json!({})),
                        };
                        (StatusCode::from_u16(status).unwrap(), axum::Json(body))
                    }
                },
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let limits =
                read_codex_usage_limits_from(&format!("{base}/usage"), &format!("{base}/token"))
                    .await;
            let requests = seen.lock().unwrap().clone();
            (limits, requests)
        })
    }

    fn limits_env() -> TestEnv {
        let env = TestEnv::new();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", NOW.to_string());
        env
    }

    fn write_auth(home: &Path, tokens: Value) -> PathBuf {
        let path = home.join(".codex/auth.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = serde_json::to_string_pretty(&json!({"OPENAI_API_KEY": null, "tokens": tokens}))
            .unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn stale_auth(home: &Path) -> PathBuf {
        write_auth(
            home,
            json!({"access_token": "stale", "refresh_token": "rt", "account_id": "acct-1"}),
        )
    }

    fn write_cache(home: &Path, body: &str) {
        let path = home.join(".cache/token-atlas/codex-usage-limits.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn requests(seen: &[Seen]) -> Vec<String> {
        seen.iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect()
    }

    #[test]
    fn missing_cache_then_missing_auth() {
        let _env = limits_env();
        let cached = read_codex_usage_cache();
        assert_eq!(cached.error.as_deref(), Some("missing"));
        let (limits, seen) = fetch_limits(401, 200);
        assert_eq!(limits, codex_usage_base(Some("missing-auth".to_owned())));
        assert_eq!(limits.path, "~/.cache/token-atlas/codex-usage-limits.json");
        assert!(seen.is_empty());
    }

    #[test]
    fn corrupt_cache_reports_the_parse_message() {
        let env = limits_env();
        write_cache(env.dir.path(), "nope");
        assert_eq!(
            read_codex_usage_cache().error.as_deref(),
            Some("JSON Parse error: Unexpected identifier \"nope\"")
        );
        write_cache(env.dir.path(), "");
        assert_eq!(
            read_codex_usage_cache().error.as_deref(),
            Some("JSON Parse error: Unexpected EOF")
        );
        write_cache(env.dir.path(), "null");
        assert_eq!(
            read_codex_usage_cache().error.as_deref(),
            Some("unreadable")
        );
    }

    #[test]
    fn auth_without_access_token() {
        let env = limits_env();
        write_auth(env.dir.path(), json!({"refresh_token": "rt"}));
        let (limits, seen) = fetch_limits(401, 200);
        assert_eq!(limits.error.as_deref(), Some("missing-access-token"));
        assert!(seen.is_empty());
    }

    #[test]
    fn non_auth_failure_never_refreshes() {
        let env = limits_env();
        stale_auth(env.dir.path());
        let (limits, seen) = fetch_limits(500, 200);
        assert_eq!(limits.error.as_deref(), Some("http-500"));
        assert!(limits.captured_at.is_none());
        assert_eq!(requests(&seen), ["GET /usage"]);
    }

    #[test]
    fn failed_refresh_reports_its_status() {
        let env = limits_env();
        stale_auth(env.dir.path());
        let (limits, seen) = fetch_limits(401, 502);
        assert_eq!(limits.error.as_deref(), Some("refresh-http-502"));
        assert_eq!(requests(&seen), ["GET /usage", "POST /token"]);
    }

    #[test]
    fn refresh_without_refresh_token() {
        let env = limits_env();
        write_auth(env.dir.path(), json!({"access_token": "stale"}));
        let (limits, seen) = fetch_limits(403, 200);
        assert_eq!(limits.error.as_deref(), Some("missing-refresh-token"));
        assert_eq!(requests(&seen), ["GET /usage"]);
    }

    #[test]
    fn unauthorized_refreshes_once_and_never_writes_auth() {
        let env = limits_env();
        let home = env.dir.path();
        let auth = stale_auth(home);
        let auth_before = std::fs::read(&auth).unwrap();
        let (limits, seen) = fetch_limits(401, 200);

        assert_eq!(limits.error, None);
        assert!(!limits.stale);
        assert_eq!(limits.plan, Some(Some("plus".to_owned())));
        assert_eq!(
            limits.captured_at.as_deref(),
            Some("2026-10-01T16:00:00.000Z")
        );
        assert_eq!(limits.five_hour.as_ref().unwrap().used_percent, Some(42.0));
        assert_eq!(limits.weekly.as_ref().unwrap().used_percent, Some(17.0));
        assert_eq!(std::fs::read(&auth).unwrap(), auth_before);

        assert_eq!(requests(&seen), ["GET /usage", "POST /token", "GET /usage"]);
        let bearer: Vec<&str> = seen
            .iter()
            .filter(|r| r.path == "/usage")
            .map(|r| r.header["authorization"].as_str())
            .collect();
        assert_eq!(bearer, ["Bearer stale", "Bearer fresh"]);
        let usage = &seen[0].header;
        assert_eq!(usage["accept"], "application/json");
        assert_eq!(usage["chatgpt-account-id"], "acct-1");
        assert_eq!(usage["user-agent"], USER_AGENT);
        let token = &seen[1];
        assert_eq!(
            token.header["content-type"],
            "application/x-www-form-urlencoded"
        );
        assert_eq!(
            token.body,
            "grant_type=refresh_token&refresh_token=rt&client_id=app_EMoamEEZ73f0CkXaXp7hrann"
        );

        let cache =
            std::fs::read_to_string(home.join(".cache/token-atlas/codex-usage-limits.json"))
                .unwrap();
        let expected = json!({
            "capturedAt": "2026-10-01T16:00:00.000Z",
            "capturedAtEpochMs": NOW,
            "usage": usage_body(),
        });
        assert_eq!(
            cache,
            format!("{}\n", serde_json::to_string_pretty(&expected).unwrap())
        );
    }

    #[test]
    fn fresh_cache_makes_no_request() {
        let env = limits_env();
        stale_auth(env.dir.path());
        let cache =
            json!({"capturedAt": "x", "capturedAtEpochMs": NOW - 60_000, "usage": usage_body()});
        write_cache(env.dir.path(), &cache.to_string());
        let (limits, seen) = fetch_limits(401, 200);
        assert!(seen.is_empty());
        assert!(!limits.stale);
        assert_eq!(limits.captured_at.as_deref(), Some("x"));
        assert_eq!(limits.plan, Some(Some("plus".to_owned())));
    }

    #[test]
    fn stale_cache_keeps_captured_at_on_fetch_failure() {
        let env = limits_env();
        let captured = "2026-10-01T15:50:00.000Z";
        let cache = json!({"capturedAt": captured, "usage": usage_body()});
        write_cache(env.dir.path(), &cache.to_string());
        let (limits, seen) = fetch_limits(401, 200);
        assert!(seen.is_empty());
        assert_eq!(limits.captured_at.as_deref(), Some(captured));
        assert!(limits.stale);
        assert_eq!(limits.error.as_deref(), Some("missing-auth"));
        assert_eq!(limits.plan, Some(Some("plus".to_owned())));
        assert!(limits.five_hour.is_some());
    }

    #[test]
    fn unreachable_endpoint_uses_buns_wording() {
        let env = limits_env();
        stale_auth(env.dir.path());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let limits = runtime.block_on(read_codex_usage_limits_from(
            "http://127.0.0.1:9/usage",
            "http://127.0.0.1:9/token",
        ));
        assert_eq!(
            limits.error.as_deref(),
            Some("Unable to connect. Is the computer able to access the url?")
        );
    }
}
