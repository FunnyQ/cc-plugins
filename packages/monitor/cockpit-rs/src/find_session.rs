use crate::paths;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{env, fs, path::Path, str::FromStr};

pub use crate::registry::Provider;

impl FromStr for Provider {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::Opencode),
            _ => Err(format!("find-session: invalid provider \"{value}\"")),
        }
    }
}

fn trimmed_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| {
            value
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .to_owned()
        })
        .filter(|value| !value.is_empty())
}

/// Returns the session id; on None the TS diagnostic has been printed to stderr.
pub fn find_session(provider: Provider, project: &Path) -> Option<String> {
    match lookup(provider, project) {
        Ok(id) => Some(id),
        Err(message) => {
            eprintln!("{message}");
            None
        }
    }
}

fn lookup(provider: Provider, project: &Path) -> Result<String, String> {
    if provider == Provider::Claude {
        if let Some(id) = trimmed_env("CLAUDE_CODE_SESSION_ID")
            && crate::registry::is_session_id(&id)
        {
            return Ok(id);
        }
        let dir =
            paths::claude_projects_dir().join(project.to_string_lossy().replace(['/', '.'], "-"));
        if !dir.exists() {
            return Err(format!(
                "find-session: no transcript dir for {}\n  (looked in {})",
                project.display(),
                dir.display()
            ));
        }
        let mut names = fs::read_dir(&dir)
            .map_err(|error| error.to_string())?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        // Node readdir returns names in lexical order, which decides equal-mtime ties.
        names.sort();
        let mut newest = None;
        for name in names {
            let name = name.to_string_lossy();
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            let mtime = fs::metadata(dir.join(name.as_ref()))
                .and_then(|metadata| metadata.modified())
                .map_err(|error| error.to_string())?;
            if newest
                .as_ref()
                .is_none_or(|(_, previous)| mtime > *previous)
            {
                newest = Some((id.to_owned(), mtime));
            }
        }
        return newest
            .map(|(id, _)| id)
            .ok_or_else(|| format!("find-session: no .jsonl transcripts in {}", dir.display()));
    }
    if provider == Provider::Opencode
        && let Some(id) =
            trimmed_env("OPENCODE_SESSION_ID").or_else(|| trimmed_env("OPENCODE_SESSION"))
    {
        return Ok(id);
    }
    let (path, missing, error_label, absent) = match provider {
        Provider::Codex => (
            paths::codex_state_db(),
            "Codex state database",
            "Codex state",
            "Codex thread",
        ),
        Provider::Opencode => (
            paths::opencode_db(),
            "OpenCode database",
            "OpenCode database",
            "OpenCode session",
        ),
        Provider::Claude => unreachable!(),
    };
    if !path.exists() {
        return Err(format!("find-session: no {missing} at {}", path.display()));
    }
    let result = (|| -> rusqlite::Result<Option<String>> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let sql = if provider == Provider::Codex {
            let has_edges: bool = db.query_row("select exists(select 1 from sqlite_master where type = 'table' and name = 'thread_spawn_edges')", [], |row| row.get(0))?;
            format!(
                "select id from threads where cwd = ?1 and archived = 0 and rollout_path != '' {} order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc limit 1",
                if has_edges {
                    "and not exists (select 1 from thread_spawn_edges e where e.child_thread_id = threads.id)"
                } else {
                    ""
                }
            )
        } else {
            "select id from session where directory = ?1 and time_archived is null order by time_updated desc limit 1".to_owned()
        };
        db.query_row(&sql, [project.to_string_lossy().as_ref()], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
        .map(Option::flatten)
    })();
    match result {
        Ok(Some(id)) if !id.is_empty() => Ok(id),
        Ok(_) => Err(format!(
            "find-session: no {absent} for {}",
            project.display()
        )),
        Err(error) => {
            // Bun prints SQLite's message without rusqlite's SQL/offset suffix.
            let message = match &error {
                rusqlite::Error::SqliteFailure(_, Some(message))
                | rusqlite::Error::SqlInputError { msg: message, .. } => message.clone(),
                _ => error.to_string(),
            };
            Err(format!(
                "find-session: could not read {error_label} ({message})"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use std::ffi::OsString;

    struct SessionEnv(Vec<(&'static str, Option<OsString>)>);
    impl SessionEnv {
        fn new() -> Self {
            let saved = [
                "CLAUDE_CODE_SESSION_ID",
                "OPENCODE_SESSION_ID",
                "OPENCODE_SESSION",
            ]
            .into_iter()
            .map(|key| (key, env::var_os(key)))
            .collect::<Vec<_>>();
            for (key, _) in &saved {
                TestEnv::set(key, "");
            }
            Self(saved)
        }
    }
    impl Drop for SessionEnv {
        fn drop(&mut self) {
            // The enclosing TestEnv holds the shared environment lock.
            for (key, value) in &self.0 {
                unsafe {
                    match value {
                        Some(value) => env::set_var(key, value),
                        None => env::remove_var(key),
                    }
                }
            }
        }
    }

    #[test]
    fn claude_env_scan_and_diagnostics() {
        let fixture = TestEnv::new();
        let _session_env = SessionEnv::new();
        let project = fixture.dir.path().join("project.name");
        TestEnv::set(
            "COCKPIT_CLAUDE_PROJECTS_DIR",
            fixture.dir.path().join("transcripts"),
        );
        let id = "abcdef00-1111-2222-3333-444455556666";
        TestEnv::set("CLAUDE_CODE_SESSION_ID", format!("  {id} "));
        assert_eq!(find_session(Provider::Claude, &project), Some(id.into()));
        let dir =
            paths::claude_projects_dir().join(project.to_string_lossy().replace(['/', '.'], "-"));
        for invalid in ["", "bad", "ABCDEF00-1111-2222-3333-444455556666"] {
            TestEnv::set("CLAUDE_CODE_SESSION_ID", invalid);
            assert_eq!(
                lookup(Provider::Claude, &project),
                Err(format!(
                    "find-session: no transcript dir for {}\n  (looked in {})",
                    project.display(),
                    dir.display()
                ))
            );
        }
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ignored.txt"), "").unwrap();
        assert_eq!(
            lookup(Provider::Claude, &project),
            Err(format!(
                "find-session: no .jsonl transcripts in {}",
                dir.display()
            ))
        );
        for (name, seconds) in [("old", 1), ("new", 2)] {
            let path = dir.join(format!("{name}.jsonl"));
            fs::write(&path, "").unwrap();
            fs::File::open(path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
                .unwrap();
        }
        assert_eq!(find_session(Provider::Claude, &project), Some("new".into()));
    }

    #[test]
    fn codex_newest_filters_and_optional_edges() {
        let fixture = TestEnv::new();
        let _session_env = SessionEnv::new();
        TestEnv::set("COCKPIT_CODEX_DIR", fixture.dir.path());
        let project = fixture.dir.path();
        assert_eq!(
            lookup(Provider::Codex, project),
            Err(format!(
                "find-session: no Codex state database at {}",
                paths::codex_state_db().display()
            ))
        );
        let db = Connection::open(paths::codex_state_db()).unwrap();
        db.execute_batch("create table threads (id text primary key, cwd text, rollout_path text, archived integer, created_at integer, updated_at integer, created_at_ms integer, updated_at_ms integer);").unwrap();
        assert_eq!(
            lookup(Provider::Codex, project),
            Err(format!(
                "find-session: no Codex thread for {}",
                project.display()
            ))
        );
        for (id, cwd, rollout, archived, updated) in [
            ("old", project.to_str().unwrap(), "old.jsonl", 0, 1000),
            ("new", project.to_str().unwrap(), "new.jsonl", 0, 2000),
            (
                "archived",
                project.to_str().unwrap(),
                "archived.jsonl",
                1,
                9000,
            ),
            ("empty", project.to_str().unwrap(), "", 0, 9000),
            ("other", "/other", "other.jsonl", 0, 9000),
        ] {
            db.execute(
                "insert into threads values (?1, ?2, ?3, ?4, 1, 1, 1000, ?5)",
                rusqlite::params![id, cwd, rollout, archived, updated],
            )
            .unwrap();
        }
        assert_eq!(find_session(Provider::Codex, project), Some("new".into()));
        db.execute_batch("create table thread_spawn_edges (parent_thread_id text, child_thread_id text, status text); insert into thread_spawn_edges values ('old','new','open');").unwrap();
        assert_eq!(find_session(Provider::Codex, project), Some("old".into()));
        db.execute_batch(
            "update threads set updated_at_ms = null, updated_at = 3 where id = 'old';",
        )
        .unwrap();
        assert_eq!(find_session(Provider::Codex, project), Some("old".into()));
    }

    #[test]
    fn opencode_env_newest_and_filters() {
        let fixture = TestEnv::new();
        let _session_env = SessionEnv::new();
        TestEnv::set("OPENCODE_DATA_DIR", fixture.dir.path());
        let project = fixture.dir.path();
        TestEnv::set("OPENCODE_SESSION_ID", " ses_live ");
        TestEnv::set("OPENCODE_SESSION", " ses_fallback ");
        assert_eq!(
            find_session(Provider::Opencode, project),
            Some("ses_live".into())
        );
        TestEnv::set("OPENCODE_SESSION_ID", " ");
        assert_eq!(
            find_session(Provider::Opencode, project),
            Some("ses_fallback".into())
        );
        TestEnv::set("OPENCODE_SESSION", "");
        assert_eq!(
            lookup(Provider::Opencode, project),
            Err(format!(
                "find-session: no OpenCode database at {}",
                paths::opencode_db().display()
            ))
        );
        let db = Connection::open(paths::opencode_db()).unwrap();
        db.execute_batch("create table session (id text primary key, directory text, time_updated integer, time_archived integer);").unwrap();
        assert_eq!(
            lookup(Provider::Opencode, project),
            Err(format!(
                "find-session: no OpenCode session for {}",
                project.display()
            ))
        );
        for (id, cwd, updated, archived) in [
            ("ses_old", project.to_str().unwrap(), 1000, None),
            ("ses_new", project.to_str().unwrap(), 2000, None),
            ("archived", project.to_str().unwrap(), 9000, Some(1)),
            ("other", "/other", 9000, None),
        ] {
            db.execute(
                "insert into session values (?1,?2,?3,?4)",
                rusqlite::params![id, cwd, updated, archived],
            )
            .unwrap();
        }
        assert_eq!(
            find_session(Provider::Opencode, project),
            Some("ses_new".into())
        );
    }

    #[test]
    fn database_errors_and_provider_parsing() {
        let fixture = TestEnv::new();
        let _session_env = SessionEnv::new();
        for (provider, key, label, table) in [
            (
                Provider::Codex,
                "COCKPIT_CODEX_STATE_DB",
                "Codex state",
                "threads",
            ),
            (
                Provider::Opencode,
                "COCKPIT_OPENCODE_DB",
                "OpenCode database",
                "session",
            ),
        ] {
            let path = fixture.dir.path().join(key);
            TestEnv::set(key, &path);
            Connection::open(&path).unwrap();
            assert_eq!(
                lookup(provider, fixture.dir.path()),
                Err(format!(
                    "find-session: could not read {label} (no such table: {table})"
                ))
            );
            fs::write(path, "not sqlite").unwrap();
            assert_eq!(
                lookup(provider, fixture.dir.path()),
                Err(format!(
                    "find-session: could not read {label} (file is not a database)"
                ))
            );
            assert_eq!(find_session(provider, fixture.dir.path()), None);
        }
        for (name, provider) in [
            ("claude", Provider::Claude),
            ("codex", Provider::Codex),
            ("opencode", Provider::Opencode),
        ] {
            assert_eq!(name.parse(), Ok(provider));
        }
        assert!("other".parse::<Provider>().is_err());
    }
}
