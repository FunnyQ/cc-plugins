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
}
