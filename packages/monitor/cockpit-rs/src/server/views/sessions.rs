use super::{session_title::resolve_historical_session_title, subagents};
use crate::{
    call_log::latest_open_call_id,
    paths,
    registry::{self, LiveStatus, Provider, SessionStatus, TitleUpdate},
    server::{AppState, sources},
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{cmp::Ordering, collections::HashSet, fs, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub provider: Provider,
    pub project: String,
    pub session_id: String,
    pub title: String,
    pub log_path: String,
    pub status: SessionStatus,
    pub live_status: LiveStatus,
    pub subagents: u32,
    pub channel: bool,
    pub last_heartbeat: String,
    pub tracked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub project: String,
    pub name: String,
    pub active_count: usize,
    pub session_count: usize,
    pub last_heartbeat: String,
}

struct LiveSession {
    provider: Provider,
    id: String,
    cwd: String,
    title: String,
    updated_at_ms: i64,
    status: String,
}

fn parsed_date(value: &str) -> Option<jiff::Timestamp> {
    if value.len() == 10 {
        format!("{value}T00:00:00Z").parse().ok()
    } else {
        value.parse().ok()
    }
}

fn date_order(a: &str, b: &str) -> Ordering {
    // Invalid dates compare equally, matching a JavaScript NaN comparator.
    match (parsed_date(a), parsed_date(b)) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => Ordering::Equal,
    }
}

fn session_order(a: &SessionView, b: &SessionView) -> Ordering {
    (b.status == SessionStatus::Active)
        .cmp(&(a.status == SessionStatus::Active))
        .then_with(|| date_order(&a.last_heartbeat, &b.last_heartbeat))
}

fn active_subagents(active: bool, provider: Provider, id: &str, now: i64) -> u32 {
    if !active {
        return 0;
    }
    match provider {
        Provider::Claude => sources::resolve_claude_transcript_path(id)
            .map(|path| subagents::claude_active_subagents(&path, now))
            .unwrap_or(0),
        Provider::Codex => subagents::codex_active_subagents(&sources::codex_state_db(), id, now),
        Provider::Opencode => 0,
    }
}

pub fn build_sessions(state: &AppState) -> Result<Vec<SessionView>, String> {
    build_sessions_at(state, registry::now_ms())
}

fn build_sessions_at(state: &AppState, now: i64) -> Result<Vec<SessionView>, String> {
    // Replacing duplicates retains their first position, matching JavaScript Map.
    let mut live: Vec<LiveSession> = Vec::new();
    for session in live_sessions(now) {
        if let Some(existing) = live
            .iter_mut()
            .find(|entry| entry.provider == session.provider && entry.id == session.id)
        {
            *existing = session;
        } else {
            live.push(session);
        }
    }
    let mut seen = HashSet::new();
    let mut updates = Vec::new();
    let mut sessions = Vec::new();
    for entry in registry::read_registry() {
        let provider = entry.provider();
        let id = entry.session_id();
        let current = live.iter().find(|l| l.provider == provider && l.id == id);
        let active = current.is_some() || registry::status_of(&entry, now) == SessionStatus::Active;
        if !active && !Path::new(entry.log_path()).exists() {
            continue;
        }
        seen.insert((provider as u8, id.to_owned()));
        let live_title = current.map(|l| l.title.trim()).unwrap_or("");
        let mut title = if live_title.is_empty() {
            entry.title().unwrap_or("").trim().to_owned()
        } else {
            live_title.to_owned()
        };
        if !live_title.is_empty() {
            if entry.title() != Some(live_title) || !entry.title_resolved() {
                updates.push(TitleUpdate {
                    provider,
                    session_id: id.into(),
                    title: title.clone(),
                });
            }
        } else if !entry.title_resolved() {
            if title.is_empty() {
                title = resolve_historical_session_title(provider, id).unwrap_or_default();
            }
            updates.push(TitleUpdate {
                provider,
                session_id: id.into(),
                title: title.clone(),
            });
        }
        let open_call = active
            && !entry.log_path().is_empty()
            && fs::read_to_string(entry.log_path())
                .ok()
                .is_some_and(|text| {
                    latest_open_call_id(&text.split('\n').collect::<Vec<_>>()).is_some()
                });
        sessions.push(SessionView {
            provider,
            project: entry.project().into(),
            session_id: id.into(),
            title,
            log_path: entry.log_path().into(),
            status: if active {
                SessionStatus::Active
            } else {
                SessionStatus::Ended
            },
            live_status: registry::derive_live_status(
                active,
                open_call,
                current.map(|l| l.status.as_str()),
            ),
            subagents: active_subagents(active, provider, id, now),
            channel: state.presence.has_channel(id),
            last_heartbeat: entry.last_heartbeat().into(),
            tracked: true,
        });
    }
    persist_title_updates(&updates)?;
    for session in live {
        if !seen.insert((session.provider as u8, session.id.clone())) {
            continue;
        }
        sessions.push(SessionView {
            provider: session.provider,
            project: session.cwd,
            session_id: session.id.clone(),
            title: session.title,
            log_path: String::new(),
            status: SessionStatus::Active,
            live_status: registry::derive_live_status(true, false, Some(&session.status)),
            subagents: active_subagents(true, session.provider, &session.id, now),
            channel: state.presence.has_channel(&session.id),
            last_heartbeat: registry::iso_timestamp(session.updated_at_ms),
            tracked: false,
        });
    }
    sessions.sort_by(session_order);
    Ok(sessions)
}

fn persist_title_updates(updates: &[TitleUpdate]) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    let mut entries = registry::read_registry();
    let mut changed = false;
    for update in updates {
        let Some(entry) = entries.iter_mut().find(|entry| {
            entry.provider() == update.provider && entry.session_id() == update.session_id
        }) else {
            continue;
        };
        if !update.title.is_empty() && entry.title() != Some(update.title.as_str()) {
            entry.set("title", Value::String(update.title.clone()));
            changed = true;
        }
        if !entry.title_resolved() {
            entry.set("titleResolved", Value::Bool(true));
            changed = true;
        }
    }
    if changed {
        // The core writer aborts on I/O errors; routes must instead return 500.
        let text = serde_json::to_string_pretty(&serde_json::json!({"sessions": entries}))
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(paths::cockpit_home()).map_err(|error| error.to_string())?;
        fs::write(paths::registry_path(), text).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn build_projects(state: &AppState) -> Result<Vec<ProjectView>, String> {
    let sessions = build_sessions(state)?;
    let mut groups: Vec<(String, Vec<SessionView>)> = Vec::new();
    for session in sessions {
        if let Some((_, group)) = groups
            .iter_mut()
            .find(|(project, _)| *project == session.project)
        {
            group.push(session);
        } else {
            groups.push((session.project.clone(), vec![session]));
        }
    }
    let mut projects: Vec<ProjectView> = groups
        .into_iter()
        .map(|(project, group)| {
            let mut heartbeats: Vec<_> = group
                .iter()
                .map(|session| session.last_heartbeat.clone())
                .collect();
            heartbeats.sort_by(|a, b| date_order(a, b));
            ProjectView {
                name: Path::new(&project)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                project,
                active_count: group
                    .iter()
                    .filter(|session| session.status == SessionStatus::Active)
                    .count(),
                session_count: group.len(),
                last_heartbeat: heartbeats.into_iter().next().unwrap_or_default(),
            }
        })
        .collect();
    projects.sort_by(|a, b| {
        (b.active_count > 0)
            .cmp(&(a.active_count > 0))
            .then_with(|| date_order(&a.last_heartbeat, &b.last_heartbeat))
    });
    Ok(projects)
}

fn live_sessions(now: i64) -> Vec<LiveSession> {
    let mut live = Vec::new();
    if let Ok(entries) = fs::read_dir(paths::claude_sessions_dir()) {
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_name().to_string_lossy().ends_with(".json") {
                continue;
            }
            let Some(value) = fs::read_to_string(entry.path())
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            else {
                continue;
            };
            let (Some(id), Some(cwd), Some(started)) = (
                value["sessionId"].as_str(),
                value["cwd"].as_str(),
                value["startedAt"].as_f64(),
            ) else {
                continue;
            };
            let updated = value["updatedAt"].as_f64().unwrap_or(started) as i64;
            if now.saturating_sub(updated) > registry::STALE_MS {
                continue;
            }
            live.push(LiveSession {
                provider: Provider::Claude,
                id: id.into(),
                cwd: cwd.into(),
                title: value["name"].as_str().unwrap_or("").trim().into(),
                updated_at_ms: updated,
                status: value["status"].as_str().unwrap_or("idle").into(),
            });
        }
    }
    live.extend(
        database_live(&sources::codex_state_db(), Provider::Codex, now).unwrap_or_default(),
    );
    live.extend(
        database_live(&sources::opencode_db(), Provider::Opencode, now).unwrap_or_default(),
    );
    live
}

fn database_live(path: &Path, provider: Provider, now: i64) -> rusqlite::Result<Vec<LiveSession>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let sql = if provider == Provider::Codex {
        let spawn_edges: bool = db.query_row("select exists(select 1 from sqlite_master where type = 'table' and name = 'thread_spawn_edges')", [], |row| row.get(0))?;
        format!(
            "select id, cwd, title, coalesce(updated_at_ms, updated_at * 1000), 0 from threads where archived = 0 and rollout_path != '' {} order by coalesce(updated_at_ms, updated_at * 1000) desc limit 24",
            if spawn_edges {
                "and not exists (select 1 from thread_spawn_edges e where e.child_thread_id = threads.id)"
            } else {
                ""
            }
        )
    } else {
        "select id, directory, title, time_updated, time_created from session where time_archived is null order by time_updated desc limit 24".into()
    };
    let mut statement = db.prepare(&sql)?;
    let rows = statement.query_map([], |row| {
        let updated: i64 = row.get(3)?;
        let updated = if provider == Provider::Opencode {
            let timestamp = sources::opencode_timestamp_ms(updated);
            if timestamp == 0 {
                sources::opencode_timestamp_ms(row.get(4)?)
            } else {
                timestamp
            }
        } else {
            updated
        };
        Ok(LiveSession {
            provider,
            id: row.get(0)?,
            cwd: row.get(1)?,
            title: row.get::<_, String>(2).unwrap_or_default().trim().into(),
            updated_at_ms: updated,
            status: if now.saturating_sub(updated) <= 60_000 {
                "busy"
            } else {
                "idle"
            }
            .into(),
        })
    })?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|l| {
            (provider != Provider::Opencode || l.updated_at_ms != 0)
                && now.saturating_sub(l.updated_at_ms) <= registry::STALE_MS
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_updates_preserve_registry_format_and_unknown_keys() {
        let fixture = crate::paths::tests::TestEnv::new();
        let home = fixture.dir.path().join("cockpit");
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", &home);
        fs::create_dir_all(&home).unwrap();
        fs::write(
            paths::registry_path(),
            r#"{"sessions":[{"sessionId":"id","provider":"codex","unknown":true}]}"#,
        )
        .unwrap();
        let update = TitleUpdate {
            provider: Provider::Codex,
            session_id: "id".into(),
            title: "Title".into(),
        };
        persist_title_updates(&[update]).unwrap();
        let text = fs::read_to_string(paths::registry_path()).unwrap();
        assert!(!text.ends_with('\n'));
        let entries = registry::read_registry();
        assert_eq!(entries[0].title(), Some("Title"));
        assert!(entries[0].title_resolved());
        assert_eq!(entries[0].raw["unknown"], Value::Bool(true));
    }

    #[test]
    fn live_sources_filter_stale_archived_and_spawned_sessions() {
        let fixture = crate::paths::tests::TestEnv::new();
        let now = 1_790_769_600_000;
        let claude = fixture.dir.path().join("claude");
        fs::create_dir_all(&claude).unwrap();
        crate::paths::tests::TestEnv::set("COCKPIT_CLAUDE_SESSIONS_DIR", &claude);
        fs::write(claude.join("current.json"), serde_json::json!({"sessionId":"claude", "cwd":"/repo", "name":" Name ", "startedAt":now - 800_000, "updatedAt":now, "status":"waiting"}).to_string()).unwrap();
        fs::write(
            claude.join("stale.json"),
            serde_json::json!({"sessionId":"stale", "cwd":"/repo", "startedAt":now - 600_001})
                .to_string(),
        )
        .unwrap();
        fs::write(claude.join("malformed.json"), "{").unwrap();
        fs::write(
            claude.join("invalid.json"),
            serde_json::json!({"sessionId":"invalid", "cwd":"/repo", "startedAt":"wrong"})
                .to_string(),
        )
        .unwrap();
        let codex = fixture.dir.path().join("codex.sqlite");
        crate::paths::tests::TestEnv::set("COCKPIT_CODEX_STATE_DB", &codex);
        let db = Connection::open(&codex).unwrap();
        db.execute_batch("create table threads(id text, cwd text, title text, updated_at integer, updated_at_ms integer, archived integer, rollout_path text); create table thread_spawn_edges(parent_thread_id text, child_thread_id text);").unwrap();
        for (id, touched, archived, rollout) in [
            ("parent", now, 0, "p"),
            ("child", now, 0, "c"),
            ("idle", now - 60_001, 0, "i"),
            ("stale", now - 600_001, 0, "s"),
            ("archived", now, 1, "a"),
            ("empty", now, 0, ""),
        ] {
            db.execute(
                "insert into threads values (?1, '/repo', ' Title ', ?2, ?3, ?4, ?5)",
                rusqlite::params![id, touched / 1000, touched, archived, rollout],
            )
            .unwrap();
        }
        db.execute(
            "insert into thread_spawn_edges values ('parent', 'child')",
            [],
        )
        .unwrap();
        drop(db);
        let opencode = fixture.dir.path().join("opencode.sqlite");
        crate::paths::tests::TestEnv::set("COCKPIT_OPENCODE_DB", &opencode);
        let db = Connection::open(&opencode).unwrap();
        db.execute_batch("create table session(id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);").unwrap();
        db.execute(
            "insert into session values ('open', '/repo', ' Open ', ?1, ?2, null)",
            rusqlite::params![now, now / 1000],
        )
        .unwrap();
        db.execute(
            "insert into session values ('archived', '/repo', '', ?1, ?1, 1)",
            [now],
        )
        .unwrap();
        let sessions = live_sessions(now);
        assert_eq!(
            sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["claude", "parent", "idle", "open"]
        );
        assert_eq!(sessions[0].title, "Name");
        assert_eq!(sessions[0].status, "waiting");
        assert_eq!(sessions[1].status, "busy");
        assert_eq!(sessions[2].status, "idle");
        assert_eq!(sessions[3].updated_at_ms, now);
    }

    #[test]
    fn date_sort_matches_nan_comparison_and_newest_first() {
        assert_eq!(
            date_order("2026-09-30", "2026-09-30T00:00:00.000Z"),
            Ordering::Equal
        );
        assert_eq!(
            date_order("invalid", "2026-09-30T12:00:00Z"),
            Ordering::Equal
        );
        assert_eq!(
            date_order("2026-09-30T12:00:01Z", "2026-09-30T12:00:00Z"),
            Ordering::Less
        );
    }

    #[test]
    fn live_status_prioritizes_ended_and_open_calls() {
        assert_eq!(
            registry::derive_live_status(false, true, Some("busy")),
            LiveStatus::Ended
        );
        assert_eq!(
            registry::derive_live_status(true, true, Some("busy")),
            LiveStatus::YourCall
        );
        for (harness, expected) in [
            ("busy", LiveStatus::Working),
            ("waiting", LiveStatus::Waiting),
            ("shell", LiveStatus::Shell),
            ("unknown", LiveStatus::Idle),
        ] {
            assert_eq!(
                registry::derive_live_status(true, false, Some(harness)),
                expected
            );
        }
    }
}
