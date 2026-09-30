use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Only sessionId, cwd and startedAt are validated by the TS; the rest pass through untyped.
pub struct ClaudeSessionFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<Value>,
    pub session_id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Value>,
    pub started_at: serde_json::Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<Value>,
    // Every other key passes through whole, as readSessionFiles pushes the parsed object.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

pub fn read_session_files() -> Vec<ClaudeSessionFile> {
    let Ok(entries) = std::fs::read_dir(super::paths::sessions_dir()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        // A malformed or partially written file is skipped, as readSessionFiles does.
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Ok(file) = serde_json::from_str::<ClaudeSessionFile>(&text) {
            out.push(file);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn reads_valid_files_and_skips_the_rest() {
        let env = TestEnv::new();
        let dir = env.dir.path().join(".claude/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("a.json"),
            r#"{"pid":1,"sessionId":"s","cwd":"/r","status":"busy","startedAt":5,"kind":"interactive"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("b.json"), "{not json").unwrap();
        std::fs::write(
            dir.join("c.json"),
            r#"{"sessionId":"s","cwd":"/r","startedAt":"5"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("d.txt"),
            r#"{"sessionId":"s","cwd":"/r","startedAt":5}"#,
        )
        .unwrap();
        let files = read_session_files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].session_id, "s");
        assert_eq!(files[0].kind, Some(Value::from("interactive")));
    }

    fn read_one(text: &str) -> Vec<ClaudeSessionFile> {
        let env = TestEnv::new();
        let dir = env.dir.path().join(".claude/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.json"), text).unwrap();
        read_session_files()
    }

    #[test]
    fn skips_each_invalid_shape() {
        for text in [
            r#"{"cwd":"/r","startedAt":5}"#,
            r#"{"sessionId":1,"cwd":"/r","startedAt":5}"#,
            r#"{"sessionId":"s","startedAt":5}"#,
            r#"{"sessionId":"s","cwd":null,"startedAt":5}"#,
            r#"{"sessionId":"s","cwd":"/r"}"#,
            r#"{"sessionId":"s","cwd":"/r","startedAt":"5"}"#,
            r#"{"sessionId":"s","cwd":"/r","startedAt":5"#,
            "null",
        ] {
            assert!(read_one(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn passes_unknown_keys_through() {
        let src = serde_json::json!({
            "sessionId": "s", "cwd": "/r", "startedAt": 5, "pid": 7,
            "name": "n", "peerFeatures": {"a": [1, {"b": true}]}
        });
        let files = read_one(&src.to_string());
        assert_eq!(files.len(), 1);
        assert_eq!(serde_json::to_value(&files[0]).unwrap(), src);
    }
}
