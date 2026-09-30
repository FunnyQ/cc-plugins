use crate::{config, log_root, paths};
use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub use crate::config::NudgeState;
pub enum NudgeScope {
    Session,
    Project,
    User,
}
pub enum ToggleAction {
    On,
    Off,
    Toggle,
    Clear,
}

const TTL_MS: i64 = 7 * 24 * 60 * 60_000;

pub fn resolve_nudge_enabled(
    session: Option<NudgeState>,
    project: Option<NudgeState>,
    user: Option<NudgeState>,
) -> bool {
    session.or(project).or(user) != Some(NudgeState::Off)
}
pub fn apply_action(action: ToggleAction, current: Option<NudgeState>) -> Option<NudgeState> {
    match action {
        ToggleAction::On => Some(NudgeState::On),
        ToggleAction::Off => Some(NudgeState::Off),
        ToggleAction::Clear => None,
        ToggleAction::Toggle => Some(if current == Some(NudgeState::Off) {
            NudgeState::On
        } else {
            NudgeState::Off
        }),
    }
}
pub fn project_key(cwd: &Path) -> PathBuf {
    log_root::git_root_of(cwd).unwrap_or_else(|| cwd.to_path_buf())
}
fn session_path() -> PathBuf {
    paths::cockpit_home().join("scribe-nudge-toggle.json")
}
fn read_sessions(now_ms: i64) -> Map<String, Value> {
    let raw = fs::read_to_string(session_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let mut store = Map::new();
    if let Some(Value::Object(entries)) = raw {
        for (id, entry) in entries {
            if matches!(
                entry.get("state").and_then(Value::as_str),
                Some("on" | "off")
            ) && let Some(ts) = entry.get("ts").and_then(Value::as_f64)
                && (now_ms as f64 - ts) < TTL_MS as f64
            {
                // Keep numeric timestamps, including fractions, as the TS reader does.
                store.insert(id, json!({"state":entry["state"], "ts":entry["ts"]}));
            }
        }
    }
    store
}
fn session_state(session_id: Option<&str>, now_ms: i64) -> Option<NudgeState> {
    let id = session_id.filter(|id| !id.is_empty())?;
    read_sessions(now_ms)
        .get(id)
        .and_then(|entry| entry.get("state"))
        .and_then(|state| serde_json::from_value(state.clone()).ok())
}
pub fn read_scopes(
    session_id: Option<&str>,
    cwd: &Path,
    now_ms: i64,
) -> (Option<NudgeState>, Option<NudgeState>, Option<NudgeState>) {
    (
        session_state(session_id, now_ms),
        config::get_project_nudge(&project_key(cwd).to_string_lossy()),
        config::get_user_nudge(),
    )
}
// Lazy on purpose: the project scope forks git, which a session override makes moot.
pub fn nudge_enabled_for(session_id: Option<&str>, cwd: &Path, now_ms: i64) -> bool {
    session_state(session_id, now_ms)
        .or_else(|| config::get_project_nudge(&project_key(cwd).to_string_lossy()))
        .or_else(config::get_user_nudge)
        != Some(NudgeState::Off)
}
pub fn set_scope(
    scope: NudgeScope,
    action: ToggleAction,
    session_id: &str,
    cwd: &Path,
    now_ms: i64,
) -> Option<NudgeState> {
    match scope {
        NudgeScope::Session => {
            let next = apply_action(action, session_state(Some(session_id), now_ms));
            let mut store = read_sessions(now_ms);
            if let Some(state) = next {
                store.insert(session_id.to_owned(), json!({"state":state,"ts":now_ms}));
            } else {
                store.shift_remove(session_id);
            }
            let path = session_path();
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(raw) = serde_json::to_string(&store) {
                let _ = fs::write(path, raw);
            }
            next
        }
        NudgeScope::Project => {
            let key = project_key(cwd);
            let key = key.to_string_lossy();
            let next = apply_action(action, config::get_project_nudge(&key));
            config::set_project_nudge(&key, next);
            next
        }
        NudgeScope::User => {
            let next = apply_action(action, config::get_user_nudge());
            config::set_user_nudge(next);
            next
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn precedence_and_actions() {
        use NudgeState::{Off, On};
        assert!(resolve_nudge_enabled(None, None, None));
        assert!(resolve_nudge_enabled(Some(On), Some(Off), Some(Off)));
        assert!(!resolve_nudge_enabled(None, Some(Off), Some(On)));
        assert!(!resolve_nudge_enabled(None, None, Some(Off)));
        assert!(resolve_nudge_enabled(None, None, Some(On)));
        for current in [None, Some(On), Some(Off)] {
            assert_eq!(apply_action(ToggleAction::On, current), Some(On));
            assert_eq!(apply_action(ToggleAction::Off, current), Some(Off));
            assert_eq!(apply_action(ToggleAction::Clear, current), None);
            assert_eq!(
                apply_action(ToggleAction::Toggle, current),
                Some(if current == Some(Off) { On } else { Off })
            );
        }
    }

    #[test]
    fn scopes_round_trip_clear_and_compact_file() {
        let fixture = TestEnv::new();
        TestEnv::set("COCKPIT_HOME", fixture.dir.path().join("data"));
        let cwd = fixture.dir.path().join("missing");
        let now = 1_000_000_000_000;
        assert!(nudge_enabled_for(Some("s1"), &cwd, now));
        assert_eq!(project_key(&cwd), cwd);
        set_scope(NudgeScope::User, ToggleAction::Off, "s1", &cwd, now);
        assert!(!nudge_enabled_for(Some("s1"), &cwd, now));
        assert!(!nudge_enabled_for(Some("s2"), &cwd, now));
        set_scope(NudgeScope::Session, ToggleAction::On, "s1", &cwd, now);
        assert!(nudge_enabled_for(Some("s1"), &cwd, now));
        assert!(!nudge_enabled_for(Some("s2"), &cwd, now));
        assert_eq!(
            read_scopes(Some("s1"), &cwd, now),
            (Some(NudgeState::On), None, Some(NudgeState::Off))
        );
        assert_eq!(
            fs::read_to_string(session_path()).unwrap(),
            r#"{"s1":{"state":"on","ts":1000000000000}}"#
        );
        set_scope(NudgeScope::Session, ToggleAction::Off, "s1", &cwd, now);
        assert_eq!(read_scopes(Some("s1"), &cwd, now).0, Some(NudgeState::Off));
        set_scope(NudgeScope::Session, ToggleAction::Clear, "s1", &cwd, now);
        assert_eq!(read_scopes(Some("s1"), &cwd, now).0, None);
        set_scope(NudgeScope::Project, ToggleAction::On, "s1", &cwd, now);
        assert!(nudge_enabled_for(None, &cwd, now));
        set_scope(NudgeScope::Project, ToggleAction::Clear, "s1", &cwd, now);
        assert!(config::read_config()["nudges"].get("projects").is_none());
        set_scope(NudgeScope::User, ToggleAction::Clear, "s1", &cwd, now);
        assert!(nudge_enabled_for(None, &cwd, now));
    }

    #[test]
    fn expiry_invalid_entries_and_best_effort_writes() {
        let fixture = TestEnv::new();
        TestEnv::set("COCKPIT_HOME", fixture.dir.path());
        let cwd = fixture.dir.path().join("missing");
        let now = 1_000_000_000_000;
        fs::write(
            session_path(),
            json!({
                "fresh":{"state":"off","ts":now-1000,"extra":true},
                "stale":{"state":"off","ts":now-TTL_MS-1},
                "boundary":{"state":"off","ts":now-TTL_MS},
                "fraction":{"state":"on","ts":now as f64-0.5},
                "future":{"state":"on","ts":now+1000},
                "badstate":{"state":"bad","ts":now},
                "badts":{"state":"off","ts":"1"},
                "missing":{"state":"on"},"null":null,"array":[]
            })
            .to_string(),
        )
        .unwrap();
        let store = read_sessions(now);
        assert_eq!(
            store.keys().map(String::as_str).collect::<Vec<_>>(),
            ["fresh", "fraction", "future"]
        );
        assert_eq!(
            read_scopes(Some("fresh"), &cwd, now).0,
            Some(NudgeState::Off)
        );
        assert_eq!(read_scopes(Some("boundary"), &cwd, now).0, None);
        set_scope(
            NudgeScope::Session,
            ToggleAction::Toggle,
            "fresh",
            &cwd,
            now,
        );
        assert_eq!(
            read_scopes(Some("fresh"), &cwd, now).0,
            Some(NudgeState::On)
        );
        assert!(
            !fs::read_to_string(session_path())
                .unwrap()
                .contains("extra")
        );
        for raw in ["not json", "null", "[]", "42"] {
            fs::write(session_path(), raw).unwrap();
            assert!(read_sessions(now).is_empty());
        }
        fs::create_dir_all(crate::paths::config_path().parent().unwrap()).unwrap();
        fs::write(
            crate::paths::config_path(),
            json!({"nudges":{"user":"bad","projects":{cwd.to_string_lossy().to_string():false}}})
                .to_string(),
        )
        .unwrap();
        assert_eq!(read_scopes(Some(""), &cwd, now), (None, None, None));
        let blocked = fixture.dir.path().join("blocked");
        fs::write(&blocked, "").unwrap();
        TestEnv::set("COCKPIT_HOME", blocked);
        assert_eq!(
            set_scope(NudgeScope::Session, ToggleAction::Off, "s1", &cwd, now),
            Some(NudgeState::Off)
        );
    }

    #[test]
    fn project_key_reuses_git_root() {
        let fixture = TestEnv::new();
        assert_eq!(
            project_key(fixture.dir.path()),
            crate::log_root::git_root_of(fixture.dir.path()).unwrap()
        );
    }
}
