use super::Env;
use serde_json::Value;
use std::{fs, path::PathBuf};

// Relay owns the writer of this shared path and JSON shape; preserve its fields and order.
#[derive(Clone, Debug)]
pub struct Marker {
    value: Value,
}

impl Marker {
    fn parse(value: Value) -> Option<Self> {
        value.get("cwd")?.as_str()?;
        value.get("expiresAt")?.as_f64()?;
        value.get("armUntil")?.as_f64()?;
        value.get("sessionIds")?.as_array()?;
        Some(Self { value })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Classification {
    pub delegated: bool,
    pub bind_to: Option<String>,
    pub expired: Vec<String>,
}

pub fn classify_markers(
    files: &[(String, Marker)],
    cwd: Option<&str>,
    session_id: Option<&str>,
    now_ms: i64,
) -> Classification {
    let mut verdict = Classification {
        delegated: false,
        bind_to: None,
        expired: Vec::new(),
    };
    let mut live = Vec::new();
    for (name, marker) in files {
        if marker.value["expiresAt"]
            .as_f64()
            .is_some_and(|expiry| expiry <= now_ms as f64)
        {
            verdict.expired.push(name.clone());
        } else {
            live.push((name, marker));
        }
    }
    let session_id = session_id.filter(|id| !id.is_empty());
    if let Some(id) = session_id
        && live.iter().any(|(_, marker)| {
            marker.value["sessionIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
        })
    {
        verdict.delegated = true;
        return verdict;
    }
    let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
        return verdict;
    };
    let armed: Vec<_> = live
        .into_iter()
        .filter(|(_, marker)| {
            marker.value["cwd"].as_str() == Some(cwd)
                && marker.value["armUntil"]
                    .as_f64()
                    .is_some_and(|until| now_ms as f64 <= until)
        })
        .collect();
    let Some(first) = armed.first() else {
        return verdict;
    };
    let target = armed
        .iter()
        .find(|(_, marker)| {
            marker.value["sessionIds"]
                .as_array()
                .is_some_and(Vec::is_empty)
        })
        .unwrap_or(first);
    verdict.delegated = true;
    verdict.bind_to = session_id.map(|_| target.0.clone());
    verdict
}

pub fn is_delegated_session(
    env: &Env,
    cwd: Option<&str>,
    session_id: Option<&str>,
    now_ms: i64,
) -> bool {
    let dir = match env
        .get("Q_DELEGATION_HOME")
        .filter(|value| !value.is_empty())
    {
        Some(dir) => PathBuf::from(dir),
        None => match env.get("HOME") {
            Some(home) => PathBuf::from(home).join(".local/share/q-lab/delegation"),
            None => return false,
        },
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return false;
    };
    let mut names: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    names.sort();
    let mut files = Vec::new();
    for name in names {
        let Some(name) = name.to_str().filter(|name| name.ends_with(".json")) else {
            continue;
        };
        let marker = fs::read(dir.join(name))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .and_then(Marker::parse);
        if let Some(marker) = marker {
            files.push((name.to_owned(), marker));
        }
    }
    let verdict = classify_markers(&files, cwd, session_id, now_ms);
    for name in verdict.expired {
        let _ = fs::remove_file(dir.join(name));
    }
    if let (Some(name), Some(id)) = (verdict.bind_to, session_id)
        && let Some((_, marker)) = files.iter_mut().find(|(file, _)| *file == name)
        && let Some(ids) = marker.value["sessionIds"].as_array_mut()
    {
        ids.push(Value::String(id.to_owned()));
        if let Ok(json) = serde_json::to_string(&marker.value) {
            let _ = fs::write(dir.join(name), json);
        }
    }
    verdict.delegated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker(name: &str, cwd: &str, arm: i64, expiry: i64, ids: &[&str]) -> (String, Marker) {
        (name.into(), Marker::parse(json!({"cwd": cwd, "backend": "codex", "startedAt": 0, "armUntil": arm, "expiresAt": expiry, "sessionIds": ids})).unwrap())
    }

    #[test]
    fn expired_markers_never_match_and_are_pruned_at_boundary() {
        let result = classify_markers(
            &[marker("expired", "/repo", 100, 10, &["id"])],
            Some("/repo"),
            Some("id"),
            10,
        );
        assert_eq!(
            result,
            Classification {
                delegated: false,
                bind_to: None,
                expired: vec!["expired".into()]
            }
        );
    }
    #[test]
    fn bound_session_wins_without_cwd_after_arm_window() {
        let result = classify_markers(
            &[marker("live", "/repo", 1, 100, &["id"])],
            None,
            Some("id"),
            10,
        );
        assert!(result.delegated);
        assert_eq!(result.bind_to, None);
    }
    #[test]
    fn missing_cwd_and_unarmed_or_other_cwd_do_not_match() {
        let files = [marker("live", "/repo", 10, 100, &[])];
        for cwd in [None, Some(""), Some("/other")] {
            assert!(!classify_markers(&files, cwd, None, 10).delegated);
        }
        assert!(!classify_markers(&files, Some("/repo"), None, 11).delegated);
    }
    #[test]
    fn armed_boundary_matches_without_binding_when_id_absent() {
        let files = [marker("live", "/repo", 10, 100, &[])];
        for id in [None, Some("")] {
            let result = classify_markers(&files, Some("/repo"), id, 10);
            assert!(result.delegated);
            assert_eq!(result.bind_to, None);
        }
    }
    #[test]
    fn prefers_first_unclaimed_otherwise_first_armed() {
        let mut files = vec![
            marker("claimed", "/repo", 10, 100, &["old"]),
            marker("free", "/repo", 10, 100, &[]),
            marker("next", "/repo", 10, 100, &[]),
        ];
        assert_eq!(
            classify_markers(&files, Some("/repo"), Some("new"), 10)
                .bind_to
                .as_deref(),
            Some("free")
        );
        files.truncate(1);
        assert_eq!(
            classify_markers(&files, Some("/repo"), Some("new"), 10)
                .bind_to
                .as_deref(),
            Some("claimed")
        );
    }
    #[test]
    fn marker_validation_matches_ts_field_checks() {
        for value in [
            json!({}),
            json!({"cwd": 1, "expiresAt": 10, "armUntil": 5, "sessionIds": []}),
            json!({"cwd": "/repo", "expiresAt": "10", "armUntil": 5, "sessionIds": []}),
            json!({"cwd": "/repo", "expiresAt": 10, "armUntil": null, "sessionIds": []}),
            json!({"cwd": "/repo", "expiresAt": 10, "armUntil": 5, "sessionIds": {}}),
        ] {
            assert!(Marker::parse(value).is_none());
        }
        assert!(
            Marker::parse(
                json!({"cwd": "/repo", "expiresAt": 10.5, "armUntil": 5.5, "sessionIds": [null, 1]})
            )
            .is_some()
        );
    }
    #[test]
    fn io_prunes_skips_corruption_and_preserves_binding_bytes() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let env = Env::from([(
            "Q_DELEGATION_HOME".into(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        let raw = r#"{"cwd":"/repo","backend":"codex","startedAt":0,"armUntil":10,"expiresAt":100,"sessionIds":[],"extra":"keep"}"#;
        fs::write(dir.path().join("live.json"), raw).unwrap();
        fs::write(
            dir.path().join("expired.json"),
            raw.replace("\"expiresAt\":100", "\"expiresAt\":10"),
        )
        .unwrap();
        fs::write(dir.path().join("broken.json"), "{broken").unwrap();
        fs::write(dir.path().join("invalid.json"), "{}").unwrap();
        fs::write(dir.path().join("ignored.txt"), raw).unwrap();
        fs::create_dir(dir.path().join("unreadable.json")).unwrap();
        assert!(is_delegated_session(&env, Some("/repo"), Some("id"), 10));
        assert!(!dir.path().join("expired.json").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("live.json")).unwrap(),
            raw.replace("\"sessionIds\":[]", "\"sessionIds\":[\"id\"]")
        );
        assert!(is_delegated_session(&env, None, Some("id"), 11));
        assert!(!is_delegated_session(
            &env,
            Some("/other"),
            Some("other"),
            11
        ));
        let missing = Env::from([(
            "Q_DELEGATION_HOME".into(),
            dir.path().join("missing").to_string_lossy().into_owned(),
        )]);
        assert!(!is_delegated_session(
            &missing,
            Some("/repo"),
            Some("id"),
            10
        ));
    }
}
