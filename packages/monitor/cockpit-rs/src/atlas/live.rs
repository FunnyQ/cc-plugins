// Ports live.ts (I/O + caches) and live-sessions.ts (pure shaping) for the "Live now" panel.
use super::model::{Ctx, now_ms};
use super::session_files::{ClaudeSessionFile, read_session_files};
use jiff::Timestamp;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Mutex;

pub const STALE_CUTOFF_MS: i64 = 600_000;
pub const BUSY_CUTOFF_MS: i64 = 60_000;
const CACHE_TTL_MS: i64 = 5_000;
const ROW_LIMIT: i64 = 24;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub provider: String,
    pub id: String,
    pub project_name: String,
    pub cwd: String,
    // A session file without `status` leaves it undefined in TS, which JSON.stringify drops.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub status: String,
    pub status_source: String,
    pub updated_at: String,
    pub age_ms: i64,
    pub is_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cockpit: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct CodexRow {
    pub id: String,
    pub cwd: String,
    pub rollout_path: String,
    pub model: Option<String>,
    pub updated_at_ms: Option<f64>,
    pub updated_at: Option<f64>,
    pub created_at_ms: Option<f64>,
    pub created_at: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct OpenCodeRow {
    pub id: String,
    pub directory: String,
    pub time_created: Option<f64>,
    pub time_updated: Option<f64>,
}

// ---------- pure helpers (live-sessions.ts) ----------

pub fn project_name_for(cwd: &str) -> String {
    cwd.split('/')
        .rfind(|segment| !segment.is_empty())
        .unwrap_or(cwd)
        .to_owned()
}

pub fn status_rank(status: &str) -> u8 {
    match status {
        "busy" | "active-inferred" => 0,
        "waiting" => 1,
        "recent" => 2,
        "idle" => 3,
        _ => 4,
    }
}

// JS `||` chain: 0 and NULL both fall through.
pub fn codex_updated_at_ms(row: &CodexRow) -> f64 {
    let truthy = |v: Option<f64>| v.filter(|x| *x != 0.0 && !x.is_nan());
    truthy(row.updated_at_ms)
        .or_else(|| truthy(row.updated_at).map(|s| s * 1000.0))
        .or_else(|| truthy(row.created_at_ms))
        .unwrap_or_else(|| row.created_at.unwrap_or(0.0) * 1000.0)
}

pub fn parse_cockpit_keys(raw: &str) -> HashSet<String> {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return HashSet::new();
    };
    let Some(sessions) = parsed.get("sessions").and_then(Value::as_array) else {
        return HashSet::new();
    };
    sessions
        .iter()
        .filter_map(|s| {
            let id = s.get("sessionId")?.as_str()?;
            let provider = s
                .get("provider")
                .and_then(Value::as_str)
                .filter(|p| matches!(*p, "codex" | "opencode"))
                .unwrap_or("claude");
            Some(format!("{provider}:{id}"))
        })
        .collect()
}

fn opencode_timestamp_ms(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() && v > 0.0 => {
            if v < 1_000_000_000_000.0 {
                v * 1000.0
            } else {
                v
            }
        }
        _ => 0.0,
    }
}

// `new Date(ms).toISOString()`: Date truncates the ms toward zero.
fn iso(ms: f64) -> String {
    Timestamp::from_millisecond(ms.trunc() as i64)
        .map(|ts| ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

fn age(now: i64, updated_at_ms: f64) -> i64 {
    (now as f64 - updated_at_ms).max(0.0) as i64
}

fn value_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

pub fn build_claude_live_sessions(
    files: &[ClaudeSessionFile],
    cockpit_keys: &HashSet<String>,
    transcript_index: &HashMap<String, String>,
    now: i64,
) -> Vec<LiveSession> {
    files
        .iter()
        .map(|session| {
            let started = session.started_at.as_f64().unwrap_or(0.0);
            // `updatedAt ?? startedAt`: only null/undefined fall through.
            let updated_at_ms = session
                .updated_at
                .as_ref()
                .and_then(Value::as_f64)
                .unwrap_or(started);
            let age_ms = age(now, updated_at_ms);
            LiveSession {
                provider: "claude".into(),
                id: session.session_id.clone(),
                project_name: project_name_for(&session.cwd),
                cwd: session.cwd.clone(),
                status: session
                    .status
                    .as_ref()
                    .filter(|v| !v.is_null())
                    .map(value_text)
                    .unwrap_or_default(),
                status_source: "claude-session-file".into(),
                updated_at: iso(updated_at_ms),
                age_ms,
                is_stale: age_ms > STALE_CUTOFF_MS,
                transcript_path: transcript_index.get(&session.session_id).cloned(),
                model: None,
                version: session
                    .version
                    .as_ref()
                    .filter(|v| !v.is_null())
                    .map(value_text),
                cockpit: Some(cockpit_keys.contains(&format!("claude:{}", session.session_id))),
            }
        })
        .filter(|s| !s.is_stale)
        .collect()
}

fn inferred_status(age_ms: i64) -> &'static str {
    if age_ms <= BUSY_CUTOFF_MS {
        "active-inferred"
    } else {
        "recent"
    }
}

pub fn build_codex_live_sessions(
    rows: &[CodexRow],
    cockpit_keys: &HashSet<String>,
    now: i64,
    transcript_exists: impl Fn(&str) -> bool,
) -> Vec<LiveSession> {
    rows.iter()
        .map(|row| {
            let updated_at_ms = codex_updated_at_ms(row);
            let age_ms = age(now, updated_at_ms);
            LiveSession {
                provider: "codex".into(),
                id: row.id.clone(),
                project_name: project_name_for(&row.cwd),
                cwd: row.cwd.clone(),
                status: inferred_status(age_ms).into(),
                status_source: "codex-sqlite-rollout".into(),
                updated_at: iso(updated_at_ms),
                age_ms,
                is_stale: age_ms > STALE_CUTOFF_MS,
                transcript_path: Some(row.rollout_path.clone()).filter(|p| !p.is_empty()),
                model: row.model.clone(),
                version: None,
                cockpit: Some(cockpit_keys.contains(&format!("codex:{}", row.id))),
            }
        })
        .filter(|s| !s.is_stale && s.transcript_path.as_deref().is_some_and(&transcript_exists))
        .collect()
}

pub fn build_opencode_live_sessions(
    rows: &[OpenCodeRow],
    cockpit_keys: &HashSet<String>,
    now: i64,
) -> Vec<LiveSession> {
    rows.iter()
        .map(|row| {
            let updated = opencode_timestamp_ms(row.time_updated);
            let updated_at_ms = if updated != 0.0 {
                updated
            } else {
                opencode_timestamp_ms(row.time_created)
            };
            let age_ms = age(now, updated_at_ms);
            LiveSession {
                provider: "opencode".into(),
                id: row.id.clone(),
                project_name: project_name_for(&row.directory),
                cwd: row.directory.clone(),
                status: inferred_status(age_ms).into(),
                status_source: "opencode-sqlite-session".into(),
                updated_at: iso(updated_at_ms),
                age_ms,
                is_stale: age_ms > STALE_CUTOFF_MS,
                transcript_path: None,
                model: None,
                version: None,
                cockpit: Some(cockpit_keys.contains(&format!("opencode:{}", row.id))),
            }
        })
        .filter(|s| !s.is_stale)
        .collect()
}

// Stable, like Array.prototype.sort; every updatedAt comes from iso(), whose fixed width
// makes a descending string compare equal to TS's Date.parse difference.
pub fn sort_live_sessions(mut sessions: Vec<LiveSession>) -> Vec<LiveSession> {
    sessions.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    sessions
}

// ---------- I/O (live.ts) ----------

fn open_read_only(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn read_codex_thread_rows(now: i64) -> Vec<CodexRow> {
    let Some(db) = open_read_only(&super::paths::codex_state_db()) else {
        return Vec::new();
    };
    let query = || -> rusqlite::Result<Vec<CodexRow>> {
        let mut stmt = db.prepare(
            "select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, model
             from threads
             where archived = 0 and rollout_path != ''
               and coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) >= ?1
             order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
             limit ?2",
        )?;
        stmt.query_map((now - STALE_CUTOFF_MS, ROW_LIMIT), |r| {
            Ok(CodexRow {
                id: r.get(0)?,
                rollout_path: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                created_at_ms: r.get(4)?,
                updated_at_ms: r.get(5)?,
                cwd: r.get(6)?,
                model: r.get(8)?,
            })
        })?
        .collect()
    };
    query().unwrap_or_default()
}

fn read_opencode_session_rows() -> Vec<OpenCodeRow> {
    let Some(db) = open_read_only(&super::paths::opencode_db()) else {
        return Vec::new();
    };
    let query = || -> rusqlite::Result<Vec<OpenCodeRow>> {
        let mut stmt = db.prepare(
            "select id, directory, time_created, time_updated
             from session
             order by time_updated desc
             limit ?1",
        )?;
        stmt.query_map([ROW_LIMIT], |r| {
            Ok(OpenCodeRow {
                id: r.get(0)?,
                directory: r.get(1)?,
                time_created: r.get(2)?,
                time_updated: r.get(3)?,
            })
        })?
        .collect()
    };
    query().unwrap_or_default()
}

type Cache<T> = Mutex<Option<(i64, T)>>;

// One 5 s TTL slot keyed on now_ms(), shared by the three caches live.ts keeps.
fn cached<T: Clone>(slot: &Cache<T>, load: impl FnOnce() -> T) -> T {
    let now = now_ms();
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = guard.as_ref()
        && now - at < CACHE_TTL_MS
    {
        return value.clone();
    }
    let value = load();
    *guard = Some((now, value.clone()));
    value
}

static TRANSCRIPT_INDEX: Cache<HashMap<String, String>> = Mutex::new(None);
static COCKPIT_KEYS: Cache<HashSet<String>> = Mutex::new(None);
static DAEMON_PORT: Cache<Option<serde_json::Number>> = Mutex::new(None);

// Bun's Glob skips dot entries by default, so this walk does too.
fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_jsonl(&entry.path(), out);
        } else if file_type.is_file() && name.ends_with(".jsonl") {
            out.push(entry.path());
        }
    }
}

fn transcript_index() -> HashMap<String, String> {
    cached(&TRANSCRIPT_INDEX, || {
        let mut paths = Vec::new();
        walk_jsonl(&super::paths::projects_dir(), &mut paths);
        // Sorted so "first stem wins" is deterministic; Bun's scan order is unspecified.
        paths.sort();
        let mut index = HashMap::new();
        for path in paths {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let stem = name.trim_end_matches(".jsonl").to_owned();
            index
                .entry(stem)
                .or_insert_with(|| path.to_string_lossy().into_owned());
        }
        index
    })
}

fn cockpit_session_keys() -> HashSet<String> {
    cached(&COCKPIT_KEYS, || {
        std::fs::read_to_string(crate::paths::cockpit_home().join("registry.json"))
            .map(|raw| parse_cockpit_keys(&raw))
            .unwrap_or_default()
    })
}

pub fn cockpit_daemon_port() -> Option<serde_json::Number> {
    cached(&DAEMON_PORT, || {
        let raw = std::fs::read_to_string(crate::paths::cockpit_home().join("daemon.json")).ok()?;
        let info: Value = serde_json::from_str(&raw).ok()?;
        let pid = info.get("pid")?.as_f64()?;
        // process.kill rejects a fractional pid; pid <= 0 is dead here, where kill(0) would not be.
        let alive = pid.fract() == 0.0
            && pid.abs() <= i32::MAX as f64
            && crate::process_alive::is_alive(pid as i32);
        if !alive {
            return None;
        }
        Some(match info.get("port") {
            Some(Value::Number(port)) => port.clone(),
            _ => 5858.into(),
        })
    })
}

pub fn live_sessions(ctx: &Ctx) -> Vec<LiveSession> {
    let now = ctx.now_ms;
    let index = transcript_index();
    let keys = cockpit_session_keys();
    let mut all = build_claude_live_sessions(&read_session_files(), &keys, &index, now);
    all.extend(build_codex_live_sessions(
        &read_codex_thread_rows(now),
        &keys,
        now,
        |p| Path::new(p).exists(),
    ));
    all.extend(build_opencode_live_sessions(
        &read_opencode_session_rows(),
        &keys,
        now,
    ));
    sort_live_sessions(all)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveOutput {
    sessions: Vec<LiveSession>,
    cockpit_up: bool,
    cockpit_port: Option<serde_json::Number>,
}

pub fn run_cli(_args: &[String]) -> ExitCode {
    let cockpit_port = cockpit_daemon_port();
    // Live sessions never read plugin files, so no plugin-root lookup can fail here.
    let ctx = Ctx {
        now_ms: now_ms(),
        plugin_root: PathBuf::new(),
    };
    let out = LiveOutput {
        sessions: live_sessions(&ctx),
        cockpit_up: cockpit_port.is_some(),
        cockpit_port,
    };
    match serde_json::to_string_pretty(&out) {
        Ok(text) => {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(text.as_bytes());
            let _ = stdout.flush();
            ExitCode::SUCCESS
        }
        Err(_) => ExitCode::FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use std::sync::atomic::{AtomicI64, Ordering};

    const NOW: i64 = 1_700_000_000_000;

    // Each test pins a fresh clock far past the last one, so no cache from another test survives.
    static CLOCK: AtomicI64 = AtomicI64::new(NOW);
    fn fresh_now() -> i64 {
        let now = CLOCK.fetch_add(1_000_000, Ordering::SeqCst) + 1_000_000;
        TestEnv::set("TOKEN_ATLAS_NOW_MS", now.to_string());
        now
    }

    fn keys(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn project_name_for_cases() {
        assert_eq!(
            project_name_for("/Users/q/Projects/cc-plugins"),
            "cc-plugins"
        );
        assert_eq!(project_name_for("/Users/q/foo/"), "foo");
        assert_eq!(project_name_for(""), "");
    }

    #[test]
    fn status_rank_orders_busy_first_unknown_last() {
        let order: Vec<u8> = ["busy", "active-inferred", "waiting", "recent", "idle", "?"]
            .iter()
            .map(|s| status_rank(s))
            .collect();
        assert_eq!(order, vec![0, 0, 1, 2, 3, 4]);
    }

    fn codex_row() -> CodexRow {
        CodexRow {
            id: "c1".into(),
            cwd: "/Users/q/proj".into(),
            rollout_path: "/roll/c1.jsonl".into(),
            model: Some("o3".into()),
            updated_at: Some(0.0),
            created_at: Some(0.0),
            updated_at_ms: Some((NOW - 1000) as f64),
            created_at_ms: None,
        }
    }

    #[test]
    fn codex_updated_at_ms_falsy_fallbacks() {
        let with = |f: fn(&mut CodexRow)| {
            let mut row = CodexRow::default();
            f(&mut row);
            codex_updated_at_ms(&row)
        };
        let prefers_ms = with(|r| {
            r.updated_at_ms = Some(5.0);
            r.updated_at = Some(1.0);
            r.created_at = Some(0.0);
        });
        assert_eq!(prefers_ms, 5.0);
        let seconds = with(|r| {
            r.updated_at = Some(2.0);
            r.created_at = Some(0.0);
        });
        assert_eq!(seconds, 2000.0);
        let created = with(|r| {
            r.updated_at = Some(0.0);
            r.created_at = Some(3.0);
        });
        assert_eq!(created, 3000.0);
        // 0 in the ms column is falsy and falls through, unlike SQL coalesce.
        let zero_ms = with(|r| {
            r.updated_at_ms = Some(0.0);
            r.updated_at = Some(0.0);
            r.created_at_ms = Some(7.0);
        });
        assert_eq!(zero_ms, 7.0);
        assert_eq!(with(|_| {}), 0.0);
    }

    #[test]
    fn parse_cockpit_keys_cases() {
        let raw = r#"{"sessions":[{"sessionId":"a","provider":"codex"},{"sessionId":"o","provider":"opencode"},{"sessionId":"b"},{"provider":"codex"},{"sessionId":1},null]}"#;
        assert_eq!(
            parse_cockpit_keys(raw),
            keys(&["claude:b", "codex:a", "opencode:o"])
        );
        assert!(parse_cockpit_keys("not json").is_empty());
        assert!(parse_cockpit_keys(r#"{"sessions":"nope"}"#).is_empty());
        assert!(parse_cockpit_keys("").is_empty());
    }

    fn claude_file(extra: Value) -> ClaudeSessionFile {
        let mut base = serde_json::json!({
            "sessionId": "s1", "cwd": "/Users/q/proj", "status": "busy", "startedAt": NOW - 1000
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn claude_maps_fresh_session_with_cockpit_and_transcript() {
        let index = HashMap::from([("s1".to_string(), "/path/s1.jsonl".to_string())]);
        let out = build_claude_live_sessions(
            &[claude_file(serde_json::json!({"version": "2.1"}))],
            &keys(&["claude:s1"]),
            &index,
            NOW,
        );
        assert_eq!(
            out,
            vec![LiveSession {
                provider: "claude".into(),
                id: "s1".into(),
                project_name: "proj".into(),
                cwd: "/Users/q/proj".into(),
                status: "busy".into(),
                status_source: "claude-session-file".into(),
                updated_at: iso((NOW - 1000) as f64),
                age_ms: 1000,
                is_stale: false,
                transcript_path: Some("/path/s1.jsonl".into()),
                model: None,
                version: Some("2.1".into()),
                cockpit: Some(true),
            }]
        );
    }

    #[test]
    fn claude_unregistered_serializes_cockpit_false() {
        let out = build_claude_live_sessions(
            &[claude_file(serde_json::json!({}))],
            &HashSet::new(),
            &HashMap::new(),
            NOW,
        );
        let json = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(json["cockpit"], Value::Bool(false));
        assert!(json.get("transcriptPath").is_none());
    }

    #[test]
    fn claude_prefers_updated_at_over_started_at() {
        let out = build_claude_live_sessions(
            &[claude_file(serde_json::json!({"updatedAt": NOW - 2000}))],
            &HashSet::new(),
            &HashMap::new(),
            NOW,
        );
        assert_eq!(out[0].age_ms, 2000);
    }

    #[test]
    fn claude_drops_stale_sessions() {
        let out = build_claude_live_sessions(
            &[claude_file(
                serde_json::json!({"startedAt": NOW - STALE_CUTOFF_MS - 1}),
            )],
            &HashSet::new(),
            &HashMap::new(),
            NOW,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn codex_infers_active_and_requires_transcript() {
        let out = build_codex_live_sessions(&[codex_row()], &keys(&["codex:c1"]), NOW, |_| true);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].provider, "codex");
        assert_eq!(out[0].status, "active-inferred");
        assert_eq!(out[0].model.as_deref(), Some("o3"));
        assert_eq!(out[0].cockpit, Some(true));
    }

    #[test]
    fn codex_older_but_fresh_is_recent() {
        let mut row = codex_row();
        row.updated_at_ms = Some((NOW - BUSY_CUTOFF_MS - 1000) as f64);
        let out = build_codex_live_sessions(&[row], &HashSet::new(), NOW, |_| true);
        assert_eq!(out[0].status, "recent");
        assert_eq!(out[0].cockpit, Some(false));
    }

    #[test]
    fn codex_drops_missing_transcript_empty_path_and_stale() {
        let none = HashSet::new();
        assert!(build_codex_live_sessions(&[codex_row()], &none, NOW, |_| false).is_empty());
        let mut empty = codex_row();
        empty.rollout_path = String::new();
        assert!(build_codex_live_sessions(&[empty], &none, NOW, |_| true).is_empty());
        let mut stale = codex_row();
        stale.updated_at_ms = Some((NOW - STALE_CUTOFF_MS - 1) as f64);
        assert!(build_codex_live_sessions(&[stale], &none, NOW, |_| true).is_empty());
    }

    fn oc_row() -> OpenCodeRow {
        OpenCodeRow {
            id: "o1".into(),
            directory: "/Users/q/proj".into(),
            time_created: Some((NOW - 2000) as f64),
            time_updated: Some((NOW - 1000) as f64),
        }
    }

    #[test]
    fn opencode_maps_fresh_session() {
        let out = build_opencode_live_sessions(&[oc_row()], &keys(&["opencode:o1"]), NOW);
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.provider, "opencode");
        assert_eq!(s.id, "o1");
        assert_eq!(s.project_name, "proj");
        assert_eq!(s.status, "active-inferred");
        assert_eq!(s.status_source, "opencode-sqlite-session");
        assert_eq!(s.cockpit, Some(true));
        assert!(!s.is_stale);
    }

    #[test]
    fn opencode_recent_seconds_and_stale() {
        let none = HashSet::new();
        let mut recent = oc_row();
        recent.time_updated = Some((NOW - BUSY_CUTOFF_MS - 1000) as f64);
        assert_eq!(
            build_opencode_live_sessions(&[recent], &none, NOW)[0].status,
            "recent"
        );
        let seconds = OpenCodeRow {
            time_created: Some(((NOW - 2000) / 1000) as f64),
            time_updated: Some(((NOW - 1000) / 1000) as f64),
            ..oc_row()
        };
        let out = build_opencode_live_sessions(&[seconds], &none, NOW);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].age_ms, 1000);
        let mut stale = oc_row();
        stale.time_updated = Some((NOW - STALE_CUTOFF_MS - 1) as f64);
        assert!(build_opencode_live_sessions(&[stale], &none, NOW).is_empty());
        let zero = OpenCodeRow {
            time_updated: Some(0.0),
            ..oc_row()
        };
        assert_eq!(
            build_opencode_live_sessions(&[zero], &none, NOW)[0].age_ms,
            2000
        );
    }

    #[test]
    fn sort_by_status_then_most_recent() {
        let s = |status: &str, updated_at: &str| LiveSession {
            provider: "claude".into(),
            id: format!("{status}{updated_at}"),
            project_name: "p".into(),
            cwd: "/p".into(),
            status: status.into(),
            status_source: "claude-session-file".into(),
            updated_at: updated_at.into(),
            age_ms: 0,
            is_stale: false,
            transcript_path: None,
            model: None,
            version: None,
            cockpit: None,
        };
        let sorted = sort_live_sessions(vec![
            s("idle", "2026-01-01T00:00:00Z"),
            s("busy", "2026-01-01T00:00:00Z"),
            s("busy", "2026-01-02T00:00:00Z"),
        ]);
        let got: Vec<(String, String)> = sorted
            .into_iter()
            .map(|x| (x.status, x.updated_at))
            .collect();
        let want: Vec<(String, String)> = [
            ("busy", "2026-01-02T00:00:00Z"),
            ("busy", "2026-01-01T00:00:00Z"),
            ("idle", "2026-01-01T00:00:00Z"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        assert_eq!(got, want);
    }

    fn write_daemon(env: &TestEnv, body: &str) {
        let dir = env.dir.path().join("cockpit");
        std::fs::create_dir_all(&dir).unwrap();
        TestEnv::set("COCKPIT_HOME", &dir);
        std::fs::write(dir.join("daemon.json"), body).unwrap();
    }

    fn me() -> u32 {
        std::process::id()
    }

    #[test]
    fn daemon_port_rules() {
        let env = TestEnv::new();
        let cases: Vec<(String, Option<serde_json::Number>)> = vec![
            (
                format!(r#"{{"pid":{},"port":70000}}"#, me()),
                Some(70000.into()),
            ),
            (
                format!(r#"{{"pid":{},"port":5999.5}}"#, me()),
                serde_json::Number::from_f64(5999.5),
            ),
            (
                format!(r#"{{"pid":{},"port":"x"}}"#, me()),
                Some(5858.into()),
            ),
            (format!(r#"{{"pid":{}}}"#, me()), Some(5858.into())),
            (r#"{"pid":999999999,"port":1}"#.into(), None),
            (format!(r#"{{"pid":"{}","port":1}}"#, me()), None),
            ("{corrupt".into(), None),
        ];
        for (body, expected) in cases {
            fresh_now();
            write_daemon(&env, &body);
            assert_eq!(cockpit_daemon_port(), expected, "{body}");
        }
        fresh_now();
        std::fs::remove_file(env.dir.path().join("cockpit/daemon.json")).unwrap();
        assert_eq!(cockpit_daemon_port(), None);
    }

    #[test]
    fn daemon_port_cache_honours_ttl() {
        let env = TestEnv::new();
        let t = fresh_now();
        write_daemon(&env, &format!(r#"{{"pid":{},"port":6001}}"#, me()));
        assert_eq!(cockpit_daemon_port(), Some(6001.into()));
        write_daemon(&env, &format!(r#"{{"pid":{},"port":6002}}"#, me()));
        TestEnv::set("TOKEN_ATLAS_NOW_MS", (t + CACHE_TTL_MS - 1).to_string());
        assert_eq!(cockpit_daemon_port(), Some(6001.into()));
        TestEnv::set("TOKEN_ATLAS_NOW_MS", (t + CACHE_TTL_MS).to_string());
        assert_eq!(cockpit_daemon_port(), Some(6002.into()));
        // A cached None is reused too.
        let t = fresh_now();
        std::fs::remove_file(env.dir.path().join("cockpit/daemon.json")).unwrap();
        assert_eq!(cockpit_daemon_port(), None);
        write_daemon(&env, &format!(r#"{{"pid":{},"port":6003}}"#, me()));
        TestEnv::set("TOKEN_ATLAS_NOW_MS", (t + 1).to_string());
        assert_eq!(cockpit_daemon_port(), None);
    }

    #[test]
    fn missing_dbs_and_registry_yield_empty() {
        let env = TestEnv::new();
        let now = fresh_now();
        TestEnv::set("COCKPIT_HOME", env.dir.path().join("nope"));
        assert!(read_codex_thread_rows(now).is_empty());
        assert!(read_opencode_session_rows().is_empty());
        assert!(cockpit_session_keys().is_empty());
        let ctx = Ctx {
            now_ms: now,
            plugin_root: PathBuf::new(),
        };
        assert!(live_sessions(&ctx).is_empty());
    }

    #[test]
    fn corrupt_registry_yields_empty_and_is_cached() {
        let env = TestEnv::new();
        let t = fresh_now();
        let dir = env.dir.path().join("cockpit");
        std::fs::create_dir_all(&dir).unwrap();
        TestEnv::set("COCKPIT_HOME", &dir);
        std::fs::write(dir.join("registry.json"), "{corrupt").unwrap();
        assert!(cockpit_session_keys().is_empty());
        std::fs::write(
            dir.join("registry.json"),
            r#"{"sessions":[{"sessionId":"x"}]}"#,
        )
        .unwrap();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", (t + 10).to_string());
        assert!(cockpit_session_keys().is_empty());
        TestEnv::set("TOKEN_ATLAS_NOW_MS", (t + CACHE_TTL_MS).to_string());
        assert_eq!(cockpit_session_keys(), keys(&["claude:x"]));
    }

    #[test]
    fn reads_codex_and_opencode_rows_filtering_archived_and_missing_rollouts() {
        let env = TestEnv::new();
        let now = fresh_now();
        let home = env.dir.path();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let rollout = home.join("r.jsonl");
        std::fs::write(&rollout, "").unwrap();
        let db = Connection::open(home.join(".codex/state_5.sqlite")).unwrap();
        db.execute_batch(
            "create table threads (id text, rollout_path text, created_at integer, updated_at integer,
             created_at_ms integer, updated_at_ms integer, cwd text, title text, model text, archived integer)",
        )
        .unwrap();
        let r = rollout.to_string_lossy().to_string();
        for (id, path, ms, archived) in [
            ("live", r.as_str(), now - 1000, 0),
            ("arch", r.as_str(), now - 1000, 1),
            ("gone", "/definitely/missing.jsonl", now - 1000, 0),
            ("old", r.as_str(), now - STALE_CUTOFF_MS - 1, 0),
        ] {
            db.execute(
                "insert into threads values (?1, ?2, 0, 0, null, ?3, '/w/p', 't', null, ?4)",
                (id, path, ms, archived),
            )
            .unwrap();
        }
        let oc = home.join("oc.db");
        TestEnv::set("COCKPIT_OPENCODE_DB", &oc);
        let odb = Connection::open(&oc).unwrap();
        odb.execute_batch(&format!(
            "create table session (id text, directory text, time_created integer, time_updated integer);
             insert into session values ('o', '/w/q', {}, {});",
            now - 5000,
            now - 120_000
        ))
        .unwrap();
        let ctx = Ctx {
            now_ms: now,
            plugin_root: PathBuf::new(),
        };
        let out = live_sessions(&ctx);
        let ids: Vec<(&str, &str)> = out
            .iter()
            .map(|s| (s.id.as_str(), s.status.as_str()))
            .collect();
        assert_eq!(ids, vec![("live", "active-inferred"), ("o", "recent")]);
        assert_eq!(out[0].model, None);
    }

    #[test]
    fn transcript_index_first_stem_wins_and_skips_dot_dirs() {
        let env = TestEnv::new();
        fresh_now();
        let projects = env.dir.path().join(".claude/projects");
        std::fs::create_dir_all(projects.join("a/sub")).unwrap();
        std::fs::create_dir_all(projects.join(".hidden")).unwrap();
        std::fs::write(projects.join("a/s1.jsonl"), "").unwrap();
        std::fs::write(projects.join("a/sub/s1.jsonl"), "").unwrap();
        std::fs::write(projects.join(".hidden/h.jsonl"), "").unwrap();
        let index = transcript_index();
        assert_eq!(
            index.get("s1"),
            Some(&projects.join("a/s1.jsonl").to_string_lossy().into_owned())
        );
        assert!(!index.contains_key("h"));
    }
}
