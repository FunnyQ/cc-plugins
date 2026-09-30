use super::{Env, parse_input, reminder};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::PermissionsExt,
};

const WHEN: &str = "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: ";
const POLICY: &str =
    " One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine.";
const FORK_NAME: &str = " Use \"fork\" exactly (omitting it starts a fresh, context-less agent that cannot see the work).";
const SILENCE: &str = " Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output.";

pub fn build_guidance(session_id: Option<&str>, is_codex: bool) -> String {
    let session_id = session_id.filter(|id| !id.is_empty());
    let command = format!(
        "/cockpit scribe --session {}",
        session_id.unwrap_or("<parent-session-id>")
    );
    let spawn = if is_codex {
        format!(
            "a background sub-agent with fork_context: true and no agent_type, prompt: \"You are running under Codex. Run {command} --provider codex\""
        )
    } else {
        format!("Agent(subagent_type: \"fork\", prompt: \"Run {command}\")")
    };
    let suffix = if session_id.is_some() {
        "."
    } else {
        ", substituting this main session's id, which you resolve first."
    };
    let fork = if is_codex { "" } else { FORK_NAME };
    format!("{WHEN}{spawn}{suffix}{POLICY}{fork}{SILENCE}")
}

fn claude_on_path(env: &Env) -> bool {
    env.get("PATH").is_some_and(|path| {
        std::env::split_paths(path).any(|dir| {
            fs::metadata(dir.join("claude")).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    })
}

pub fn run() -> io::Result<()> {
    let input = parse_input(io::stdin().lock()).unwrap_or_default();
    let env: Env = std::env::vars().collect();
    let now = crate::registry::now_ms();
    if reminder::should_skip(&env, &input, now)
        || (reminder::is_claude_code(&env, &input) && claude_on_path(&env))
    {
        return Ok(());
    }
    let id = reminder::resolve_parent_session(&env, &input);
    writeln!(
        io::stdout().lock(),
        "{}",
        build_guidance(id.as_deref(), reminder::is_codex(&env))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_four_guidance_strings_are_exact() {
        assert_eq!(
            build_guidance(Some("parent-id"), false),
            "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: Agent(subagent_type: \"fork\", prompt: \"Run /cockpit scribe --session parent-id\"). One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Use \"fork\" exactly (omitting it starts a fresh, context-less agent that cannot see the work). Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output."
        );
        assert_eq!(
            build_guidance(None, false),
            "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: Agent(subagent_type: \"fork\", prompt: \"Run /cockpit scribe --session <parent-session-id>\"), substituting this main session's id, which you resolve first. One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Use \"fork\" exactly (omitting it starts a fresh, context-less agent that cannot see the work). Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output."
        );
        assert_eq!(
            build_guidance(Some("parent-id"), true),
            "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: a background sub-agent with fork_context: true and no agent_type, prompt: \"You are running under Codex. Run /cockpit scribe --session parent-id --provider codex\". One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output."
        );
        assert_eq!(
            build_guidance(None, true),
            "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: a background sub-agent with fork_context: true and no agent_type, prompt: \"You are running under Codex. Run /cockpit scribe --session <parent-session-id> --provider codex\", substituting this main session's id, which you resolve first. One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output."
        );
    }
    #[test]
    fn path_requires_an_executable_regular_file() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let env = Env::from([("PATH".into(), dir.path().to_string_lossy().into_owned())]);
        let path = dir.path().join("claude");
        assert!(!claude_on_path(&env));
        fs::create_dir(&path).unwrap();
        assert!(!claude_on_path(&env));
        fs::remove_dir(&path).unwrap();
        fs::write(&path, "#!/bin/sh\nexit 97\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!claude_on_path(&env));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(claude_on_path(&env));
    }
}
