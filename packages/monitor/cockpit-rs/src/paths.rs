use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

static MIGRATED_TARGETS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
const PLUGIN_ROOT_ERROR: &str = "cockpit: cannot locate plugin root; set COCKPIT_PLUGIN_ROOT";

fn override_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn home() -> PathBuf {
    env::home_dir().unwrap_or_default()
}

pub fn cockpit_home() -> PathBuf {
    if let Some(path) = override_path("COCKPIT_HOME") {
        return path;
    }
    let path = override_path("XDG_DATA_HOME")
        .unwrap_or_else(|| home().join(".local/share"))
        .join("q-lab/cockpit");
    // TS records each target once, allowing XDG overrides to change within a process.
    let mut migrated = MIGRATED_TARGETS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if migrated.insert(path.clone()) {
        let legacy = home().join(".cockpit");
        if !path.exists()
            && legacy.exists()
            && let Some(parent) = path.parent()
        {
            let _ = fs::create_dir_all(parent);
            let _ = fs::rename(legacy, &path);
        }
    }
    path
}

pub fn daemon_info_path() -> PathBuf {
    cockpit_home().join("daemon.json")
}
pub fn registry_path() -> PathBuf {
    cockpit_home().join("registry.json")
}
pub fn config_path() -> PathBuf {
    override_path("XDG_CONFIG_HOME")
        .unwrap_or_else(|| home().join(".config"))
        .join("q-lab/cockpit/config.json")
}
pub fn claude_projects_dir() -> PathBuf {
    override_path("COCKPIT_CLAUDE_PROJECTS_DIR").unwrap_or_else(|| home().join(".claude/projects"))
}
pub fn claude_sessions_dir() -> PathBuf {
    override_path("COCKPIT_CLAUDE_SESSIONS_DIR").unwrap_or_else(|| home().join(".claude/sessions"))
}
pub fn codex_dir() -> PathBuf {
    override_path("COCKPIT_CODEX_DIR").unwrap_or_else(|| home().join(".codex"))
}
pub fn codex_state_db() -> PathBuf {
    override_path("COCKPIT_CODEX_STATE_DB").unwrap_or_else(|| codex_dir().join("state_5.sqlite"))
}
pub fn resolve_codex_path(p: &str) -> PathBuf {
    if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else {
        codex_dir().join(p)
    }
}
pub fn opencode_db() -> PathBuf {
    override_path("COCKPIT_OPENCODE_DB").unwrap_or_else(|| {
        override_path("OPENCODE_DATA_DIR")
            .unwrap_or_else(|| home().join(".local/share/opencode"))
            .join("opencode.db")
    })
}
fn locate_plugin_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(PLUGIN_ROOT_ERROR.to_owned());
    }
    path.ancestors()
        .find(|ancestor| ancestor.join(".claude-plugin/plugin.json").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| PLUGIN_ROOT_ERROR.to_owned())
}
pub fn plugin_root() -> Result<PathBuf, String> {
    if let Some(path) = override_path("COCKPIT_PLUGIN_ROOT") {
        return Ok(path);
    }
    let exe = env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| PLUGIN_ROOT_ERROR.to_owned())?;
    locate_plugin_root(&exe)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::MutexGuard;

    static LOCK: Mutex<()> = Mutex::new(());
    const KEYS: &[&str] = &[
        "HOME",
        "COCKPIT_HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "COCKPIT_CLAUDE_PROJECTS_DIR",
        "COCKPIT_CLAUDE_SESSIONS_DIR",
        "COCKPIT_CODEX_DIR",
        "COCKPIT_CODEX_STATE_DB",
        "COCKPIT_OPENCODE_DB",
        "OPENCODE_DATA_DIR",
        "COCKPIT_PLUGIN_ROOT",
        "COCKPIT_WAIT_TIMEOUT_MS",
        "COCKPIT_STASH_TTL_MS",
    ];

    pub(crate) struct TestEnv {
        saved: Vec<(&'static str, Option<OsString>)>,
        pub dir: tempfile::TempDir,
        _lock: MutexGuard<'static, ()>,
    }

    impl TestEnv {
        pub fn new() -> Self {
            let lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let saved = KEYS.iter().map(|&key| (key, env::var_os(key))).collect();
            let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
            // All environment readers in tests hold LOCK for the entire fixture lifetime.
            unsafe {
                for key in KEYS {
                    env::remove_var(key);
                }
                env::set_var("HOME", dir.path());
                env::set_var("XDG_CONFIG_HOME", dir.path().join("config"));
            }
            Self {
                saved,
                dir,
                _lock: lock,
            }
        }

        pub fn set(key: &str, value: impl AsRef<std::ffi::OsStr>) {
            // Callers hold the shared test lock, including while restoring the environment.
            unsafe {
                env::set_var(key, value);
            }
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            // The fixture still holds LOCK until every variable is restored.
            unsafe {
                for (key, value) in &self.saved {
                    match value {
                        Some(value) => env::set_var(key, value),
                        None => env::remove_var(key),
                    }
                }
            }
        }
    }

    #[test]
    fn overrides_and_empty_fallbacks() {
        let env = TestEnv::new();
        let home = env.dir.path();
        type PathCase = (&'static str, fn() -> PathBuf, PathBuf);
        let cases: &[PathCase] = &[
            (
                "COCKPIT_HOME",
                cockpit_home,
                home.join(".local/share/q-lab/cockpit"),
            ),
            (
                "COCKPIT_CLAUDE_PROJECTS_DIR",
                claude_projects_dir,
                home.join(".claude/projects"),
            ),
            (
                "COCKPIT_CLAUDE_SESSIONS_DIR",
                claude_sessions_dir,
                home.join(".claude/sessions"),
            ),
            ("COCKPIT_CODEX_DIR", codex_dir, home.join(".codex")),
            (
                "COCKPIT_CODEX_STATE_DB",
                codex_state_db,
                home.join(".codex/state_5.sqlite"),
            ),
            (
                "COCKPIT_OPENCODE_DB",
                opencode_db,
                home.join(".local/share/opencode/opencode.db"),
            ),
        ];
        for (key, resolve, default) in cases {
            assert_eq!(resolve(), *default);
            let custom = home.join(key);
            TestEnv::set(key, &custom);
            assert_eq!(resolve(), custom);
            TestEnv::set(key, "");
            assert_eq!(resolve(), *default);
        }
        TestEnv::set("COCKPIT_CODEX_DIR", home.join("codex"));
        assert_eq!(codex_state_db(), home.join("codex/state_5.sqlite"));
        assert_eq!(
            resolve_codex_path("rollout.jsonl"),
            home.join("codex/rollout.jsonl")
        );
        assert_eq!(resolve_codex_path("/absolute"), PathBuf::from("/absolute"));
        TestEnv::set("OPENCODE_DATA_DIR", home.join("opencode"));
        assert_eq!(opencode_db(), home.join("opencode/opencode.db"));
        TestEnv::set("COCKPIT_OPENCODE_DB", home.join("override.db"));
        assert_eq!(opencode_db(), home.join("override.db"));
        TestEnv::set("OPENCODE_DATA_DIR", "");
        TestEnv::set("COCKPIT_OPENCODE_DB", "");
        assert_eq!(
            opencode_db(),
            home.join(".local/share/opencode/opencode.db")
        );
    }

    #[test]
    fn xdg_paths_and_config_independence() {
        let env = TestEnv::new();
        let home = env.dir.path();
        TestEnv::set("XDG_DATA_HOME", home.join("data"));
        assert_eq!(cockpit_home(), home.join("data/q-lab/cockpit"));
        assert_eq!(daemon_info_path(), cockpit_home().join("daemon.json"));
        assert_eq!(registry_path(), cockpit_home().join("registry.json"));
        TestEnv::set("COCKPIT_HOME", home.join("explicit"));
        assert_eq!(config_path(), home.join("config/q-lab/cockpit/config.json"));
        TestEnv::set("XDG_CONFIG_HOME", "");
        assert_eq!(
            config_path(),
            home.join(".config/q-lab/cockpit/config.json")
        );
        TestEnv::set("COCKPIT_HOME", "");
        TestEnv::set("XDG_DATA_HOME", "");
        assert_eq!(cockpit_home(), home.join(".local/share/q-lab/cockpit"));
    }

    #[test]
    fn migration_is_best_effort_once_per_target_and_override_skips_it() {
        let env = TestEnv::new();
        let home = env.dir.path();
        let legacy = home.join(".cockpit");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("daemon.json"), "legacy").unwrap();
        TestEnv::set("COCKPIT_HOME", home.join("explicit"));
        assert_eq!(cockpit_home(), home.join("explicit"));
        assert!(legacy.exists());
        TestEnv::set("COCKPIT_HOME", "");
        let next = cockpit_home();
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(next.join("daemon.json")).unwrap(),
            "legacy"
        );
        fs::rename(&next, &legacy).unwrap();
        assert_eq!(cockpit_home(), next);
        assert!(legacy.exists());
        assert!(!next.exists());
        TestEnv::set("XDG_DATA_HOME", home.join("another"));
        assert_eq!(cockpit_home(), home.join("another/q-lab/cockpit"));
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_never_overwrites_existing_destination_and_ignores_errors() {
        let env = TestEnv::new();
        let home = env.dir.path();
        let legacy = home.join(".cockpit");
        fs::create_dir_all(&legacy).unwrap();
        let existing = home.join("data/q-lab/cockpit");
        fs::create_dir_all(&existing).unwrap();
        TestEnv::set("XDG_DATA_HOME", home.join("data"));
        assert_eq!(cockpit_home(), existing);
        assert!(legacy.exists());
        fs::write(home.join("blocked"), "file").unwrap();
        TestEnv::set("XDG_DATA_HOME", home.join("blocked"));
        assert_eq!(cockpit_home(), home.join("blocked/q-lab/cockpit"));
        assert!(legacy.exists());
    }

    #[test]
    fn plugin_root_override_and_executable_discovery() {
        let env = TestEnv::new();
        let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        assert_eq!(plugin_root(), Ok(expected));
        TestEnv::set("COCKPIT_PLUGIN_ROOT", env.dir.path().join("plugin"));
        assert_eq!(plugin_root(), Ok(env.dir.path().join("plugin")));
        TestEnv::set("COCKPIT_PLUGIN_ROOT", "");
        assert!(plugin_root().is_ok());
        assert_eq!(
            locate_plugin_root(env.dir.path()),
            Err(PLUGIN_ROOT_ERROR.to_owned())
        );
    }
}
