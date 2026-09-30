use super::{parse_args, positionals};
use crate::{config, find_session, nudge_toggle};
use find_session::Provider;
use nudge_toggle::{NudgeScope, NudgeState, ToggleAction};
use std::path::Path;

const NUDGE_USAGE: &str =
    "usage: cockpit nudge <on|off|toggle|clear|status> [--scope session|project|user]";

pub fn run(sub: &str, rest: &[String], cwd: &Path) -> Result<(), String> {
    match sub {
        "config" => run_config(rest),
        "nudge" => run_nudge(rest, cwd),
        "find-session" => run_find_session(rest, cwd),
        _ => unreachable!("settings dispatch only accepts its own subcommands"),
    }
}

fn run_config(rest: &[String]) -> Result<(), String> {
    let args = parse_args(rest)?;
    if let Some(language) = args.value("log-language").filter(|value| !value.is_empty()) {
        config::set_language(language);
        println!("cockpit: log_language = {language}");
        return Ok(());
    }
    let positional = positionals(rest);
    if positional.first() == Some(&"get-language") {
        println!("{}", config::get_language());
        return Ok(());
    }
    if let Some(answer) = args.value("answer-here").filter(|value| !value.is_empty()) {
        if !matches!(answer, "on" | "off") {
            return Err("cockpit config: --answer-here takes on | off".to_owned());
        }
        config::set_answer_here(answer == "on");
        println!("cockpit: answer_here = {answer}");
        return Ok(());
    }
    if positional.first() == Some(&"get-answer-here") {
        println!(
            "{}",
            if config::get_answer_here() {
                "on"
            } else {
                "off"
            }
        );
        return Ok(());
    }
    Err("usage: cockpit config --log-language <lang> | get-language | --answer-here on|off | get-answer-here".to_owned())
}

fn parse_nudge(rest: &[String]) -> Result<(String, NudgeScope), String> {
    let mut action = "status".to_owned();
    let mut scope = NudgeScope::Session;
    let mut tokens = rest.iter();
    while let Some(token) = tokens.next() {
        if token == "--scope" {
            let value = tokens.next().map(String::as_str).unwrap_or("");
            scope = match value {
                "session" => NudgeScope::Session,
                "project" => NudgeScope::Project,
                "user" => NudgeScope::User,
                _ => {
                    return Err(format!(
                        "cockpit nudge: invalid scope \"{value}\"\n{NUDGE_USAGE}"
                    ));
                }
            };
        } else {
            action = token.to_lowercase();
        }
    }
    if !matches!(
        action.as_str(),
        "on" | "off" | "toggle" | "clear" | "status"
    ) {
        return Err(format!(
            "cockpit nudge: unknown action \"{action}\"\n{NUDGE_USAGE}"
        ));
    }
    Ok((action, scope))
}

fn fmt_scope(state: Option<NudgeState>) -> &'static str {
    match state {
        Some(NudgeState::On) => "ON",
        Some(NudgeState::Off) => "OFF",
        None => "default",
    }
}

fn run_nudge(rest: &[String], cwd: &Path) -> Result<(), String> {
    let (action, scope) = parse_nudge(rest)?;
    let now = crate::registry::now_ms();
    let session_id = find_session::find_session(Provider::Claude, cwd);
    if action != "status" && matches!(scope, NudgeScope::Session) && session_id.is_none() {
        return Err("cockpit nudge: could not resolve the current session id (no CLAUDE_CODE_SESSION_ID and no transcript). Run inside a Claude session, or target --scope project|user.".to_owned());
    }
    let scope_name = match scope {
        NudgeScope::Session => "session",
        NudgeScope::Project => "project",
        NudgeScope::User => "user",
    };
    let toggle = match action.as_str() {
        "on" => Some(ToggleAction::On),
        "off" => Some(ToggleAction::Off),
        "toggle" => Some(ToggleAction::Toggle),
        "clear" => Some(ToggleAction::Clear),
        _ => None,
    };
    if let Some(toggle) = toggle {
        nudge_toggle::set_scope(scope, toggle, session_id.as_deref().unwrap_or(""), cwd, now);
    }
    let (session, project, user) = nudge_toggle::read_scopes(session_id.as_deref(), cwd, now);
    let enabled = nudge_toggle::resolve_nudge_enabled(session, project, user);
    let verb = if action == "status" {
        String::new()
    } else {
        let state = match scope_name {
            "session" => session,
            "project" => project,
            _ => user,
        };
        format!(" — {scope_name} set to {}", fmt_scope(state))
    };
    println!(
        "scribe nudges: {} (effective){verb}",
        if enabled { "ON" } else { "OFF" }
    );
    println!(
        "  session: {} · project: {} · user: {}",
        fmt_scope(session),
        fmt_scope(project),
        fmt_scope(user)
    );
    Ok(())
}

fn run_find_session(rest: &[String], cwd: &Path) -> Result<(), String> {
    let mut provider = Provider::Claude;
    let mut project = None;
    let mut tokens = rest.iter();
    while let Some(token) = tokens.next() {
        if token == "--provider" {
            provider = tokens
                .next()
                .map(String::as_str)
                .unwrap_or("undefined")
                .parse()?;
        } else if project.is_none() {
            project = Some(token);
        }
    }
    let project = project
        .filter(|value| !value.is_empty())
        .map(Path::new)
        .unwrap_or(cwd);
    match find_session::find_session(provider, project) {
        Some(id) => {
            println!("{id}");
            Ok(())
        }
        None => Err(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn nudge_defaults_lowercases_and_last_action_wins() {
        let (action, scope) = parse_nudge(&[]).unwrap();
        assert_eq!(action, "status");
        assert!(matches!(scope, NudgeScope::Session));
        let (action, scope) = parse_nudge(&args(&["wrong", "ON", "--scope", "user"])).unwrap();
        assert_eq!(action, "on");
        assert!(matches!(scope, NudgeScope::User));
    }

    #[test]
    fn nudge_rejects_invalid_scope_before_unknown_action() {
        for (values, invalid) in [
            (vec!["wrong", "--scope", "global"], "global"),
            (vec!["--scope"], ""),
            (vec!["--scope", "USER"], "USER"),
        ] {
            let error = parse_nudge(&args(&values)).err().unwrap();
            assert_eq!(
                error,
                format!("cockpit nudge: invalid scope \"{invalid}\"\n{NUDGE_USAGE}")
            );
        }
        assert_eq!(
            parse_nudge(&args(&["WHAT"])).err().unwrap(),
            format!("cockpit nudge: unknown action \"what\"\n{NUDGE_USAGE}")
        );
    }
}
