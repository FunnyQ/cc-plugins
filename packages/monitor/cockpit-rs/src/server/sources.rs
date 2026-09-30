#![allow(dead_code)] // Shared provider readers are used by later transcript and views routes.

use crate::paths;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub fn codex_dir() -> PathBuf {
    paths::codex_dir()
}

pub fn codex_state_db() -> PathBuf {
    paths::codex_state_db()
}

pub fn opencode_db() -> PathBuf {
    paths::opencode_db()
}

pub fn codex_sessions_dir() -> PathBuf {
    env::var_os("COCKPIT_CODEX_SESSIONS_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_dir().join("sessions"))
}

pub fn resolve_claude_transcript_path(id: &str) -> Option<PathBuf> {
    fn find(dir: &Path, name: &str) -> Option<PathBuf> {
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if kind.is_file() && entry.file_name() == name {
                return Some(entry.path());
            }
            if kind.is_dir()
                && let Some(path) = find(&entry.path(), name)
            {
                return Some(path);
            }
        }
        None
    }
    find(&paths::claude_projects_dir(), &format!("{id}.jsonl"))
}

pub fn resolve_codex_rollout_path(id: &str) -> Option<PathBuf> {
    let db =
        Connection::open_with_flags(codex_state_db(), OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let path: String = db
        .query_row(
            "select rollout_path from threads where id = ?1 and archived = 0 and rollout_path != '' limit 1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    Some(paths::resolve_codex_path(&path))
}

pub fn opencode_timestamp_ms(value: i64) -> i64 {
    if value <= 0 {
        0
    } else if value < 1_000_000_000_000 {
        value * 1000
    } else {
        value
    }
}

pub fn read_tail_bytes(path: &Path, limit: usize) -> Vec<u8> {
    let read = || -> io::Result<Vec<u8>> {
        let mut file = fs::File::open(path)?;
        let length = file.metadata()?.len();
        let start = length.saturating_sub(limit as u64);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.take(limit as u64).read_to_end(&mut bytes)?;
        Ok(bytes)
    };
    read().unwrap_or_default()
}

pub struct JsonlLines {
    reader: BufReader<fs::File>,
    done: bool,
}

pub fn read_jsonl_lines(path: &Path) -> io::Result<JsonlLines> {
    Ok(JsonlLines {
        reader: BufReader::with_capacity(64 * 1024, fs::File::open(path)?),
        done: false,
    })
}

impl Iterator for JsonlLines {
    type Item = io::Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let mut bytes = Vec::new();
        match self.reader.read_until(b'\n', &mut bytes) {
            Ok(0) => {
                self.done = true;
                None
            }
            Ok(_) => {
                if bytes.last() == Some(&b'\n') {
                    bytes.pop();
                }
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                // Decode after splitting bytes so multibyte characters crossing chunks survive.
                Some(Ok(String::from_utf8_lossy(&bytes).into_owned()))
            }
            Err(error) => {
                self.done = true;
                Some(Err(error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn recursive_claude_lookup_and_missing_roots() {
        let fixture = TestEnv::new();
        let root = fixture.dir.path().join("projects");
        TestEnv::set("COCKPIT_CLAUDE_PROJECTS_DIR", &root);
        assert_eq!(resolve_claude_transcript_path("session"), None);
        let nested = root.join("project/subagents");
        fs::create_dir_all(&nested).unwrap();
        let path = nested.join("session.jsonl");
        fs::write(&path, "{}").unwrap();
        fs::create_dir_all(root.join("directory.jsonl")).unwrap();
        assert_eq!(resolve_claude_transcript_path("session"), Some(path));
        assert_eq!(resolve_claude_transcript_path("directory"), None);
        assert_eq!(resolve_claude_transcript_path("absent"), None);
    }

    #[test]
    fn codex_read_only_resolution_filters_and_database_errors() {
        let fixture = TestEnv::new();
        TestEnv::set("COCKPIT_CODEX_DIR", fixture.dir.path());
        assert_eq!(resolve_codex_rollout_path("missing"), None);
        assert!(!codex_state_db().exists());
        let db = Connection::open(codex_state_db()).unwrap();
        assert_eq!(resolve_codex_rollout_path("missing"), None);
        db.execute_batch("create table threads (id text, archived integer, rollout_path text); insert into threads values ('relative',0,'sessions/file.jsonl'), ('absolute',0,'/absolute.jsonl'), ('archived',1,'old.jsonl'), ('empty',0,'');").unwrap();
        assert_eq!(
            resolve_codex_rollout_path("relative"),
            Some(fixture.dir.path().join("sessions/file.jsonl"))
        );
        assert_eq!(
            resolve_codex_rollout_path("absolute"),
            Some(PathBuf::from("/absolute.jsonl"))
        );
        for id in ["archived", "empty", "missing", "' or 1=1 --"] {
            assert_eq!(resolve_codex_rollout_path(id), None);
        }
        drop(db);
        fs::write(codex_state_db(), "invalid sqlite").unwrap();
        assert_eq!(resolve_codex_rollout_path("relative"), None);
    }

    #[test]
    fn tail_is_bounded_and_lines_decode_across_chunks() {
        let fixture = TestEnv::new();
        let path = fixture.dir.path().join("transcript.jsonl");
        let first = format!("{}界", "a".repeat(64 * 1024 - 1));
        fs::write(&path, format!("{first}\r\n\nlast\r")).unwrap();
        assert_eq!(read_tail_bytes(&path, 7), b"\n\nlast\r");
        assert!(read_tail_bytes(&path, 0).is_empty());
        assert!(read_tail_bytes(&path.with_extension("absent"), 8).is_empty());
        let lines = read_jsonl_lines(&path)
            .unwrap()
            .collect::<io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(lines, vec![first, String::new(), "last".into()]);
        fs::write(&path, b"\xff\nvalid\n").unwrap();
        assert_eq!(
            read_jsonl_lines(&path)
                .unwrap()
                .collect::<io::Result<Vec<_>>>()
                .unwrap(),
            vec!["�", "valid"]
        );
    }

    #[test]
    fn timestamps_preserve_milliseconds_and_convert_seconds() {
        for (value, expected) in [
            (-1, 0),
            (0, 0),
            (1, 1000),
            (999_999_999_999, 999_999_999_999_000),
            (1_000_000_000_000, 1_000_000_000_000),
            (i64::MAX, i64::MAX),
        ] {
            assert_eq!(opencode_timestamp_ms(value), expected);
        }
    }

    #[test]
    fn sessions_directory_honors_override_and_empty_fallback() {
        let fixture = TestEnv::new();
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                // The enclosing TestEnv holds the environment lock through restoration.
                unsafe {
                    match &self.0 {
                        Some(value) => env::set_var("COCKPIT_CODEX_SESSIONS_DIR", value),
                        None => env::remove_var("COCKPIT_CODEX_SESSIONS_DIR"),
                    }
                }
            }
        }
        let _restore = Restore(env::var_os("COCKPIT_CODEX_SESSIONS_DIR"));
        TestEnv::set("COCKPIT_CODEX_DIR", fixture.dir.path());
        TestEnv::set("COCKPIT_CODEX_SESSIONS_DIR", "");
        assert_eq!(codex_sessions_dir(), fixture.dir.path().join("sessions"));
        let custom = fixture.dir.path().join("custom");
        TestEnv::set("COCKPIT_CODEX_SESSIONS_DIR", &custom);
        assert_eq!(codex_sessions_dir(), custom);
    }
}
