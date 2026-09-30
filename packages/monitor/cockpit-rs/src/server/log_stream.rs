use super::AppState;
use crate::{
    log_root::absolute_lexical,
    registry::{RegistryEntry, read_registry},
};
use axum::{Router, extract::Query, routing::get};
use serde::Deserialize;
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

pub mod sse_tailer;
use sse_tailer::{Backlog, Resolve, TailSource, split_complete_lines};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/log/stream", get(stream))
}

#[derive(Default, Deserialize)]
struct Params {
    #[serde(default)]
    project: String,
    #[serde(default)]
    session: String,
}

async fn stream(Query(params): Query<Params>) -> axum::response::Response {
    sse_tailer::create_tail_stream(LogSource {
        project: params.project,
        session: params.session,
    })
}

fn inside(root: &Path, path: &Path) -> bool {
    path != root && path.starts_with(root)
}

fn resolve_with_entry(
    project: &str,
    session: &str,
    entry: Option<&RegistryEntry>,
) -> Option<PathBuf> {
    if project.is_empty() || !crate::registry::is_session_id(session) {
        return None;
    }
    let project = absolute_lexical(Path::new(project))?;
    let mut root = project.clone();
    if let Some(entry) = entry {
        let tracked = absolute_lexical(Path::new(entry.project()))?;
        if tracked != project && !inside(&tracked, &project) && !inside(&project, &tracked) {
            return None;
        }
        if !entry.log_path().is_empty() {
            root = tracked;
        }
    }
    let logs = root.join(".cockpit/logs");
    let path = match entry.filter(|entry| !entry.log_path().is_empty()) {
        Some(entry) => absolute_lexical(Path::new(entry.log_path()))?,
        None => logs.join(format!("{session}.jsonl")),
    };
    if !inside(&logs, &path) {
        return None;
    }
    if path.exists() {
        let real_logs = fs::canonicalize(&logs).ok()?;
        let real_file = fs::canonicalize(&path).ok()?;
        if !inside(&real_logs, &real_file) {
            return None;
        }
    }
    Some(path)
}

pub fn resolve_log_path(project: &str, session: &str) -> Option<PathBuf> {
    let registry = read_registry();
    resolve_with_entry(
        project,
        session,
        registry.iter().find(|entry| entry.session_id() == session),
    )
}

pub struct LogSource {
    pub project: String,
    pub session: String,
}

impl TailSource for LogSource {
    fn resolve(&self) -> Resolve {
        match resolve_log_path(&self.project, &self.session) {
            Some(path) => Resolve::Ready(path),
            None => Resolve::Fail {
                message: "invalid project/session".to_owned(),
                status: 400,
            },
        }
    }

    fn read_backlog(&self, path: &Path, size: u64) -> io::Result<Backlog> {
        // Stop at the stat size: the tailer resumes from it, so reading past it would repeat an append.
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(size).read_to_end(&mut bytes)?;
        let (complete, partial) = split_complete_lines(&bytes);
        Ok(Backlog {
            complete: String::from_utf8_lossy(complete).into_owned(),
            partial: partial.to_vec(),
            meta: None,
        })
    }

    fn emit(&self, out: &mut Vec<String>, complete_text: &str) {
        for line in complete_text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                // Re-serialize through preserve_order to match the compact TS envelope.
                out.push(format!("data: {value}\n\n"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Provider;
    use std::os::unix::fs::symlink;

    const SESSION: &str = "12345678-1234-1234-1234-123456789abc";

    #[test]
    fn validates_session_and_segment_wise_relation() {
        assert!(resolve_with_entry("", SESSION, None).is_none());
        assert!(resolve_with_entry("/repo", "../../bad", None).is_none());
        let entry = RegistryEntry::new(
            Provider::Claude,
            "/repo",
            SESSION,
            &format!("/repo/.cockpit/logs/{SESSION}.jsonl"),
            "",
        );
        assert!(resolve_with_entry("/repo-other", SESSION, Some(&entry)).is_none());
        assert_eq!(
            resolve_with_entry("/repo/frontend", SESSION, Some(&entry)),
            Some(PathBuf::from(entry.log_path()))
        );
        let child = RegistryEntry::new(
            Provider::Claude,
            "/repo/frontend",
            SESSION,
            &format!("/repo/frontend/.cockpit/logs/{SESSION}.jsonl"),
            "",
        );
        assert_eq!(
            resolve_with_entry("/repo", SESSION, Some(&child)),
            Some(PathBuf::from(child.log_path()))
        );
    }

    #[test]
    fn confines_lexical_and_real_paths_and_allows_missing_files() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().to_str().unwrap();
        let logs = directory.path().join(".cockpit/logs");
        let expected = logs.join(format!("{SESSION}.jsonl"));
        assert_eq!(
            resolve_with_entry(project, SESSION, None),
            Some(expected.clone())
        );
        let entry = RegistryEntry::new(
            Provider::Claude,
            project,
            SESSION,
            &logs.join("../escape").to_string_lossy(),
            "",
        );
        assert!(resolve_with_entry(project, SESSION, Some(&entry)).is_none());
        fs::create_dir_all(logs).unwrap();
        let outside = directory.path().join("outside");
        fs::write(&outside, b"{}\n").unwrap();
        symlink(outside, expected).unwrap();
        assert!(resolve_with_entry(project, SESSION, None).is_none());
    }

    #[test]
    fn backlog_stops_at_the_stat_size() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log.jsonl");
        fs::write(&path, b"{\"a\":1}\n{\"b\":2}\n").unwrap();
        let source = LogSource {
            project: String::new(),
            session: String::new(),
        };
        let backlog = source.read_backlog(&path, 11).unwrap();
        assert_eq!(backlog.complete, "{\"a\":1}");
        assert_eq!(backlog.partial, b"{\"b");
    }

    #[test]
    fn emits_compact_json_and_skips_bad_lines() {
        let source = LogSource {
            project: String::new(),
            session: String::new(),
        };
        let mut frames = Vec::new();
        source.emit(&mut frames, " \nnot json\n { \"b\": 2, \"a\": 1 }\nnull\n");
        assert_eq!(frames, ["data: {\"b\":2,\"a\":1}\n\n", "data: null\n\n"]);
    }
}
