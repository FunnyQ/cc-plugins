use super::{Env, HookInput, delegation_marker};
use crate::find_session::{Provider, find_session};
use std::path::PathBuf;

pub fn is_codex(env: &Env) -> bool {
    env.get("PLUGIN_ROOT")
        .is_some_and(|value| !value.is_empty())
}

pub fn should_skip(env: &Env, input: &HookInput, now_ms: i64) -> bool {
    if env.get("RELAY_DELEGATED").is_some_and(|value| value == "1")
        || env
            .get("CLAUDE_CODE_ENTRYPOINT")
            .is_some_and(|value| value.starts_with("sdk"))
        || (input.hook_event_name.as_deref() == Some("Stop")
            && input.stop_hook_active == Some(true))
        || input
            .agent_id
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    is_codex(env)
        && delegation_marker::is_delegated_session(
            env,
            input.cwd.as_deref(),
            input.session_id.as_deref(),
            now_ms,
        )
}

pub fn is_claude_code(env: &Env, input: &HookInput) -> bool {
    !is_codex(env) && input.provider.as_deref() != Some("opencode")
}

pub fn resolve_parent_session(env: &Env, input: &HookInput) -> Option<String> {
    let fallback = input.session_id.clone().filter(|id| !id.is_empty());
    if input.provider.as_deref() == Some("opencode") {
        return fallback;
    }
    let provider = if is_codex(env) {
        Provider::Codex
    } else {
        Provider::Claude
    };
    let cwd = input
        .cwd
        .as_ref()
        .filter(|cwd| !cwd.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    cwd.and_then(|cwd| find_session(provider, &cwd))
        .or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_and_payload_suppressions() {
        let input = HookInput::default();
        for (key, value) in [
            ("RELAY_DELEGATED", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"),
        ] {
            assert!(should_skip(
                &Env::from([(key.into(), value.into())]),
                &input,
                0
            ));
        }
        assert!(should_skip(
            &Env::new(),
            &HookInput {
                agent_id: Some("child".into()),
                ..HookInput::default()
            },
            0
        ));
        assert!(should_skip(
            &Env::new(),
            &HookInput {
                hook_event_name: Some("Stop".into()),
                stop_hook_active: Some(true),
                ..HookInput::default()
            },
            0
        ));
        assert!(!should_skip(&Env::new(), &input, 0));
        assert!(is_claude_code(&Env::new(), &input));
        assert!(is_claude_code(
            &Env::from([("PLUGIN_ROOT".into(), "".into())]),
            &input
        ));
        let opencode = HookInput {
            provider: Some("opencode".into()),
            session_id: Some("ses_live".into()),
            ..HookInput::default()
        };
        assert!(!is_claude_code(&Env::new(), &opencode));
        assert_eq!(
            resolve_parent_session(&Env::new(), &opencode),
            Some("ses_live".into())
        );
        assert_eq!(
            resolve_parent_session(
                &Env::new(),
                &HookInput {
                    session_id: Some("".into()),
                    ..opencode
                }
            ),
            None
        );
    }
}
