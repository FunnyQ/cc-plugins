use crate::paths::config_path;
use serde_json::{Map, Value};
use std::fs;

pub type CockpitConfig = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NudgeState {
    On,
    Off,
}

impl NudgeState {
    fn read(value: Option<&Value>) -> Option<Self> {
        match value.and_then(Value::as_str) {
            Some("on") => Some(Self::On),
            Some("off") => Some(Self::Off),
            _ => None,
        }
    }
    fn value(self) -> Value {
        Value::String(
            match self {
                Self::On => "on",
                Self::Off => "off",
            }
            .to_owned(),
        )
    }
}

pub fn read_config() -> CockpitConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_config(cfg: CockpitConfig) {
    let path = config_path();
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(&cfg)? + "\n")?;
        Ok(())
    })();
    // TS setters throw on write failures; never silently report a successful update.
    if let Err(error) = result {
        panic!("cockpit: cannot write config: {error}");
    }
}

pub fn get_language() -> String {
    read_config()
        .get("log_language")
        .and_then(Value::as_str)
        .map(|s| s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|s| !s.is_empty())
        .unwrap_or("English")
        .to_owned()
}
pub fn set_language(lang: &str) {
    let mut cfg = read_config();
    cfg.insert("log_language".to_owned(), Value::String(lang.to_owned()));
    write_config(cfg);
}
pub fn get_answer_here() -> bool {
    read_config().get("answer_here") == Some(&Value::Bool(true))
}
pub fn set_answer_here(on: bool) {
    let mut cfg = read_config();
    cfg.insert("answer_here".to_owned(), Value::Bool(on));
    write_config(cfg);
}

fn spread(value: Option<&Value>) -> CockpitConfig {
    // JavaScript object spread retains indexed properties of malformed arrays and strings.
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Some(Value::String(s)) => s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        _ => Map::new(),
    }
}
pub fn get_user_nudge() -> Option<NudgeState> {
    NudgeState::read(read_config().get("nudges").and_then(|v| v.get("user")))
}
pub fn set_user_nudge(s: Option<NudgeState>) {
    let mut cfg = read_config();
    let mut nudges = spread(cfg.get("nudges"));
    match s {
        Some(s) => {
            nudges.insert("user".to_owned(), s.value());
        }
        None => {
            nudges.shift_remove("user");
        }
    }
    cfg.insert("nudges".to_owned(), Value::Object(nudges));
    write_config(cfg);
}
pub fn get_project_nudge(project: &str) -> Option<NudgeState> {
    NudgeState::read(
        read_config()
            .get("nudges")
            .and_then(|v| v.get("projects"))
            .and_then(|v| v.get(project)),
    )
}
pub fn set_project_nudge(project: &str, s: Option<NudgeState>) {
    let mut cfg = read_config();
    let mut nudges = spread(cfg.get("nudges"));
    let mut projects = spread(nudges.get("projects"));
    match s {
        Some(s) => {
            projects.insert(project.to_owned(), s.value());
        }
        None => {
            projects.shift_remove(project);
        }
    }
    if projects.is_empty() {
        nudges.shift_remove("projects");
    } else {
        nudges.insert("projects".to_owned(), Value::Object(projects));
    }
    cfg.insert("nudges".to_owned(), Value::Object(nudges));
    write_config(cfg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use serde_json::json;
    use std::fs;

    fn write(raw: &str) {
        let path = crate::paths::config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn missing_corrupt_and_non_object_are_defaults() {
        let _env = TestEnv::new();
        assert!(read_config().is_empty());
        assert_eq!(get_language(), "English");
        assert!(!get_answer_here());
        for raw in ["{ nope", "[]", "null", "123", r#""text""#] {
            write(raw);
            assert!(read_config().is_empty());
            assert_eq!(get_language(), "English");
        }
    }

    #[test]
    fn language_round_trip_and_blank_defaults() {
        let _env = TestEnv::new();
        for raw in [r#"{"other_key":"value"}"#, r#"{"log_language":" \n\t"}"#] {
            write(raw);
            assert_eq!(get_language(), "English");
        }
        set_language("  French  ");
        assert_eq!(get_language(), "French");
        assert_eq!(read_config()["log_language"], "  French  ");
        set_language("Japanese");
        assert_eq!(get_language(), "Japanese");
        assert!(crate::paths::config_path().exists());
    }

    #[test]
    fn wrong_language_type_keeps_answer_and_key_order() {
        let _env = TestEnv::new();
        write(
            r#"{"log_language":123,"answer_here":true,"unknown":{"enabled":true},"list":["a","b"]}"#,
        );
        assert_eq!(get_language(), "English");
        assert!(get_answer_here());
        set_language("zh-TW");
        assert_eq!(
            fs::read_to_string(crate::paths::config_path()).unwrap(),
            "{\n  \"log_language\": \"zh-TW\",\n  \"answer_here\": true,\n  \"unknown\": {\n    \"enabled\": true\n  },\n  \"list\": [\n    \"a\",\n    \"b\"\n  ]\n}\n"
        );
    }

    #[test]
    fn answer_here_is_literal_true_and_preserves_other_keys() {
        let _env = TestEnv::new();
        for value in [json!("yes"), json!(1), json!(null), json!(false)] {
            write(&json!({"answer_here": value}).to_string());
            assert!(!get_answer_here());
        }
        write(r#"{"one":1,"nested":{"enabled":true},"list":["a","b"]}"#);
        set_language("French");
        set_answer_here(true);
        assert!(get_answer_here());
        assert_eq!(read_config(), json!({"one":1,"nested":{"enabled":true},"list":["a","b"],"log_language":"French","answer_here":true}).as_object().unwrap().clone());
        assert_eq!(
            read_config().keys().map(String::as_str).collect::<Vec<_>>(),
            ["one", "nested", "list", "log_language", "answer_here"]
        );
        set_answer_here(false);
        assert!(!get_answer_here());
    }

    #[test]
    fn nudges_are_lenient_preserve_unknown_keys_and_clear_empty_projects() {
        let _env = TestEnv::new();
        write(
            r#"{"nudges":{"first":1,"user":"invalid","projects":{"/a":42,"/b":"off"},"last":2},"answer_here":true}"#,
        );
        assert_eq!(get_user_nudge(), None);
        assert_eq!(get_project_nudge("/a"), None);
        assert_eq!(get_project_nudge("/b"), Some(NudgeState::Off));
        set_user_nudge(Some(NudgeState::On));
        assert_eq!(get_user_nudge(), Some(NudgeState::On));
        set_project_nudge("/a", Some(NudgeState::On));
        assert_eq!(get_project_nudge("/a"), Some(NudgeState::On));
        set_project_nudge("/a", None);
        set_project_nudge("/b", None);
        assert!(read_config()["nudges"].get("projects").is_none());
        set_user_nudge(None);
        assert_eq!(read_config()["nudges"], json!({"first":1,"last":2}));
        assert_eq!(
            read_config()["nudges"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["first", "last"]
        );
        assert!(get_answer_here());
        write(r#"{"nudges":{"user":true,"projects":null}}"#);
        assert_eq!(get_user_nudge(), None);
        assert_eq!(get_project_nudge("/a"), None);
        set_project_nudge("/a", Some(NudgeState::Off));
        assert_eq!(get_project_nudge("/a"), Some(NudgeState::Off));
    }

    #[test]
    fn malformed_nudge_containers_follow_object_spread() {
        let _env = TestEnv::new();
        write(r#"{"nudges":["on","off"]}"#);
        set_user_nudge(Some(NudgeState::Off));
        assert_eq!(
            read_config()["nudges"],
            json!({"0":"on","1":"off","user":"off"})
        );
        write(r#"{"nudges":{"projects":"ab","keep":true}}"#);
        set_project_nudge("/a", Some(NudgeState::On));
        assert_eq!(
            read_config()["nudges"]["projects"],
            json!({"0":"a","1":"b","/a":"on"})
        );
    }
}
