// Mirrors usage-dashboard/scripts/paths.ts; functions, not statics, so tests can move HOME.
use std::path::PathBuf;

fn non_empty_var(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn home() -> PathBuf {
    non_empty_var("HOME").unwrap_or_default()
}
pub fn claude_dir() -> PathBuf {
    home().join(".claude")
}
pub fn codex_dir() -> PathBuf {
    home().join(".codex")
}
pub fn opencode_db() -> PathBuf {
    crate::paths::opencode_db()
}
pub fn opencode_dir() -> PathBuf {
    let db = opencode_db();
    db.parent().map(PathBuf::from).unwrap_or_default()
}
pub fn opencode_storage_dir() -> PathBuf {
    opencode_dir().join("storage")
}
pub fn opencode_project_dir() -> PathBuf {
    opencode_dir().join("project")
}
pub fn codex_state_db() -> PathBuf {
    codex_dir().join("state_5.sqlite")
}
pub fn codex_sessions_dir() -> PathBuf {
    codex_dir().join("sessions")
}
pub fn codex_auth() -> PathBuf {
    codex_dir().join("auth.json")
}
pub fn stats_cache() -> PathBuf {
    claude_dir().join("stats-cache.json")
}
pub fn history() -> PathBuf {
    claude_dir().join("history.jsonl")
}
pub fn sessions_dir() -> PathBuf {
    claude_dir().join("sessions")
}
pub fn projects_dir() -> PathBuf {
    non_empty_var("TOKEN_ATLAS_PROJECTS_DIR").unwrap_or_else(|| claude_dir().join("projects"))
}
pub fn token_atlas_cache_dir() -> PathBuf {
    home().join(".cache/token-atlas")
}
pub fn rate_limits_cache() -> PathBuf {
    token_atlas_cache_dir().join("rate-limits.json")
}
pub fn codex_usage_cache() -> PathBuf {
    token_atlas_cache_dir().join("codex-usage-limits.json")
}

fn rollup_dir() -> PathBuf {
    non_empty_var("XDG_DATA_HOME")
        .unwrap_or_else(|| home().join(".local/share"))
        .join("q-lab/token-atlas")
}
pub fn rollup_db_path() -> PathBuf {
    non_empty_var("TOKEN_ATLAS_ROLLUP_DB").unwrap_or_else(|| rollup_dir().join("rollup.db"))
}
// Beside the default rollup dir even when TOKEN_ATLAS_ROLLUP_DB moves the rollup, as codex-cache.ts does.
pub fn codex_cache_path() -> PathBuf {
    rollup_dir().join("codex-sessions.db")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn rollup_and_codex_cache_fallbacks() {
        let env = TestEnv::new();
        let home = env.dir.path();
        assert_eq!(
            rollup_db_path(),
            home.join(".local/share/q-lab/token-atlas/rollup.db")
        );
        assert_eq!(
            codex_cache_path(),
            home.join(".local/share/q-lab/token-atlas/codex-sessions.db")
        );
        TestEnv::set("XDG_DATA_HOME", "/xdg");
        assert_eq!(
            rollup_db_path(),
            PathBuf::from("/xdg/q-lab/token-atlas/rollup.db")
        );
        TestEnv::set("TOKEN_ATLAS_ROLLUP_DB", "/tmp/r.db");
        assert_eq!(rollup_db_path(), PathBuf::from("/tmp/r.db"));
        assert_eq!(
            codex_cache_path(),
            PathBuf::from("/xdg/q-lab/token-atlas/codex-sessions.db")
        );
        TestEnv::set("XDG_DATA_HOME", "");
        TestEnv::set("TOKEN_ATLAS_ROLLUP_DB", "");
        assert_eq!(
            rollup_db_path(),
            home.join(".local/share/q-lab/token-atlas/rollup.db")
        );
    }

    #[test]
    fn home_derived_paths_and_overrides() {
        let env = TestEnv::new();
        let home = env.dir.path();
        assert_eq!(projects_dir(), home.join(".claude/projects"));
        TestEnv::set("TOKEN_ATLAS_PROJECTS_DIR", "/p");
        assert_eq!(projects_dir(), PathBuf::from("/p"));
        assert_eq!(codex_state_db(), home.join(".codex/state_5.sqlite"));
        assert_eq!(
            rate_limits_cache(),
            home.join(".cache/token-atlas/rate-limits.json")
        );
        TestEnv::set("COCKPIT_OPENCODE_DB", "/oc/opencode.db");
        assert_eq!(opencode_storage_dir(), PathBuf::from("/oc/storage"));
        assert_eq!(opencode_project_dir(), PathBuf::from("/oc/project"));
    }
}
