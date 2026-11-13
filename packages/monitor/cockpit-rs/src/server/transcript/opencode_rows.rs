use crate::server::{
    log_stream::sse_tailer::{HEARTBEAT_MS, sse_response, tail_poll_ms},
    sources::opencode_timestamp_ms,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use tokio::time::Instant;

const BACKLOG_LINES: i64 = 50;

struct Row {
    id: String,
    created: i64,
    updated: i64,
    data: String,
    kind: String,
}

fn compact_path(path: &str) -> String {
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let compact = parts[parts.len().saturating_sub(3)..].join("/");
    if compact.is_empty() {
        path.to_owned()
    } else {
        compact
    }
}

fn nonnull<'a>(values: impl IntoIterator<Item = &'a Value>) -> Option<&'a Value> {
    values.into_iter().find(|value| !value.is_null())
}

fn part_content(part: &Value) -> Vec<Value> {
    if !part.is_object() && !part.is_array() {
        return Vec::new();
    }
    let kind = part["type"].as_str().unwrap_or("");
    if kind == "tool"
        && nonnull([&part["tool"], &part["name"]]).and_then(Value::as_str) == Some("read")
    {
        let state = &part["state"];
        let path = nonnull([
            &state["input"]["filePath"],
            &state["input"]["path"],
            &state["metadata"]["display"]["path"],
        ])
        .and_then(Value::as_str)
        .unwrap_or("");
        let text = nonnull([
            &state["metadata"]["display"]["text"],
            &state["metadata"]["preview"],
            &state["output"],
        ])
        .and_then(Value::as_str)
        .unwrap_or("");
        if !text.trim().is_empty() || !path.is_empty() {
            return vec![
                json!({"type":"tool_result", "label":if path.is_empty() { "Read".to_owned() } else { format!("Read · {}", compact_path(path)) }, "file_path":path, "content":text}),
            ];
        }
    }
    if kind == "text"
        && let Some(text) = part["text"].as_str()
    {
        return vec![json!({"type":"text", "text":text})];
    }
    if kind == "reasoning"
        && let Some(text) = part["text"].as_str()
    {
        return vec![json!({"type":"thinking", "thinking":text})];
    }
    if kind == "tool" {
        return vec![
            json!({"type":"tool_use", "name":nonnull([&part["name"], &part["tool"]]).cloned().unwrap_or(json!("tool")), "input":nonnull([&part["input"]]).unwrap_or(part)}),
        ];
    }
    if matches!(kind, "step-start" | "step-finish") {
        return Vec::new();
    }
    if kind == "patch" {
        let files: Vec<_> = part["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if files.is_empty() {
            return Vec::new();
        }
        let text = std::iter::once("Changed files:".to_owned())
            .chain(
                files
                    .into_iter()
                    .map(|file| format!("- `{}`", compact_path(file))),
            )
            .collect::<Vec<_>>()
            .join("\n");
        return vec![json!({"type":"text", "text":text})];
    }
    let text = nonnull([&part["text"], &part["content"]])
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string_pretty(part).unwrap_or_default());
    vec![json!({"type":"text", "text":text})]
}

fn entries(rows: &[Row]) -> Vec<Value> {
    let mut groups: Vec<(&Row, Vec<Value>)> = Vec::new();
    for row in rows {
        if groups.last().is_none_or(|(first, _)| first.id != row.id) {
            groups.push((row, Vec::new()));
        }
        if let Some((_, parts)) = groups.last_mut() {
            // V2 stores the message parts inline in data.content; part_content
            // renders each one the way the legacy part table did.
            if let Some(content) = serde_json::from_str::<Value>(&row.data)
                .ok()
                .and_then(|data| data["content"].as_array().cloned())
            {
                for part in &content {
                    parts.extend(part_content(part));
                }
            }
        }
    }
    let mut output = Vec::new();
    for (row, parts) in groups {
        let data = serde_json::from_str::<Value>(&row.data).unwrap_or(Value::Null);
        let role = match row.kind.as_str() {
            "user" => "user",
            "assistant" => "assistant",
            _ => continue,
        };
        let content = if parts.is_empty() {
            nonnull([&data["content"], &data["text"]])
                .cloned()
                .unwrap_or_else(|| {
                    if crate::server::opencode::js_truthy(&data["summary"]) {
                        json!(serde_json::to_string_pretty(&data["summary"]).unwrap_or_default())
                    } else {
                        json!("")
                    }
                })
        } else {
            Value::Array(parts)
        };
        if content.is_null() || content.as_str().is_some_and(|text| text.trim().is_empty()) {
            continue;
        }
        let mut entry = json!({"type":role, "uuid":row.id});
        let ms = opencode_timestamp_ms(row.updated);
        if ms != 0
            && let Ok(timestamp) = jiff::Timestamp::from_millisecond(ms)
        {
            entry["timestamp"] = json!(format!("{timestamp:.3}"));
        }
        entry["message"] = json!({"role":role, "content":content});
        entry["provider"] = json!("opencode");
        output.push(entry);
    }
    output
}

fn query_rows(db: &Connection, session: &str, cursor: i64) -> rusqlite::Result<Vec<Row>> {
    let mut query = db.prepare("select id, time_created, time_updated, data, type from (select * from session_message where session_id = ? and time_updated > ? order by time_updated desc, id desc limit ?) order by seq")?;
    query
        .query_map((session, cursor, BACKLOG_LINES), |row| {
            Ok(Row {
                id: row.get(0)?,
                created: row.get(1)?,
                updated: row.get(2)?,
                data: row.get(3)?,
                kind: row.get(4)?,
            })
        })?
        .collect()
}

fn read_rows(session: &str, cursor: i64) -> Vec<Row> {
    Connection::open_with_flags(crate::paths::opencode_db(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|db| query_rows(&db, session, cursor))
        .unwrap_or_default()
}

fn emit_rows(rows: &[Row], cursor: &mut i64, seen: &mut HashSet<String>) -> String {
    for row in rows {
        *cursor = (*cursor).max(if row.updated != 0 {
            row.updated
        } else {
            row.created
        });
    }
    let mut output = String::new();
    for entry in entries(rows) {
        if let Some(id) = entry["uuid"].as_str()
            && seen.insert(id.to_owned())
        {
            output.push_str(&format!("data: {entry}\n\n"));
        }
    }
    output
}

pub(super) fn stream(session: String) -> axum::response::Response {
    sse_response(|sender| async move {
        let mut cursor = 0;
        let mut seen = HashSet::new();
        let mut chunk = format!(
            ": connected\n\n{}event: backlog-done\ndata: {{}}\n\n",
            emit_rows(&read_rows(&session, 0), &mut cursor, &mut seen)
        );
        let cadence = tail_poll_ms();
        let mut poll = Instant::now() + cadence;
        let mut heartbeat = Instant::now() + Duration::from_millis(HEARTBEAT_MS);
        loop {
            if !chunk.is_empty() && sender.send(chunk).await.is_err() {
                break;
            }
            chunk = tokio::select! {
                _ = tokio::time::sleep_until(poll) => {
                    poll = Instant::now() + cadence;
                    emit_rows(&read_rows(&session, cursor), &mut cursor, &mut seen)
                },
                _ = tokio::time::sleep_until(heartbeat) => {
                    heartbeat = Instant::now() + Duration::from_millis(HEARTBEAT_MS);
                    ": ping\n\n".to_owned()
                }
            };
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_read_patch_reasoning_and_tool_parts() {
        assert_eq!(
            part_content(
                &json!({"type":"tool", "tool":"read", "state":{"input":{"filePath":"/a/b/c/d.rs"},"output":"output","metadata":{"preview":"preview","display":{"text":"display"}}}})
            ),
            vec![
                json!({"type":"tool_result","label":"Read · b/c/d.rs","file_path":"/a/b/c/d.rs","content":"display"})
            ]
        );
        assert_eq!(
            part_content(&json!({"type":"patch","files":["/a/b/c/d.rs",4,"x.rs"]})),
            vec![json!({"type":"text","text":"Changed files:\n- `b/c/d.rs`\n- `x.rs`"})]
        );
        assert_eq!(
            part_content(&json!({"type":"reasoning","text":"think"})),
            vec![json!({"type":"thinking","thinking":"think"})]
        );
        assert_eq!(
            part_content(&json!({"type":"tool","tool":"read"}))[0]["type"],
            "tool_use"
        );
        assert!(part_content(&json!({"type":"step-start"})).is_empty());
        assert!(part_content(&json!({"type":"patch","files":[1]})).is_empty());
        assert_eq!(
            part_content(&json!({"other":1})),
            vec![json!({"type":"text","text":"{\n  \"other\": 1\n}"})]
        );
    }

    #[test]
    fn inline_content_renders_and_deduplicates() {
        let rows = vec![
            Row {
                id: "one".into(),
                created: 1,
                updated: 1_700_000_000_001,
                data: r#"{"content":[{"type":"text","text":"hello"},{"type":"reasoning","text":"think"}]}"#.into(),
                kind: "user".into(),
            },
            Row {
                id: "empty".into(),
                created: 2,
                updated: 2,
                data: "{}".into(),
                kind: "assistant".into(),
            },
            Row {
                id: "false".into(),
                created: 3,
                updated: 0,
                data: "{\"content\":false}".into(),
                kind: "assistant".into(),
            },
        ];
        let mapped = entries(&rows);
        assert_eq!(mapped.len(), 2);
        assert_eq!(
            mapped[0].to_string(),
            "{\"type\":\"user\",\"uuid\":\"one\",\"timestamp\":\"2023-11-14T22:13:20.001Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"},{\"type\":\"thinking\",\"thinking\":\"think\"}]},\"provider\":\"opencode\"}"
        );
        assert!(mapped[1].get("timestamp").is_none());
        assert_eq!(
            mapped
                .iter()
                .map(|entry| entry["uuid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["one", "false"]
        );
        let mut cursor = 0;
        let mut seen = HashSet::new();
        assert!(!emit_rows(&rows, &mut cursor, &mut seen).is_empty());
        assert_eq!(cursor, 1_700_000_000_001);
        assert!(emit_rows(&rows, &mut cursor, &mut seen).is_empty());
    }

    #[test]
    fn content_falls_back_by_js_nullish_and_summary_by_truthiness() {
        let row = |data: &str| Row {
            id: "m".into(),
            created: 0,
            updated: 0,
            data: data.into(),
            kind: "assistant".into(),
        };
        let content = |data: &str| {
            entries(&[row(data)])
                .first()
                .map(|entry| entry["message"]["content"].clone())
        };
        assert_eq!(
            content("{\"content\":false,\"text\":\"x\"}"),
            Some(json!(false))
        );
        assert_eq!(content("{\"content\":0,\"text\":\"x\"}"), Some(json!(0)));
        assert_eq!(content("{\"content\":\"\",\"text\":\"x\"}"), None);
        assert_eq!(content("{\"summary\":0}"), None);
        assert_eq!(content("{\"summary\":\"\"}"), None);
        assert_eq!(
            content("{\"summary\":{\"a\":1}}"),
            Some(json!("{\n  \"a\": 1\n}"))
        );
    }

    #[test]
    fn rows_follow_seq_even_when_a_prompt_is_updated_after_its_reply() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
             insert into session_message values ('prompt', 's', 'user', 0, 10, 530654, '{}');
             insert into session_message values ('reply', 's', 'assistant', 1, 11, 530622, '{}');",
        )
        .unwrap();
        let ids: Vec<_> = query_rows(&db, "s", 0)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(ids, ["prompt", "reply"]);
    }

    #[test]
    fn system_synthetic_and_idle_rows_are_not_replies() {
        let row = |kind: &str| Row {
            id: kind.into(),
            created: 0,
            updated: 0,
            data: json!({"text":"The server restarted while you were working"}).to_string(),
            kind: kind.into(),
        };
        assert!(entries(&[row("system"), row("synthetic"), row("idle")]).is_empty());
    }

    #[test]
    fn non_adjacent_rows_with_the_same_id_stay_split() {
        let row = |id: &str, kind: &str, text: &str| Row {
            id: id.into(),
            created: 0,
            updated: 0,
            data: json!({"content":[{"type":"text","text":text}]}).to_string(),
            kind: kind.into(),
        };
        let mapped = entries(&[
            row("a", "user", "one"),
            row("b", "assistant", "two"),
            row("a", "user", "three"),
        ]);
        assert_eq!(
            mapped
                .iter()
                .map(|entry| (
                    entry["uuid"].as_str().unwrap(),
                    entry["message"]["content"][0]["text"].as_str().unwrap()
                ))
                .collect::<Vec<_>>(),
            [("a", "one"), ("b", "two"), ("a", "three")]
        );
    }
}
