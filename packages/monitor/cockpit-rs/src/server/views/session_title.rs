use crate::{paths, registry::Provider, server::sources};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{fs, path::Path};

fn normalize_title(value: &str) -> String {
    value
        .split(|character: char| {
            matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn database_title(path: &Path, sql: &str, session_id: &str) -> Option<String> {
    let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let title: String = database
        .query_row(sql, [session_id], |row| row.get(0))
        .ok()?;
    let title = normalize_title(&title);
    (!title.is_empty()).then_some(title)
}

fn transcript_title(path: &Path) -> Option<String> {
    for line in sources::read_jsonl_lines(path).ok()? {
        let line = line.ok()?;
        if line.trim().is_empty() {
            continue;
        }
        // A malformed entry aborts this transcript just as the TS reader's catch does.
        let entry: Value = serde_json::from_str(&line).ok()?;
        if entry["type"] != "user" || entry["message"]["role"] != "user" {
            continue;
        }
        let content = &entry["message"]["content"];
        if let Some(text) = content.as_str() {
            return Some(normalize_title(text));
        }
        if let Some(blocks) = content.as_array() {
            let text = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            let title = normalize_title(&text);
            if !title.is_empty() {
                return Some(title);
            }
        }
    }
    None
}

fn claude_title(directory: &Path, filename: &str) -> Option<String> {
    for entry in fs::read_dir(directory).ok()?.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file()
            && entry.file_name() == filename
            && let Some(title) = transcript_title(&entry.path())
        {
            return Some(title);
        }
        if kind.is_dir()
            && let Some(title) = claude_title(&entry.path(), filename)
        {
            return Some(title);
        }
    }
    None
}

pub fn resolve_historical_session_title(provider: Provider, session_id: &str) -> Option<String> {
    match provider {
        Provider::Codex => database_title(
            &sources::codex_state_db(),
            "select title from threads where id = ?1 limit 1",
            session_id,
        ),
        Provider::Opencode => database_title(
            &sources::opencode_db(),
            "select title from session where id = ?1 limit 1",
            session_id,
        ),
        Provider::Claude => claude_title(
            &paths::claude_projects_dir(),
            &format!("{session_id}.jsonl"),
        )
        .filter(|title| !title.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn normalization_matches_javascript_whitespace() {
        assert_eq!(
            normalize_title("\u{feff}first\u{00a0}second\u{2028}"),
            "first second"
        );
        assert_eq!(
            normalize_title("first\u{0085}second"),
            "first\u{0085}second"
        );
    }

    #[test]
    fn claude_reads_first_user_text_and_text_blocks_without_loading_history() {
        let fixture = TestEnv::new();
        TestEnv::set("COCKPIT_CLAUDE_PROJECTS_DIR", fixture.dir.path());
        let nested = fixture.dir.path().join("nested/project");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("plain.jsonl"), "{}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"  hello\\n world  \"}}\ninvalid").unwrap();
        assert_eq!(
            resolve_historical_session_title(Provider::Claude, "plain"),
            Some("hello world".into())
        );
        fs::write(nested.join("blocks.jsonl"), "{\"type\":\"user\",\"message\":{\"role\":\"assistant\",\"content\":\"wrong\"}}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"  first\"},{\"text\":42},null,{\"text\":\"second\\tword \"}]}}").unwrap();
        assert_eq!(
            resolve_historical_session_title(Provider::Claude, "blocks"),
            Some("first second word".into())
        );
        fs::write(
            nested.join("bad.jsonl"),
            "invalid\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ignored\"}}",
        )
        .unwrap();
        assert_eq!(
            resolve_historical_session_title(Provider::Claude, "bad"),
            None
        );
        fs::write(nested.join("empty.jsonl"), "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"  \"}}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"ignored\"}}").unwrap();
        assert_eq!(
            resolve_historical_session_title(Provider::Claude, "empty"),
            None
        );
        assert_eq!(
            resolve_historical_session_title(Provider::Claude, "absent"),
            None
        );
    }

    #[test]
    fn provider_database_titles_are_read_only_normalized_and_parameterized() {
        let fixture = TestEnv::new();
        let path = fixture.dir.path().join("titles.sqlite");
        TestEnv::set("COCKPIT_CODEX_STATE_DB", &path);
        TestEnv::set("COCKPIT_OPENCODE_DB", &path);
        assert_eq!(
            resolve_historical_session_title(Provider::Codex, "missing"),
            None
        );
        assert!(!path.exists());
        let db = Connection::open(&path).unwrap();
        db.execute_batch("create table threads (id text, title text); create table session (id text, title text); insert into threads values ('codex','  Codex  title  '), ('empty',' '); insert into session values ('opencode',' OpenCode title ');").unwrap();
        assert_eq!(
            resolve_historical_session_title(Provider::Codex, "codex"),
            Some("Codex title".into())
        );
        assert_eq!(
            resolve_historical_session_title(Provider::Opencode, "opencode"),
            Some("OpenCode title".into())
        );
        assert_eq!(
            resolve_historical_session_title(Provider::Codex, "empty"),
            None
        );
        assert_eq!(
            resolve_historical_session_title(Provider::Codex, "' or 1=1 --"),
            None
        );
    }
}
