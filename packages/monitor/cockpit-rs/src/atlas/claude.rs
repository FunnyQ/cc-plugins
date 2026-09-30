// Port of api.ts's Claude source: stats-cache, history, the rollup aggregates and ledger,
// and the statusline rate-limit windows.
use super::model::{
    Ctx, InternalLedgerRow, LedgerCostBasis, ModelUsage, Provider, ProviderUsage, UsageLimits,
    add_hourly_usage, add_model_usage, add_nested_model_usage, build_usage_limit_window,
    display_path, empty_model_usage, fmt_date, model_key, model_usage_total, now_ms, project_name,
};
use super::{dedup, jsonl, paths, rollup_db, rollup_update};
use indexmap::IndexMap;
use jiff::{Timestamp, tz::TimeZone};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const RATE_LIMITS_STALE_AFTER_MS: f64 = 5.0 * 60.0 * 1000.0;
const FIVE_HOUR_MS: i64 = 18_000_000;
const SEVEN_DAY_MS: i64 = 604_800_000;

// ---------- Types ----------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCacheDailyActivity {
    pub date: String,
    pub message_count: i64,
    pub session_count: i64,
    pub tool_call_count: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCacheDailyModelTokens {
    pub date: String,
    pub tokens_by_model: IndexMap<String, i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCacheLongestSession {
    pub session_id: String,
    pub duration: i64,
    pub message_count: i64,
    pub timestamp: String,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCache {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_computed_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_activity: Option<Vec<StatsCacheDailyActivity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_model_tokens: Option<Vec<StatsCacheDailyModelTokens>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<IndexMap<String, ModelUsage>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hour_counts: Option<IndexMap<String, i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_sessions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_messages: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longest_session: Option<StatsCacheLongestSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_session_date: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProject {
    pub message_count: i64,
    pub first_seen: i64,
    pub last_seen: i64,
    pub path: String,
}

#[derive(Clone, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    pub message_count: i64,
    // BTreeSet serializes sorted, as sourceReplacer's `[...set].sort()`.
    pub session_ids: BTreeSet<String>,
}

#[derive(Clone, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub by_project: IndexMap<String, HistoryProject>,
    pub week_hour_matrix: [[i64; 24]; 7],
    pub daily_history: IndexMap<String, HistoryDay>,
    pub daily_hour_counts: IndexMap<String, [i64; 24]>,
}

pub struct ClaudeSource {
    pub usage: ProviderUsage,
    pub ledger: Vec<InternalLedgerRow>,
    pub transcript_file_count: usize,
    pub stats_cache: StatsCache,
    pub history: History,
}

// ---------- Parsers ----------

fn parse_stats_cache() -> anyhow::Result<StatsCache> {
    let path = paths::stats_cache();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| anyhow::anyhow!("Missing or unreadable: {}", path.display()))
}

fn parse_history(now: i64) -> History {
    let mut history = History::default();
    let path = paths::history();
    if !path.exists() {
        return history;
    }
    let tz = TimeZone::system();
    for line in jsonl::read_jsonl_lines(&path, Default::default()) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts = entry
            .get("timestamp")
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0);
        if ts != 0
            && let Ok(stamp) = Timestamp::from_millisecond(ts)
        {
            let local = stamp.to_zoned(tz.clone());
            let weekday = local.weekday().to_sunday_zero_offset() as usize;
            let hour = local.hour() as usize;
            history.week_hour_matrix[weekday][hour] += 1;
            let date = fmt_date(ts);
            let daily = history.daily_history.entry(date.clone()).or_default();
            daily.message_count += 1;
            if let Some(session_id) = entry
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                daily.session_ids.insert(session_id.to_owned());
            }
            history.daily_hour_counts.entry(date).or_insert([0; 24])[hour] += 1;
        }
        let Some(project) = entry
            .get("project")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        match history.by_project.get_mut(project) {
            Some(cur) => {
                cur.message_count += 1;
                if ts != 0 && ts < cur.first_seen {
                    cur.first_seen = ts;
                }
                if ts != 0 && ts > cur.last_seen {
                    cur.last_seen = ts;
                }
            }
            None => {
                history.by_project.insert(
                    project.to_owned(),
                    HistoryProject {
                        message_count: 1,
                        first_seen: if ts != 0 { ts } else { now },
                        last_seen: ts,
                        path: project.to_owned(),
                    },
                );
            }
        }
    }
    history
}

// hour_ms = 0 rows are timeless: counted in model/project totals, never in hourly/daily maps.
fn read_rollup_aggregates(db: &Connection) -> rusqlite::Result<ProviderUsage> {
    let mut out = ProviderUsage::default();
    for r in rollup_db::all_hourly_rows(db)? {
        let usage = ModelUsage {
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cache_read_input_tokens: r.cache_read,
            cache_creation_input_tokens: r.cache_creation,
            reasoning_output_tokens: Some(r.reasoning),
            ..Default::default()
        };
        // Keyed by raw model; stats assembly applies model_key.
        add_model_usage(
            out.model_usage
                .entry(r.model.clone())
                .or_insert_with(empty_model_usage),
            &usage,
        );
        if !r.project.is_empty() {
            add_nested_model_usage(&mut out.project_model_usage, &r.project, &r.model, &usage);
            *out.project_tokens.entry(r.project.clone()).or_insert(0) += model_usage_total(&usage);
        }
        if r.hour_ms != 0 {
            add_hourly_usage(
                &mut out.hourly_usage,
                r.hour_ms,
                &model_key(Provider::Claude, &r.model),
                &usage,
            );
            add_nested_model_usage(
                &mut out.daily_model_usage,
                &fmt_date(r.hour_ms),
                &r.model,
                &usage,
            );
        }
    }
    Ok(out)
}

fn read_rollup_ledger(db: &Connection) -> rusqlite::Result<Vec<InternalLedgerRow>> {
    let mut by_session: IndexMap<String, InternalLedgerRow> = IndexMap::new();
    // Rows arrive ordered by (project_ts_ms, path), so the first project is the origin cwd.
    for r in rollup_db::all_ledger_rows(db)? {
        let row = by_session
            .entry(r.session_key.clone())
            .or_insert_with(|| InternalLedgerRow {
                id: format!("claude:{}", r.session_key),
                provider: Provider::Claude,
                timestamp_ms: 0,
                date: String::new(),
                project_path: String::new(),
                project_name: "n/a".into(),
                model: "n/a".into(),
                interactions: 0,
                tool_calls: 0,
                tokens: 0,
                cost_basis: LedgerCostBasis::Unavailable,
                usage_by_model: IndexMap::new(),
            });
        if r.last_ts_ms > row.timestamp_ms {
            row.timestamp_ms = r.last_ts_ms;
            row.date = fmt_date(r.last_ts_ms);
        }
        if row.project_path.is_empty() && !r.project.is_empty() {
            row.project_name = project_name(&r.project);
            row.project_path = r.project;
        }
        row.interactions += r.interactions;
        row.tool_calls += r.tool_calls;
    }

    for m in rollup_db::all_ledger_model_rows(db)? {
        let Some(row) = by_session.get_mut(&m.session_key) else {
            continue;
        };
        let usage = row
            .usage_by_model
            .entry(model_key(Provider::Claude, &m.model))
            .or_insert_with(empty_model_usage);
        usage.input_tokens += m.input_tokens;
        usage.output_tokens += m.output_tokens;
        usage.cache_read_input_tokens += m.cache_read;
        usage.cache_creation_input_tokens += m.cache_creation;
        row.tokens += m.input_tokens + m.output_tokens + m.cache_read + m.cache_creation;
        row.cost_basis = LedgerCostBasis::Usage;
    }

    Ok(by_session
        .into_values()
        .map(|mut row| {
            if row.usage_by_model.len() == 1 {
                row.model = row
                    .usage_by_model
                    .keys()
                    .next()
                    .cloned()
                    .unwrap_or_default();
            } else if row.usage_by_model.len() > 1 {
                row.model = "mixed".into();
            }
            row
        })
        .filter(|row| {
            row.timestamp_ms > 0 && (row.interactions > 0 || row.tokens > 0 || row.tool_calls > 0)
        })
        .collect())
}

fn read_rollup(projects_dir: &Path) -> anyhow::Result<(ProviderUsage, Vec<InternalLedgerRow>)> {
    let mut db = rollup_db::open_rollup_db(&paths::rollup_db_path())?;
    rollup_update::update_rollup(
        &mut db,
        projects_dir,
        rollup_update::UpdateOptions { rebuild: false },
    )?;
    Ok((read_rollup_aggregates(&db)?, read_rollup_ledger(&db)?))
}

pub fn load(ctx: &Ctx) -> anyhow::Result<ClaudeSource> {
    // Directory listing only; transcript bytes are read solely by update_rollup.
    let projects_dir = paths::projects_dir();
    let mut files: Vec<PathBuf> = Vec::new();
    dedup::walk_files(&projects_dir, ".jsonl", &mut files);
    // An unopenable rollup empties Claude's usage rather than failing the payload, as TS does.
    let (usage, ledger) = read_rollup(&projects_dir).unwrap_or_default();
    Ok(ClaudeSource {
        usage,
        ledger,
        transcript_file_count: files.len(),
        stats_cache: parse_stats_cache()?,
        history: parse_history(ctx.now_ms),
    })
}

// ---------- Usage limits ----------

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub fn read_usage_limits(_ctx: &Ctx) -> UsageLimits {
    let path = paths::rate_limits_cache();
    let mut limits = UsageLimits {
        source: "statusline-cache".into(),
        path: display_path(&path),
        captured_at: None,
        stale: true,
        error: None,
        plan: None,
        five_hour: None,
        weekly: None,
    };
    if !path.exists() {
        limits.error = Some("missing".into());
        return limits;
    }
    // The message is serde's or the OS's, not JS's SyntaxError text; the fixture never hits it.
    let data = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
    {
        Ok(Value::Null) => {
            limits.error = Some("unreadable".into());
            return limits;
        }
        Ok(data) => data,
        Err(message) => {
            limits.error = Some(message);
            return limits;
        }
    };

    let captured_at = data.get("capturedAt").and_then(Value::as_str);
    let captured_at_ms = match data.get("capturedAtEpochMs").filter(|v| !v.is_null()) {
        Some(epoch) => epoch.as_f64().unwrap_or(f64::NAN),
        // jiff accepts RFC 3339 only; Date.parse also takes looser forms the collector never writes.
        None => captured_at
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<Timestamp>().ok())
            .map_or(f64::NAN, |ts| ts.as_millisecond() as f64),
    };
    let now = now_ms();
    limits.stale =
        !captured_at_ms.is_finite() || now as f64 - captured_at_ms > RATE_LIMITS_STALE_AFTER_MS;
    limits.captured_at = captured_at.map(str::to_owned);

    let Some(rate_limits) = data.get("rate_limits").filter(|v| js_truthy(Some(v))) else {
        limits.error = Some("missing-rate-limits".into());
        return limits;
    };
    limits.five_hour = build_usage_limit_window(rate_limits.get("five_hour"), FIVE_HOUR_MS, now);
    limits.weekly = build_usage_limit_window(rate_limits.get("seven_day"), SEVEN_DAY_MS, now);
    limits
}

/// The full `--source claude` shape, usageLimits included.
pub fn source_json(ctx: &Ctx, src: &ClaudeSource) -> serde_json::Value {
    json!({
        "usage": {
            "modelUsage": src.usage.model_usage,
            "dailyModelUsage": src.usage.daily_model_usage,
            "hourlyUsage": src.usage.hourly_usage,
            "projectTokens": src.usage.project_tokens,
            "projectModelUsage": src.usage.project_model_usage,
        },
        "ledger": src.ledger,
        "transcriptFileCount": src.transcript_file_count,
        "statsCache": src.stats_cache,
        "history": src.history,
        "usageLimits": read_usage_limits(ctx),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use rollup_db::{HourlyRow, LedgerFileRow, LedgerModelRow};

    const NOW: i64 = 1_790_870_400_000;

    fn ctx() -> Ctx {
        Ctx {
            now_ms: NOW,
            plugin_root: PathBuf::new(),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn temp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let db = rollup_db::open_rollup_db(&dir.path().join("rollup.db")).unwrap();
        (dir, db)
    }

    #[test]
    fn timeless_rows_count_in_totals_only() {
        let (_dir, db) = temp_db();
        let base = HourlyRow {
            project: "/p".into(),
            model: "claude-opus-4-7".into(),
            input_tokens: 10,
            output_tokens: 5,
            reasoning: 1,
            ..Default::default()
        };
        rollup_db::add_hourly_row(&db, &base).unwrap();
        let hour = dedup::hour_start_ms(NOW);
        rollup_db::add_hourly_row(
            &db,
            &HourlyRow {
                hour_ms: hour,
                project: String::new(),
                ..base.clone()
            },
        )
        .unwrap();
        let usage = read_rollup_aggregates(&db).unwrap();
        assert_eq!(usage.model_usage["claude-opus-4-7"].input_tokens, 20);
        assert_eq!(usage.project_tokens["/p"], 16);
        assert_eq!(
            usage.project_model_usage["/p"]["claude-opus-4-7"].input_tokens,
            10
        );
        assert_eq!(usage.hourly_usage.len(), 1);
        assert_eq!(
            usage.hourly_usage[&hour].usage_by_model["claude:claude-opus-4-7"].input_tokens,
            10
        );
        assert_eq!(
            usage.daily_model_usage.keys().collect::<Vec<_>>(),
            [&fmt_date(hour)]
        );
    }

    #[test]
    fn multi_file_session_sums_into_one_row_with_origin_cwd() {
        let (_dir, db) = temp_db();
        let ledger = |path: &str, key: &str, project: &str, project_ts_ms: i64, last_ts_ms: i64| {
            LedgerFileRow {
                path: path.into(),
                session_key: key.into(),
                project: project.into(),
                project_ts_ms,
                last_ts_ms,
                interactions: 2,
                tool_calls: 3,
            }
        };
        // The file that sorts first by path carries the later project_ts_ms.
        rollup_db::add_ledger_row(&db, &ledger("/a.jsonl", "s1", "/repo/sub", 200, NOW)).unwrap();
        rollup_db::add_ledger_row(&db, &ledger("/b.jsonl", "s1", "/repo", 100, NOW - 5)).unwrap();
        rollup_db::add_ledger_row(&db, &ledger("/c.jsonl", "bare", "", 0, NOW)).unwrap();
        rollup_db::add_ledger_row(
            &db,
            &LedgerFileRow {
                interactions: 0,
                tool_calls: 0,
                ..ledger("/d.jsonl", "idle", "", 0, NOW)
            },
        )
        .unwrap();
        for path in ["/a.jsonl", "/b.jsonl"] {
            rollup_db::add_ledger_model_row(
                &db,
                &LedgerModelRow {
                    path: path.into(),
                    session_key: "s1".into(),
                    model: "m1".into(),
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_read: 3,
                    cache_creation: 4,
                },
            )
            .unwrap();
        }
        let rows = read_rollup_ledger(&db).unwrap();
        assert_eq!(rows.len(), 2, "the idle session is filtered out");
        let s1 = rows.iter().find(|r| r.id == "claude:s1").unwrap();
        assert_eq!(s1.project_path, "/repo");
        assert_eq!(s1.project_name, "repo");
        assert_eq!(s1.timestamp_ms, NOW);
        assert_eq!(s1.date, fmt_date(NOW));
        assert_eq!((s1.interactions, s1.tool_calls, s1.tokens), (4, 6, 20));
        assert_eq!(s1.model, "claude:m1");
        assert_eq!(s1.cost_basis, LedgerCostBasis::Usage);
        let bare = rows.iter().find(|r| r.id == "claude:bare").unwrap();
        assert_eq!(
            (bare.model.as_str(), bare.project_name.as_str()),
            ("n/a", "n/a")
        );
        assert_eq!(bare.cost_basis, LedgerCostBasis::Unavailable);
    }

    #[test]
    fn history_skips_blank_and_malformed_lines() {
        let env = TestEnv::new();
        let ts = 1_790_858_096_789_i64;
        let lines = [
            String::new(),
            "{not json".into(),
            format!(r#"{{"timestamp":{ts},"project":"/p","sessionId":"b"}}"#),
            "   ".into(),
            format!(
                r#"{{"timestamp":{},"project":"/p","sessionId":"a"}}"#,
                ts - 1000
            ),
            r#"{"project":"/q"}"#.into(),
            format!(r#"{{"timestamp":{ts},"project":""}}"#),
        ];
        write(
            &env.dir.path().join(".claude/history.jsonl"),
            &(lines.join("\n") + "\n"),
        );
        let history = parse_history(NOW);
        let date = fmt_date(ts);
        assert_eq!(history.daily_history[&date].message_count, 3);
        assert_eq!(history.daily_hour_counts[&date].iter().sum::<i64>(), 3);
        assert_eq!(history.week_hour_matrix.iter().flatten().sum::<i64>(), 3);
        assert_eq!(
            history.by_project["/p"],
            HistoryProject {
                message_count: 2,
                first_seen: ts - 1000,
                last_seen: ts,
                path: "/p".into()
            }
        );
        assert_eq!(
            (
                history.by_project["/q"].first_seen,
                history.by_project["/q"].last_seen
            ),
            (NOW, 0)
        );
        assert_eq!(history.by_project.len(), 2);
        let json = serde_json::to_value(&history).unwrap();
        assert_eq!(json["dailyHistory"][&date]["sessionIds"], json!(["a", "b"]));
    }

    #[test]
    fn missing_history_is_empty() {
        let _env = TestEnv::new();
        assert_eq!(parse_history(NOW), History::default());
    }

    #[test]
    fn usage_limits_branches() {
        let env = TestEnv::new();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", NOW.to_string());
        let file = env.dir.path().join(".cache/token-atlas/rate-limits.json");

        let missing = read_usage_limits(&ctx());
        assert_eq!(missing.error.as_deref(), Some("missing"));
        assert_eq!(missing.path, "~/.cache/token-atlas/rate-limits.json");
        assert!(missing.stale);

        write(&file, "{nope");
        let bad = read_usage_limits(&ctx());
        assert!(bad.error.is_some_and(|e| e != "missing"));

        write(&file, "null");
        assert_eq!(
            read_usage_limits(&ctx()).error.as_deref(),
            Some("unreadable")
        );

        write(
            &file,
            &format!(r#"{{"capturedAt":"x","capturedAtEpochMs":{}}}"#, NOW - 1000),
        );
        let no_limits = read_usage_limits(&ctx());
        assert_eq!(no_limits.error.as_deref(), Some("missing-rate-limits"));
        assert_eq!(no_limits.captured_at.as_deref(), Some("x"));
        assert!(!no_limits.stale);

        // Stale through the ISO fallback: 5 min + 1 ms old.
        let old = Timestamp::from_millisecond(NOW - 300_001).unwrap();
        write(
            &file,
            &format!(
                r#"{{"capturedAt":"{old}","rate_limits":{{"five_hour":{{"used_percentage":40,"resets_at":{}}}}}}}"#,
                NOW / 1000 + 3600
            ),
        );
        let stale = read_usage_limits(&ctx());
        assert!(stale.stale);
        assert_eq!(stale.error, None);
        let five = stale.five_hour.clone().unwrap();
        assert_eq!(five.used_percent, Some(40.0));
        assert_eq!(five.duration_ms, FIVE_HOUR_MS);
        assert_eq!(five.remaining_ms, Some(3_600_000.0));
        assert_eq!(stale.weekly, None);
        assert!(serde_json::to_value(&stale).unwrap().get("plan").is_none());

        // Exactly 5 min old is fresh; no timestamp at all is stale.
        write(
            &file,
            &format!(r#"{{"capturedAtEpochMs":{}}}"#, NOW - 300_000),
        );
        assert!(!read_usage_limits(&ctx()).stale);
        write(&file, "{}");
        assert!(read_usage_limits(&ctx()).stale);
    }

    #[test]
    fn load_errors_and_fallbacks() {
        let env = TestEnv::new();
        let home = env.dir.path();
        write(&home.join(".claude/projects/p/a.jsonl"), "");
        write(&home.join(".claude/projects/p/b.jsonl"), "");
        let err = load(&ctx()).err().unwrap().to_string();
        assert!(err.starts_with("Missing or unreadable: "), "{err}");

        write(
            &home.join(".claude/stats-cache.json"),
            r#"{"version":2,"extra":1}"#,
        );
        write(&home.join("not-a-dir"), "");
        TestEnv::set("TOKEN_ATLAS_ROLLUP_DB", home.join("not-a-dir/rollup.db"));
        let src = load(&ctx()).unwrap();
        assert_eq!(src.transcript_file_count, 2);
        assert!(src.usage.model_usage.is_empty());
        assert!(src.ledger.is_empty());
        let json = source_json(&ctx(), &src);
        assert_eq!(json["statsCache"], json!({"version": 2}));
        assert_eq!(json["transcriptFileCount"], json!(2));
        assert_eq!(json["usageLimits"]["error"], json!("missing"));
    }
}
