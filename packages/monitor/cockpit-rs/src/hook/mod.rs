pub mod delegation_marker;
pub mod reminder;
mod session_start;
mod stop;

use serde::Deserialize;
use std::{collections::HashMap, io::Read, process::ExitCode};

pub type Env = HashMap<String, String>;

#[derive(Deserialize, Default)]
pub struct HookInput {
    pub agent_id: Option<String>,
    pub hook_event_name: Option<String>,
    pub stop_hook_active: Option<bool>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub provider: Option<String>,
}

pub fn parse_input(mut reader: impl Read) -> Option<HookInput> {
    let mut text = String::new();
    reader.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn run(session_start: bool) -> ExitCode {
    if session_start {
        let _ = self::session_start::run();
    } else {
        let _ = stop::run();
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsing_preserves_failure_for_each_caller() {
        for text in ["", "{broken", "null"] {
            assert!(parse_input(text.as_bytes()).is_none());
        }
        assert!(parse_input(b"{}".as_slice()).is_some());
    }
}
