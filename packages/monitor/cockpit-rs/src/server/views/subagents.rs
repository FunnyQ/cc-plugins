use crate::{paths, server::sources::read_tail_bytes};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{fs, path::Path, time::UNIX_EPOCH};

const STALE_MS: i64 = 10 * 60 * 1000;
const TAIL_BYTES: usize = 64 * 1024;

fn tail_lines(path: &Path) -> String {
    let bytes = read_tail_bytes(path, TAIL_BYTES);
    let text = String::from_utf8_lossy(&bytes);
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() > TAIL_BYTES as u64) {
        text.split_once('\n')
            .map(|(_, tail)| tail.to_owned())
            .unwrap_or_default()
    } else {
        text.into_owned()
    }
}

fn sidechain_is_done(text: &str) -> bool {
    for line in text.lines().rev() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match entry["type"].as_str() {
            Some("progress") if entry["data"]["hookEvent"] == "SubagentStop" => return true,
            Some("assistant") => {
                return entry["message"]["stop_reason"] != "tool_use"
                    && !entry["message"]["content"]
                        .as_array()
                        .is_some_and(|blocks| {
                            blocks.iter().any(|block| block["type"] == "tool_use")
                        });
            }
            Some("user") => return false,
            _ => {}
        }
    }
    false
}

fn codex_rollout_is_done(text: &str) -> bool {
    text.lines().rev().any(|line| {
        serde_json::from_str::<Value>(line.trim()).is_ok_and(|entry| {
            entry["type"] == "event_msg" && entry["payload"]["type"] == "task_complete"
        })
    })
}

pub fn claude_active_subagents(transcript: &Path, now_ms: i64) -> u32 {
    if transcript
        .extension()
        .is_none_or(|extension| extension != "jsonl")
    {
        return 0;
    }
    let Ok(entries) = fs::read_dir(transcript.with_extension("").join("subagents")) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("agent-") || !name.ends_with(".jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        let modified_ms = modified
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or(0);
        if now_ms.saturating_sub(modified_ms) <= STALE_MS
            && !sidechain_is_done(&tail_lines(&entry.path()))
        {
            count += 1;
        }
    }
    count
}

pub fn codex_active_subagents(db: &Path, parent_thread_id: &str, now_ms: i64) -> u32 {
    let read = || -> rusqlite::Result<u32> {
        let connection = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut statement = connection.prepare("select e.status, t.rollout_path, t.updated_at, t.updated_at_ms from thread_spawn_edges e join threads t on t.id = e.child_thread_id where e.parent_thread_id = ?1 and t.archived = 0")?;
        let rows = statement.query_map([parent_thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?;
        let mut count = 0;
        for row in rows {
            let (status, rollout, updated_seconds, updated_ms) = row?;
            if status == "closed"
                || now_ms.saturating_sub(
                    updated_ms.unwrap_or_else(|| updated_seconds.saturating_mul(1000)),
                ) > STALE_MS
            {
                continue;
            }
            let path = paths::resolve_codex_path(&rollout);
            if path.exists() && !codex_rollout_is_done(&tail_lines(&path)) {
                count += 1;
            }
        }
        Ok(count)
    };
    read().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn terminal_assistants_hooks_and_pending_tools() {
        for reason in ["end_turn", "stop_sequence", "max_tokens"] {
            assert!(sidechain_is_done(&format!(
                r#"{{"type":"assistant","message":{{"stop_reason":"{reason}"}}}}"#
            )));
        }
        assert!(sidechain_is_done(
            r#"{"type":"assistant","message":{"stop_reason":null}}"#
        ));
        assert!(!sidechain_is_done(
            r#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#
        ));
        assert!(!sidechain_is_done(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#
        ));
        assert!(sidechain_is_done(
            "{\"type\":\"user\"}\n{\"type\":\"progress\",\"data\":{\"hookEvent\":\"SubagentStop\"}}\nbroken"
        ));
        assert!(!sidechain_is_done(
            "{\"type\":\"assistant\"}\n{\"type\":\"user\"}\n{}"
        ));
        assert!(!sidechain_is_done("\ninvalid\n{}"));
        assert!(codex_rollout_is_done(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n{}\ninvalid"
        ));
    }

    #[test]
    fn claude_counts_recent_pending_sidechains_and_bounded_tails() {
        let fixture = TestEnv::new();
        let transcript = fixture.dir.path().join("session.jsonl");
        let directory = transcript.with_extension("").join("subagents");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("agent-running.jsonl"),
            "{\"type\":\"user\"}\n",
        )
        .unwrap();
        fs::write(
            directory.join("agent-done.jsonl"),
            "{\"type\":\"assistant\"}\n",
        )
        .unwrap();
        fs::write(directory.join("agent-empty.jsonl"), "").unwrap();
        fs::write(directory.join("other.jsonl"), "").unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(claude_active_subagents(&transcript, now), 2);
        assert_eq!(
            claude_active_subagents(&transcript, now + STALE_MS + 1000),
            0
        );
        let long = directory.join("agent-long.jsonl");
        fs::write(
            &long,
            format!(
                "{}\n{{\"type\":\"assistant\"}}\n",
                "x".repeat(TAIL_BYTES + 1)
            ),
        )
        .unwrap();
        assert_eq!(tail_lines(&long), "{\"type\":\"assistant\"}\n");
    }

    #[test]
    fn codex_filters_closed_stale_archived_missing_and_completed_children() {
        let fixture = TestEnv::new();
        TestEnv::set("COCKPIT_CODEX_DIR", fixture.dir.path());
        let db_path = fixture.dir.path().join("state.sqlite");
        assert_eq!(codex_active_subagents(&db_path, "parent", 1000), 0);
        assert!(!db_path.exists());
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("create table threads (id text, rollout_path text, updated_at integer, updated_at_ms integer, archived integer); create table thread_spawn_edges (parent_thread_id text, child_thread_id text, status text);").unwrap();
        for (id, status, age, archived, exists, done) in [
            ("running", "open", 0, 0, true, false),
            ("closed", "closed", 0, 0, true, false),
            ("stale", "open", STALE_MS + 1, 0, true, false),
            ("archived", "open", 0, 1, true, false),
            ("missing", "open", 0, 0, false, false),
            ("done", "open", 0, 0, true, true),
        ] {
            let filename = format!("{id}.jsonl");
            if exists {
                fs::write(
                    fixture.dir.path().join(&filename),
                    if done {
                        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}"
                    } else {
                        "{}"
                    },
                )
                .unwrap();
            }
            db.execute(
                "insert into threads values (?1,?2,0,?3,?4)",
                rusqlite::params![id, filename, 1_000_000 - age, archived],
            )
            .unwrap();
            db.execute(
                "insert into thread_spawn_edges values ('parent',?1,?2)",
                [id, status],
            )
            .unwrap();
        }
        assert_eq!(codex_active_subagents(&db_path, "parent", 1_000_000), 1);
        assert_eq!(codex_active_subagents(&db_path, "absent", 1_000_000), 0);
    }
}
