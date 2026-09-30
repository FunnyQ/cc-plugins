use super::{
    AppState, json_error, json_response,
    log_stream::sse_tailer::{self, Backlog, Resolve, TailSource, split_complete_lines},
    sources,
};
use crate::registry::Provider;
use axum::{Router, extract::Query, http::StatusCode, response::Response, routing::get};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

mod opencode_rows;

const BACKLOG_LINES: usize = 50;
const BACKLOG_READ_CHUNK_BYTES: u64 = 256 * 1024;
const MAX_BACKLOG_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HISTORY_LIMIT: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/transcript/stream", get(stream))
        .route("/api/transcript/history", get(history))
}

#[derive(Default, Deserialize)]
struct Params {
    #[serde(default)]
    session: String,
    provider: Option<String>,
    before: Option<String>,
    limit: Option<String>,
}

fn validate(params: &Params) -> Result<Provider, &'static str> {
    let provider = match params.provider.as_deref() {
        None | Some("" | "claude") => Provider::Claude,
        Some("codex") => Provider::Codex,
        Some("opencode") => Provider::Opencode,
        _ => return Err("invalid provider"),
    };
    let valid = if provider == Provider::Opencode {
        !params.session.is_empty()
            && params.session.len() <= 160
            && params
                .session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    } else {
        crate::registry::is_session_id(&params.session)
    };
    if !valid {
        return Err("invalid session id");
    }
    Ok(provider)
}

struct TranscriptSource {
    provider: Provider,
    session: String,
}
impl TranscriptSource {
    fn path(&self) -> Option<PathBuf> {
        if self.provider == Provider::Codex {
            return sources::resolve_codex_rollout_path(&self.session);
        }
        sources::resolve_claude_transcript_path(&self.session).or_else(|| {
            // The shared lookup omits symlinks; discover them before enforcing confinement.
            fn find(dir: &Path, name: &str, visited: &mut HashSet<PathBuf>) -> Option<PathBuf> {
                if !visited.insert(fs::canonicalize(dir).ok()?) {
                    return None;
                }
                for entry in fs::read_dir(dir).ok()?.flatten() {
                    let path = entry.path();
                    if entry.file_name() == name && path.is_file() {
                        return Some(path);
                    }
                    if path.is_dir()
                        && let Some(found) = find(&path, name, visited)
                    {
                        return Some(found);
                    }
                }
                None
            }
            find(
                &crate::paths::claude_projects_dir(),
                &format!("{}.jsonl", self.session),
                &mut HashSet::new(),
            )
        })
    }
}
impl TailSource for TranscriptSource {
    fn resolve(&self) -> Resolve {
        let Some(path) = self.path().and_then(|p| fs::canonicalize(p).ok()) else {
            return Resolve::Wait;
        };
        let (root, name) = if self.provider == Provider::Codex {
            (sources::codex_sessions_dir(), "Codex sessions")
        } else {
            (crate::paths::claude_projects_dir(), "~/.claude/projects")
        };
        let root = fs::canonicalize(&root).unwrap_or(root);
        if path == root || !path.starts_with(root) {
            return Resolve::Fail {
                message: format!("transcript path is outside {name}"),
                status: 403,
            };
        }
        Resolve::Ready(path)
    }
    fn read_backlog(&self, path: &Path, size: u64) -> io::Result<Backlog> {
        let (lines, partial, start) = read_lines_ending_at(path, size, BACKLOG_LINES)?;
        Ok(Backlog {
            complete: lines.join("\n"),
            partial,
            meta: Some(json!({"historyStart":start,"hasMore":start > 0})),
        })
    }
    fn emit(&self, out: &mut Vec<String>, text: &str) {
        out.extend(
            parse_entries(text.split('\n'))
                .into_iter()
                .map(|entry| format!("data: {entry}\n\n")),
        );
    }
}
fn parse_entries<'a>(lines: impl IntoIterator<Item = &'a str>) -> Vec<Value> {
    lines
        .into_iter()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(|entry| match entry.get("type").and_then(Value::as_str) {
            Some("user" | "assistant" | "system" | "tool" | "tool_use" | "tool_result") => true,
            Some("response_item") => matches!(
                entry.pointer("/payload/type").and_then(Value::as_str),
                Some("message" | "function_call" | "function_call_output" | "custom_tool_call")
            ),
            _ => false,
        })
        .collect()
}
async fn stream(Query(params): Query<Params>) -> Response {
    let provider = match validate(&params) {
        Ok(p) => p,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    if provider == Provider::Opencode {
        return opencode_rows::stream(params.session);
    }
    sse_tailer::create_tail_stream(TranscriptSource {
        provider,
        session: params.session,
    })
}

fn js_number(value: Option<&str>) -> f64 {
    // JS Number(null) and Number(whitespace) are zero; radix literals are unsigned.
    let text = value
        .unwrap_or("")
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |n, c| {
                    c.to_digit(radix).map(|d| n * radix as f64 + d as f64)
                })
                .unwrap_or(f64::NAN);
        }
    }
    if matches!(text, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if text == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    if text
        .chars()
        .any(|c| !matches!(c, '0'..='9' | '+' | '-' | '.' | 'e' | 'E'))
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}
async fn history(Query(params): Query<Params>) -> Response {
    let provider = match validate(&params) {
        Ok(p) => p,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    let empty = || {
        json_response(
            StatusCode::OK,
            json!({"entries":[],"historyStart":0,"hasMore":false}),
        )
    };
    let before = js_number(params.before.as_deref());
    if provider == Provider::Opencode || !before.is_finite() || before <= 0.0 {
        return empty();
    }
    let source = TranscriptSource {
        provider,
        session: params.session,
    };
    let path = match source.resolve() {
        Resolve::Ready(path) => path,
        Resolve::Wait => return empty(),
        Resolve::Fail { message, .. } => return json_error(StatusCode::FORBIDDEN, &message),
    };
    let result = || -> io::Result<Value> {
        let end = before.min(fs::metadata(&path)?.len() as f64) as u64;
        let limit = js_number(params.limit.as_deref());
        // JS limit || 50 replaces both zero and NaN; slice(-cap) truncates fractions.
        let limit = if limit == 0.0 || limit.is_nan() {
            BACKLOG_LINES as f64
        } else {
            limit
        };
        let cap = limit.clamp(1.0, MAX_HISTORY_LIMIT as f64);
        let (lines, _, start) = read_lines_with_cap(&path, end, cap)?;
        // preserve_order keeps the TS response's entries/cursor/flag field order.
        Ok(
            json!({"entries":parse_entries(lines.iter().map(String::as_str)),"historyStart":start,"hasMore":start > 0}),
        )
    };
    match result() {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(_) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to read transcript history",
        ),
    }
}

fn read_lines_ending_at(
    path: &Path,
    end: u64,
    max_lines: usize,
) -> io::Result<(Vec<String>, Vec<u8>, u64)> {
    read_lines_with_cap(path, end, max_lines as f64)
}

fn read_lines_with_cap(
    path: &Path,
    end: u64,
    max_lines: f64,
) -> io::Result<(Vec<String>, Vec<u8>, u64)> {
    let mut file = File::open(path)?;
    let mut start = end;
    let mut newlines = 0;
    let mut chunks = Vec::new();
    while start > 0 && end - start < MAX_BACKLOG_READ_BYTES {
        let next = start.saturating_sub(BACKLOG_READ_CHUNK_BYTES);
        let mut bytes = vec![0; (start - next) as usize];
        file.seek(SeekFrom::Start(next))?;
        file.read_exact(&mut bytes)?;
        newlines += bytes.iter().filter(|b| **b == b'\n').count();
        chunks.push(bytes);
        start = next;
        if newlines as f64 >= max_lines {
            break;
        }
    }
    let bytes: Vec<u8> = chunks.into_iter().rev().flatten().collect();
    let body = if start > 0 {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| &bytes[i + 1..])
            .unwrap_or(&[])
    } else {
        &bytes
    };
    let (complete, partial) = split_complete_lines(body);
    let lines: Vec<&[u8]> = if complete.is_empty() {
        Vec::new()
    } else {
        complete.split(|b| *b == b'\n').collect()
    };
    let kept = &lines[lines.len().saturating_sub(max_lines as usize)..];
    let length = kept.iter().map(|line| line.len() as u64 + 1).sum::<u64>() + partial.len() as u64;
    Ok((
        kept.iter()
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect(),
        partial.to_vec(),
        end.saturating_sub(length),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn backward_reader_edges_and_raw_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript");
        for (body, end, count, expected, partial, offset) in [
            ("a\nb\nc\n", 6, 2, vec!["b", "c"], "", 2),
            ("a\nb\nc\n", 4, 2, vec!["a", "b"], "", 0),
            ("no newline", 10, 50, vec![], "no newline", 0),
            ("中\nb\ntail", 10, 1, vec!["b"], "tail", 4),
            ("", 0, 50, vec![], "", 0),
        ] {
            fs::write(&path, body).unwrap();
            let result = read_lines_ending_at(&path, end, count).unwrap();
            assert_eq!(
                result,
                (
                    expected.into_iter().map(str::to_owned).collect(),
                    partial.as_bytes().to_vec(),
                    offset
                )
            );
        }
        let mut body = vec![b'x'; BACKLOG_READ_CHUNK_BYTES as usize];
        body.extend_from_slice(b"\na\nb\n");
        fs::write(&path, &body).unwrap();
        assert_eq!(
            read_lines_ending_at(&path, body.len() as u64, 2).unwrap(),
            (
                vec!["a".into(), "b".into()],
                vec![],
                BACKLOG_READ_CHUNK_BYTES + 1
            )
        );
    }

    #[test]
    fn sparse_large_file_bounds_history_and_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large");
        let mut file = File::create(&path).unwrap();
        let size = 2_400_000_000;
        file.set_len(size).unwrap();
        file.seek(SeekFrom::Start(size - 5)).unwrap();
        file.write_all(b"\na\nb\n").unwrap();
        let result = read_lines_ending_at(&path, size, 50).unwrap();
        assert_eq!(result, (vec!["a".into(), "b".into()], vec![], size - 4));
        let result = read_lines_ending_at(&path, size - 6, 200).unwrap();
        assert!(result.0.is_empty());
        assert!(result.1.is_empty());
        assert_eq!(result.2, size - 6);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn backlog_partial_multibyte_survives_append() {
        struct Source(PathBuf);
        impl TailSource for Source {
            fn resolve(&self) -> Resolve {
                Resolve::Ready(self.0.clone())
            }
            fn read_backlog(&self, path: &Path, size: u64) -> io::Result<Backlog> {
                TranscriptSource {
                    provider: Provider::Claude,
                    session: String::new(),
                }
                .read_backlog(path, size)
            }
            fn emit(&self, out: &mut Vec<String>, text: &str) {
                TranscriptSource {
                    provider: Provider::Claude,
                    session: String::new(),
                }
                .emit(out, text)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("utf8");
        let prefix = (0..60)
            .map(|i| format!("{{\"type\":\"user\",\"n\":{i}}}\n"))
            .collect::<String>();
        let mut bytes = prefix.as_bytes().to_vec();
        bytes.extend_from_slice(b"{\"type\":\"assistant\",\"text\":\"");
        bytes.push(0xe4);
        fs::write(&path, &bytes).unwrap();
        let (lines, partial, start) = read_lines_ending_at(&path, bytes.len() as u64, 50).unwrap();
        assert_eq!(lines.len(), 50);
        assert_eq!(
            start,
            prefix
                .lines()
                .take(10)
                .map(|s| s.len() as u64 + 1)
                .sum::<u64>()
        );
        assert_eq!(partial.last(), Some(&0xe4));
        let mut stream = sse_tailer::TailStream::new(Source(path.clone())).unwrap();
        assert_eq!(stream.next().await.unwrap(), ": connected\n\n");
        for _ in 0..50 {
            stream.next().await.unwrap();
        }
        assert_eq!(
            stream.next().await.unwrap(),
            format!("event: backlog-done\ndata: {{\"historyStart\":{start},\"hasMore\":true}}\n\n")
        );
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0xb8, 0xad, b'"', b'}', b'\n'])
            .unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(4), stream.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame, "data: {\"type\":\"assistant\",\"text\":\"中\"}\n\n");
    }

    #[test]
    fn number_coercion_and_display_filter() {
        for (text, expected) in [
            ("", 0.0),
            ("  ", 0.0),
            ("0x20", 32.0),
            ("0b11", 3.0),
            ("0o10", 8.0),
            ("1e2", 100.0),
        ] {
            assert_eq!(js_number(Some(text)), expected);
        }
        for text in ["garbage", "inf", "+0x20"] {
            assert!(js_number(Some(text)).is_nan());
        }
        assert_eq!(
            parse_entries([
                "null",
                "invalid",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\"}}",
                "{\"type\":\"assistant\"}"
            ]),
            vec![json!({"type":"assistant"})]
        );
    }
}
