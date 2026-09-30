use crate::server::{
    log_stream::sse_tailer::{HEARTBEAT_MS, tail_poll_ms},
    sources::{opencode_db, opencode_timestamp_ms},
};
use axum::{body::Body, response::IntoResponse};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    time::Instant,
};

const BACKLOG_LINES: i64 = 50;

struct Row {
    id: String,
    created: i64,
    updated: i64,
    data: String,
    part: Option<String>,
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

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn part_content(part: &Value) -> Vec<Value> {
    if !part.is_object() && !part.is_array() {
        return Vec::new();
    }
    let kind = part["type"].as_str().unwrap_or("");
    if kind == "tool" && part["tool"] == "read" {
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
    // A vector preserves JS Map first-seen order; preserve_order keeps TS field insertion order.
    let mut groups: Vec<(&Row, Vec<Value>)> = Vec::new();
    for row in rows {
        let index = groups
            .iter()
            .position(|(first, _)| first.id == row.id)
            .unwrap_or_else(|| {
                groups.push((row, Vec::new()));
                groups.len() - 1
            });
        if let Some(part) = row
            .part
            .as_deref()
            .and_then(|part| serde_json::from_str::<Value>(part).ok())
        {
            groups[index].1.extend(part_content(&part));
        }
    }
    let mut output = Vec::new();
    for (row, parts) in groups {
        let data = serde_json::from_str::<Value>(&row.data).unwrap_or(Value::Null);
        let role = if data["role"] == "user" {
            "user"
        } else {
            "assistant"
        };
        let content = if parts.is_empty() {
            // JS ?? preserves false, zero and empty strings; summary uses JS truthiness.
            nonnull([&data["content"], &data["text"]])
                .cloned()
                .unwrap_or_else(|| {
                    if truthy(&data["summary"]) {
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

fn read_rows(session: &str, cursor: i64) -> Vec<Row> {
    let read = || -> rusqlite::Result<Vec<Row>> {
        let db = Connection::open_with_flags(opencode_db(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut query = db.prepare("select m.id as message_id, m.time_created as message_created, m.time_updated as message_updated, m.data as message_data, p.id as part_id, p.time_created as part_created, p.data as part_data from (select id, session_id, time_created, time_updated, data from message where session_id = ? and time_updated > ? order by time_updated desc, id desc limit ?) m left join part p on p.message_id = m.id order by m.time_created asc, m.id asc, p.time_created asc, p.id asc")?;
        query
            .query_map((session, cursor, BACKLOG_LINES), |row| {
                Ok(Row {
                    id: row.get(0)?,
                    created: row.get(1)?,
                    updated: row.get(2)?,
                    data: row.get(3)?,
                    part: row.get(6)?,
                })
            })?
            .collect()
    };
    read().unwrap_or_default()
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

// Dropping the HTTP body aborts the poller even when no database rows arrive.
struct Reader {
    inner: tokio::io::DuplexStream,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl AsyncRead for Reader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buffer)
    }
}
impl AsyncWrite for Reader {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

pub(super) fn stream(session: String) -> axum::response::Response {
    use std::{future::Future, task::Waker};
    use tokio_tungstenite::{
        WebSocketStream,
        tungstenite::protocol::{
            Role,
            frame::{
                Frame,
                coding::{Data, OpCode},
            },
        },
    };
    let (reader, mut writer) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(async move {
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
            if !chunk.is_empty() {
                let mut bytes = Vec::new();
                if Frame::message(chunk.into_bytes(), OpCode::Data(Data::Binary), true)
                    .format(&mut bytes)
                    .is_err()
                    || writer.write_all(&bytes).await.is_err()
                {
                    break;
                }
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
    });
    let reader = Reader {
        inner: reader,
        task,
    };
    let mut constructor =
        std::pin::pin!(WebSocketStream::from_raw_socket(reader, Role::Client, None));
    // Match the shared tailer envelope without adding a stream dependency.
    let Poll::Ready(stream) = constructor
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    else {
        unreachable!("from_raw_socket performs no asynchronous I/O")
    };
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
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
    fn groups_parts_preserves_field_order_and_deduplicates() {
        let rows = vec![
            Row {
                id: "one".into(),
                created: 1,
                updated: 1_700_000_000_001,
                data: "{\"role\":\"user\"}".into(),
                part: Some("{\"type\":\"text\",\"text\":\"hello\"}".into()),
            },
            Row {
                id: "one".into(),
                created: 1,
                updated: 1_700_000_000_001,
                data: "{}".into(),
                part: Some("{\"type\":\"reasoning\",\"text\":\"think\"}".into()),
            },
            Row {
                id: "empty".into(),
                created: 2,
                updated: 2,
                data: "{}".into(),
                part: None,
            },
            Row {
                id: "false".into(),
                created: 3,
                updated: 0,
                data: "{\"content\":false}".into(),
                part: None,
            },
        ];
        let mapped = entries(&rows);
        assert_eq!(mapped.len(), 2);
        assert_eq!(
            mapped[0].to_string(),
            "{\"type\":\"user\",\"uuid\":\"one\",\"timestamp\":\"2023-11-14T22:13:20.001Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"},{\"type\":\"thinking\",\"thinking\":\"think\"}]},\"provider\":\"opencode\"}"
        );
        assert!(mapped[1].get("timestamp").is_none());
        let mut cursor = 0;
        let mut seen = HashSet::new();
        assert!(!emit_rows(&rows, &mut cursor, &mut seen).is_empty());
        assert_eq!(cursor, 1_700_000_000_001);
        assert!(emit_rows(&rows, &mut cursor, &mut seen).is_empty());
    }
}
