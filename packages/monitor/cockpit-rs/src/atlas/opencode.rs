// Port of api.ts parseOpenCodeUsage: OpenCode's SQLite store, with legacy JSON storage as fallback.
use super::dedup::walk_files;
use super::model::{
    Ctx, InternalLedgerRow, LedgerCostBasis, ModelUsage, Provider, ProviderUsage, add_hourly_usage,
    add_model_usage, add_nested_model_usage, empty_model_usage, fmt_date, ledger_project_name,
    model_key, model_usage_total, project_name,
};
use super::paths;
use indexmap::IndexMap;
use jiff::{Timestamp, tz::TimeZone};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub struct OpenCodeSource {
    pub usage: ProviderUsage,
    pub project_activity: IndexMap<String, OpenCodeProjectActivity>,
    pub daily_activity: IndexMap<String, OpenCodeDailyActivity>,
    pub week_hour_matrix: [[i64; 24]; 7],
    pub daily_hour_counts: IndexMap<String, [i64; 24]>,
    pub total_sessions: i64,
    pub total_interactions: i64,
    pub total_tool_calls: i64,
    pub ledger: Vec<InternalLedgerRow>,
    pub open_code_session_file_count: usize,
    pub open_code_message_file_count: usize,
    pub open_code_session_row_count: usize,
    pub open_code_message_row_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeProjectActivity {
    pub session_count: i64,
    pub interaction_count: i64,
    pub tool_call_count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeDailyActivity {
    pub session_count: i64,
    pub interaction_count: i64,
    pub tool_call_count: i64,
}

// Kept local rather than in model.rs: only this source reads OpenCode's mixed seconds/ms clocks.
fn open_code_timestamp_ms(value: f64) -> i64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    if value < 1_000_000_000_000.0 {
        (value * 1000.0) as i64
    } else {
        value as i64
    }
}

// A present non-number becomes NaN, as JS Number.isFinite rejects it rather than falling through `??`.
fn num(value: Option<&Value>) -> Option<f64> {
    value
        .filter(|v| !v.is_null())
        .map(|v| v.as_f64().unwrap_or(f64::NAN))
}

fn tok(value: Option<&Value>) -> i64 {
    num(value).filter(|n| n.is_finite()).unwrap_or(0.0) as i64
}

fn open_code_usage_from_tokens(tokens: &Value) -> ModelUsage {
    ModelUsage {
        input_tokens: tok(tokens.get("input")),
        output_tokens: tok(tokens.get("output")),
        cache_read_input_tokens: tok(tokens.pointer("/cache/read")),
        cache_creation_input_tokens: tok(tokens.pointer("/cache/write")),
        reasoning_output_tokens: Some(tok(tokens.get("reasoning"))),
        web_search_requests: None,
        cost_usd: None,
    }
}

fn count_open_code_tool_calls(parts: Option<&Value>) -> i64 {
    parts.and_then(Value::as_array).map_or(0, |parts| {
        parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool"))
            .count() as i64
    })
}

pub(super) fn open_code_storage_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let storage = paths::opencode_storage_dir();
    if storage.exists() {
        roots.push(storage);
    }
    if let Ok(entries) = std::fs::read_dir(paths::opencode_project_dir()) {
        for entry in entries.flatten() {
            let storage = entry.path().join("storage");
            if storage.exists() && !roots.contains(&storage) {
                roots.push(storage);
            }
        }
    }
    roots
}

// JS `a ?? b` over JSON: only null or absent falls through.
fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

struct LedgerState {
    row: InternalLedgerRow,
    project_first_seen: i64,
    user_message_ids: HashSet<String>,
}

#[derive(Default)]
struct Ingest {
    usage: ProviderUsage,
    ledger_by_session: IndexMap<String, LedgerState>,
}

impl Ingest {
    // api.ts ingestOpenCodeMessage; `session` is the stored session object, DB row or legacy file.
    fn message(
        &mut self,
        info: &Value,
        session_id: &str,
        session: Option<&Value>,
        fallback_timestamp_ms: f64,
        tool_calls: i64,
    ) {
        let ts = |v: Option<&Value>| open_code_timestamp_ms(num(v).unwrap_or(0.0));
        let session_time = |key: &str| session.and_then(|s| s.get("time")).and_then(|t| t.get(key));
        let mut created_ms = ts(info.pointer("/time/created"));
        if created_ms == 0 {
            created_ms = ts(session_time("created"));
        }
        if created_ms == 0 {
            created_ms = open_code_timestamp_ms(fallback_timestamp_ms);
        }
        let mut completed_ms = ts(info.pointer("/time/completed"));
        if completed_ms == 0 {
            completed_ms = ts(session_time("updated"));
        }
        if completed_ms == 0 {
            completed_ms = created_ms;
        }
        let timestamp_ms = if completed_ms != 0 {
            completed_ms
        } else {
            created_ms
        };
        if timestamp_ms == 0 {
            return;
        }

        let cwd = non_null(info.pointer("/path/cwd"))
            .or_else(|| non_null(session.and_then(|s| s.get("directory"))))
            .map(js_string)
            .unwrap_or_default();
        let ledger = self
            .ledger_by_session
            .entry(session_id.to_owned())
            .or_insert_with(|| LedgerState {
                row: InternalLedgerRow {
                    id: format!("opencode:{session_id}"),
                    provider: Provider::Opencode,
                    timestamp_ms,
                    date: fmt_date(timestamp_ms),
                    project_path: cwd.clone(),
                    project_name: ledger_project_name(&cwd),
                    model: "n/a".to_owned(),
                    interactions: 0,
                    tool_calls: 0,
                    tokens: 0,
                    cost_basis: LedgerCostBasis::Unavailable,
                    usage_by_model: IndexMap::new(),
                },
                project_first_seen: timestamp_ms,
                user_message_ids: HashSet::new(),
            });
        ledger.row.timestamp_ms = ledger.row.timestamp_ms.max(timestamp_ms);
        ledger.row.date = fmt_date(ledger.row.timestamp_ms);
        ledger.project_first_seen = ledger.project_first_seen.min(timestamp_ms);
        if ledger.row.project_path.is_empty() && !cwd.is_empty() {
            ledger.row.project_path = cwd.clone();
            ledger.row.project_name = project_name(&cwd);
        }

        let role = info.get("role").and_then(Value::as_str);
        if role == Some("user") {
            let message_id = non_null(info.get("id"))
                .map(js_string)
                .unwrap_or_else(|| format!("{session_id}:{timestamp_ms}"));
            if ledger.user_message_ids.insert(message_id) {
                ledger.row.interactions += 1;
            }
            return;
        }

        let Some(tokens) = info
            .get("tokens")
            .filter(|t| !matches!(t, Value::Null | Value::Bool(false)))
        else {
            return;
        };
        if role != Some("assistant") {
            return;
        }
        let model = info
            .get("modelID")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or("unknown");
        let key = model_key(Provider::Opencode, model);
        let mut usage = open_code_usage_from_tokens(tokens);
        let cost = info
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite());
        if cost.is_some() {
            usage.cost_usd = cost;
        }
        let token_total = model_usage_total(&usage);
        if token_total <= 0 && !cost.is_some_and(|c| c > 0.0) {
            return;
        }

        let ledger_usage = ledger
            .row
            .usage_by_model
            .entry(key.clone())
            .or_insert_with(empty_model_usage);
        add_model_usage(ledger_usage, &usage);
        ledger.row.tokens += token_total;
        ledger.row.cost_basis = LedgerCostBasis::Usage;
        ledger.row.model = if ledger.row.usage_by_model.len() == 1 {
            key.clone()
        } else {
            "mixed".to_owned()
        };
        ledger.row.tool_calls += tool_calls;

        let totals = &mut self.usage;
        add_model_usage(
            totals
                .model_usage
                .entry(key.clone())
                .or_insert_with(empty_model_usage),
            &usage,
        );
        add_hourly_usage(&mut totals.hourly_usage, timestamp_ms, &key, &usage);
        add_nested_model_usage(
            &mut totals.daily_model_usage,
            &fmt_date(timestamp_ms),
            &key,
            &usage,
        );
        if !cwd.is_empty() {
            *totals.project_tokens.entry(cwd.clone()).or_insert(0) += token_total;
            add_nested_model_usage(&mut totals.project_model_usage, &cwd, &key, &usage);
        }
    }
}

// TS reads the DB inside try/catch and keeps whatever counts were set before the throw.
fn read_db(
    db: &Path,
    ingest: &mut Ingest,
    sessions_by_id: &mut HashMap<String, Value>,
    session_rows: &mut usize,
    message_rows: &mut usize,
) -> rusqlite::Result<()> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = conn.prepare("select id, directory, time_created, time_updated from session")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    *session_rows = rows.len();
    for (id, directory, created, updated) in rows {
        let session = json!({"id": id, "directory": directory, "time": {"created": created, "updated": updated}});
        sessions_by_id.insert(id, session);
    }

    let mut stmt = conn.prepare("select message_id, count(*) as tool_calls from part where json_extract(data, '$.type') = 'tool' group by message_id")?;
    let tool_calls: HashMap<String, i64> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt =
        conn.prepare("select id, session_id, time_created, time_updated, data from message")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    *message_rows = rows.len();
    for (id, session_id, created, updated, data) in rows {
        let Ok(parsed) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        // `if (!info) continue` skips falsy JSON; any other non-object spreads to no fields.
        if matches!(parsed, Value::Null | Value::Bool(false)) || parsed == 0 || parsed == "" {
            continue;
        }
        let mut info = if parsed.is_object() {
            parsed
        } else {
            json!({})
        };
        let Some(obj) = info.as_object_mut() else {
            continue;
        };
        let time_created = non_null(obj.get("time").and_then(|t| t.get("created")))
            .cloned()
            .unwrap_or_else(|| json!(created));
        let time_completed = non_null(obj.get("time").and_then(|t| t.get("completed")))
            .cloned()
            .unwrap_or_else(|| json!(updated));
        obj.insert("id".into(), json!(id));
        obj.insert("sessionID".into(), json!(session_id));
        obj.insert(
            "time".into(),
            json!({"created": time_created, "completed": time_completed}),
        );
        let fallback = if updated != 0.0 { updated } else { created };
        ingest.message(
            &info,
            &session_id,
            sessions_by_id.get(&session_id),
            fallback,
            tool_calls.get(&id).copied().unwrap_or(0),
        );
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub fn load(_ctx: &Ctx) -> anyhow::Result<OpenCodeSource> {
    let roots = open_code_storage_roots();
    let mut session_files = Vec::new();
    let mut message_files = Vec::new();
    for root in &roots {
        walk_files(&root.join("session"), ".json", &mut session_files);
    }
    for root in &roots {
        walk_files(&root.join("message"), ".json", &mut message_files);
    }

    let mut ingest = Ingest::default();
    let mut sessions_by_id: HashMap<String, Value> = HashMap::new();
    let mut session_rows = 0;
    let mut message_rows = 0;
    let db = paths::opencode_db();
    if db.exists() {
        let _ = read_db(
            &db,
            &mut ingest,
            &mut sessions_by_id,
            &mut session_rows,
            &mut message_rows,
        );
    }

    if session_rows == 0 {
        for file in &session_files {
            let Some(session) = read_json(file) else {
                continue;
            };
            // TS `if (session?.id)`: any truthy id, keyed by its string form.
            let id = session
                .get("id")
                .filter(|id| !matches!(id, Value::Null | Value::Bool(false)) && *id != "")
                .map(js_string);
            if let Some(id) = id {
                sessions_by_id.insert(id, session);
            }
        }
    }

    if message_rows == 0 {
        for file in &message_files {
            let Some(stored) = read_json(file) else {
                continue;
            };
            let info = non_null(stored.get("info")).unwrap_or(&stored);
            let session_id = non_null(info.get("sessionID"))
                .or_else(|| non_null(stored.get("sessionID")))
                .map(js_string)
                .or_else(|| {
                    file.parent()
                        .and_then(Path::file_name)
                        .map(|n| n.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| file.to_string_lossy().into_owned());
            ingest.message(
                info,
                &session_id,
                sessions_by_id.get(&session_id),
                0.0,
                count_open_code_tool_calls(stored.get("parts")),
            );
        }
    }

    let mut project_activity: IndexMap<String, OpenCodeProjectActivity> = IndexMap::new();
    let mut daily_activity: IndexMap<String, OpenCodeDailyActivity> = IndexMap::new();
    let mut week_hour_matrix = [[0i64; 24]; 7];
    let mut daily_hour_counts: IndexMap<String, [i64; 24]> = IndexMap::new();
    let mut total_interactions = 0;
    let mut total_tool_calls = 0;
    let mut ledger = Vec::new();
    let tz = TimeZone::system();
    for state in ingest.ledger_by_session.into_values() {
        let row = state.row;
        if row.timestamp_ms <= 0
            || (row.interactions <= 0 && row.tokens <= 0 && row.tool_calls <= 0)
        {
            continue;
        }
        total_interactions += row.interactions;
        total_tool_calls += row.tool_calls;
        let date = fmt_date(row.timestamp_ms);
        let daily = daily_activity.entry(date.clone()).or_default();
        daily.session_count += 1;
        daily.interaction_count += row.interactions;
        daily.tool_call_count += row.tool_calls;
        if let Ok(ts) = Timestamp::from_millisecond(row.timestamp_ms) {
            let local = ts.to_zoned(tz.clone());
            let hour = local.hour() as usize;
            let day = local.weekday().to_sunday_zero_offset() as usize;
            week_hour_matrix[day][hour] += row.interactions;
            daily_hour_counts.entry(date).or_insert([0; 24])[hour] += row.interactions;
        }
        if !row.project_path.is_empty() {
            match project_activity.get_mut(&row.project_path) {
                Some(current) => {
                    current.session_count += 1;
                    current.interaction_count += row.interactions;
                    current.tool_call_count += row.tool_calls;
                    current.first_seen = current.first_seen.min(state.project_first_seen);
                    current.last_seen = current.last_seen.max(row.timestamp_ms);
                }
                None => {
                    project_activity.insert(
                        row.project_path.clone(),
                        OpenCodeProjectActivity {
                            session_count: 1,
                            interaction_count: row.interactions,
                            tool_call_count: row.tool_calls,
                            first_seen: state.project_first_seen,
                            last_seen: row.timestamp_ms,
                            path: row.project_path.clone(),
                        },
                    );
                }
            }
        }
        ledger.push(row);
    }

    Ok(OpenCodeSource {
        usage: ingest.usage,
        project_activity,
        daily_activity,
        week_hour_matrix,
        daily_hour_counts,
        total_sessions: ledger.len() as i64,
        total_interactions,
        total_tool_calls,
        ledger,
        open_code_session_file_count: session_files.len(),
        open_code_message_file_count: message_files.len(),
        open_code_session_row_count: session_rows,
        open_code_message_row_count: message_rows,
    })
}

/// The full `--source opencode` shape: `{usage}`.
pub fn source_json(src: &OpenCodeSource) -> serde_json::Value {
    let u = &src.usage;
    json!({
        "usage": {
            "modelUsage": u.model_usage,
            "dailyModelUsage": u.daily_model_usage,
            "hourlyUsage": u.hourly_usage,
            "projectTokens": u.project_tokens,
            "projectModelUsage": u.project_model_usage,
            "projectActivity": src.project_activity,
            "dailyActivity": src.daily_activity,
            "weekHourMatrix": src.week_hour_matrix,
            "dailyHourCounts": src.daily_hour_counts,
            "totalSessions": src.total_sessions,
            "totalInteractions": src.total_interactions,
            "totalToolCalls": src.total_tool_calls,
            "ledger": src.ledger,
            "openCodeSessionFileCount": src.open_code_session_file_count,
            "openCodeMessageFileCount": src.open_code_message_file_count,
            "openCodeSessionRowCount": src.open_code_session_row_count,
            "openCodeMessageRowCount": src.open_code_message_row_count,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    fn ctx() -> Ctx {
        Ctx {
            now_ms: 0,
            plugin_root: PathBuf::new(),
        }
    }

    fn setup_db(env: &TestEnv, with_part: bool) -> PathBuf {
        let db = env.dir.path().join("oc/opencode.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "create table session (id text, directory text, time_created integer, time_updated integer);
             create table message (id text, session_id text, time_created integer, time_updated integer, data text);",
        )
        .unwrap();
        if with_part {
            conn.execute_batch("create table part (id text, message_id text, data text);")
                .unwrap();
        }
        TestEnv::set("COCKPIT_OPENCODE_DB", &db);
        db
    }

    fn write(path: &Path, value: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, value.to_string()).unwrap();
    }

    fn legacy_message(env: &TestEnv) {
        write(
            &env.dir.path().join("oc/storage/message/ses_l/msg_1.json"),
            json!({"role": "assistant", "modelID": "m", "time": {"created": 1_700_000_000},
                   "tokens": {"input": 7}, "parts": [{"type": "tool"}, {"type": "text"}]}),
        );
    }

    #[test]
    fn token_mapping() {
        let usage = open_code_usage_from_tokens(
            &json!({"input": 10, "output": 5, "reasoning": 3, "cache": {"read": 2, "write": 1}}),
        );
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_input_tokens,
                usage.cache_creation_input_tokens,
                usage.reasoning_output_tokens
            ),
            (10, 5, 2, 1, Some(3))
        );
        assert_eq!(open_code_usage_from_tokens(&json!({})), empty_model_usage());
    }

    #[test]
    fn timestamp_detection() {
        assert_eq!(open_code_timestamp_ms(0.0), 0);
        assert_eq!(open_code_timestamp_ms(-5.0), 0);
        assert_eq!(open_code_timestamp_ms(f64::NAN), 0);
        assert_eq!(open_code_timestamp_ms(1_700_000_000.0), 1_700_000_000_000);
        assert_eq!(
            open_code_timestamp_ms(1_700_000_000_000.0),
            1_700_000_000_000
        );
    }

    #[test]
    fn missing_db_and_storage() {
        let env = TestEnv::new();
        TestEnv::set(
            "COCKPIT_OPENCODE_DB",
            env.dir.path().join("none/opencode.db"),
        );
        let src = load(&ctx()).unwrap();
        assert_eq!(src.usage, ProviderUsage::default());
        assert!(src.ledger.is_empty());
        assert_eq!(
            (
                src.open_code_session_file_count,
                src.open_code_message_file_count,
                src.open_code_session_row_count,
                src.open_code_message_row_count
            ),
            (0, 0, 0, 0)
        );
    }

    #[test]
    fn db_messages_suppress_legacy_messages() {
        let env = TestEnv::new();
        let db = setup_db(&env, true);
        legacy_message(&env);
        Connection::open(&db)
            .unwrap()
            .execute(
                "insert into message values ('m1', 'ses_d', 1700000000000, 1700000000000, ?1)",
                [json!({"role": "user"}).to_string()],
            )
            .unwrap();
        let src = load(&ctx()).unwrap();
        assert_eq!(src.open_code_message_file_count, 1);
        assert_eq!(src.open_code_message_row_count, 1);
        assert!(src.usage.model_usage.is_empty());
        assert_eq!(src.ledger.len(), 1);
        assert_eq!(src.ledger[0].id, "opencode:ses_d");
    }

    #[test]
    fn empty_db_ingests_legacy_messages() {
        let env = TestEnv::new();
        setup_db(&env, true);
        legacy_message(&env);
        let src = load(&ctx()).unwrap();
        assert_eq!(src.open_code_message_row_count, 0);
        assert_eq!(src.usage.model_usage["opencode:m"].input_tokens, 7);
        assert_eq!(src.ledger[0].id, "opencode:ses_l");
        assert_eq!(src.ledger[0].timestamp_ms, 1_700_000_000_000);
        assert_eq!(src.total_tool_calls, 1);
    }

    #[test]
    fn missing_part_table_keeps_session_count_and_falls_back() {
        let env = TestEnv::new();
        let db = setup_db(&env, false);
        legacy_message(&env);
        Connection::open(&db)
            .unwrap()
            .execute(
                "insert into session values ('ses_x', '/w', 1700000000000, 1700000000000)",
                [],
            )
            .unwrap();
        let src = load(&ctx()).unwrap();
        assert_eq!(src.open_code_session_row_count, 1);
        assert_eq!(src.open_code_message_row_count, 0);
        assert_eq!(src.usage.model_usage["opencode:m"].input_tokens, 7);
    }

    #[test]
    fn zero_token_skip_and_user_dedup() {
        let env = TestEnv::new();
        setup_db(&env, true);
        let dir = env.dir.path().join("oc/storage/message/ses_z");
        let user = json!({"id": "u1", "role": "user", "time": {"created": 1_700_000_000}});
        write(&dir.join("a.json"), user.clone());
        write(&dir.join("b.json"), user);
        write(
            &dir.join("c.json"),
            json!({"role": "assistant", "modelID": "m", "cost": 0, "time": {"created": 1_700_000_000},
                   "tokens": {"input": 0}, "parts": [{"type": "tool"}]}),
        );
        let src = load(&ctx()).unwrap();
        assert!(src.usage.model_usage.is_empty());
        assert_eq!(src.ledger.len(), 1);
        assert_eq!(src.ledger[0].interactions, 1);
        assert_eq!(src.ledger[0].tool_calls, 0);
        assert_eq!(src.ledger[0].tokens, 0);
    }
}
