pub mod broker_client;
pub mod restart;
pub mod settings;
pub mod trail;
use crate::{
    find_session::Provider,
    registry::{self, RegistryEntry},
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::ExitCode,
};
pub const USAGE: &str = r#"usage: cockpit <log|scribe|prep|config|wait|send|restart|nudge> [args]
  cockpit log    --session <id> --decision D --reason R [--tradeoff T]
                 [--facet "LABEL: text"]... [--file p]... [--option o]...
                 [--diagram MERMAID] [--needs-call]
  cockpit scribe --type <kind> --text <body> [--title <headline>]
                 [--file <path>]... [--diagram MERMAID] [--session <id>]
  cockpit scribe --recent [N] | --prep [--provider <p>]
  cockpit prep   [--provider <p>]
  cockpit config --log-language <lang> | get-language
                 | --answer-here on|off | get-answer-here
  cockpit wait   <sessionId>
  cockpit send   <sessionId> <answer>
  cockpit restart [--port N] [--no-open]
  cockpit nudge  <on|off|toggle|clear|status> [--scope session|project|user]"#;
// Subcommands that exist only in the Rust binary keep clap's own help and errors.
const RUST_ONLY: [&str; 4] = ["server", "channel", "hook", "atlas"];
const KNOWN: [&str; 13] = [
    "log",
    "scribe",
    "prep",
    "config",
    "wait",
    "send",
    "restart",
    "nudge",
    "find-session",
    "server",
    "channel",
    "hook",
    "atlas",
];
/// Runs before clap so `--help` and an unknown subcommand match `cockpit.ts main`.
pub fn preflight(argv: &[String]) -> Option<ExitCode> {
    let sub = argv.first().map(String::as_str).unwrap_or("");
    if matches!(sub, "--version" | "-V") {
        return None;
    }
    let rest = argv.get(1..).unwrap_or_default();
    if !RUST_ONLY.contains(&sub)
        && (sub == "--help" || rest.iter().any(|s| s == "--help" || s == "-h"))
    {
        println!("{USAGE}");
        return Some(ExitCode::SUCCESS);
    }
    if !KNOWN.contains(&sub) {
        eprintln!(
            "cockpit: unknown subcommand \"{sub}\"\n{}",
            USAGE.lines().next().unwrap_or_default()
        );
        return Some(ExitCode::FAILURE);
    }
    None
}
pub fn run(sub: &str, rest: &[String]) -> ExitCode {
    let result = std::env::current_dir()
        .map_err(|e| format!("cockpit: {e}"))
        .and_then(|cwd| match sub {
            "config" | "nudge" | "find-session" => settings::run(sub, rest, &cwd),
            _ => parse_args(rest).and_then(|a| trail::run(sub, &a, &cwd)),
        });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("{e}");
            }
            ExitCode::FAILURE
        }
    }
}
#[derive(Default, Debug)]
pub struct Args {
    pub values: HashMap<String, String>,
    pub repeated: HashMap<String, Vec<String>>,
    pub booleans: HashSet<String>,
    pub recent: Option<usize>,
}
impl Args {
    pub fn value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
    pub fn list(&self, key: &str) -> Vec<String> {
        self.repeated.get(key).cloned().unwrap_or_default()
    }
    pub fn flag(&self, key: &str) -> bool {
        self.booleans.contains(key)
    }
}
pub fn parse_args(rest: &[String]) -> Result<Args, String> {
    let mut args = Args::default();
    let mut i = 0;
    while i < rest.len() {
        let tok = &rest[i];
        i += 1;
        let Some(name) = tok.strip_prefix("--") else {
            continue;
        };
        match name {
            "needs-call" | "prep" => {
                args.booleans.insert(name.into());
            }
            "recent" => {
                args.booleans.insert(name.into());
                if let Some(next) = rest
                    .get(i)
                    .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                {
                    args.recent = Some(next.parse().unwrap_or(usize::MAX));
                    i += 1;
                }
            }
            "file" | "option" | "facet" => {
                if let Some(next) = rest.get(i) {
                    args.repeated
                        .entry(name.into())
                        .or_default()
                        .push(next.clone());
                }
                i += 1;
            }
            "provider" | "session" | "log-language" | "answer-here" | "decision" | "reason"
            | "tradeoff" | "call" | "type" | "text" | "title" | "diagram" => {
                if let Some(next) = rest.get(i) {
                    args.values.insert(name.into(), next.clone());
                }
                i += 1;
            }
            _ => return Err(format!("cockpit: unknown flag \"{tok}\"\n{USAGE}")),
        }
    }
    Ok(args)
}
pub fn positionals(rest: &[String]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        if rest[i].starts_with("--") {
            i += 2;
        } else {
            out.push(rest[i].as_str());
            i += 1;
        }
    }
    out
}
pub fn provider(args: &Args) -> Result<Provider, String> {
    match args.value("provider") {
        None | Some("" | "claude") => Ok(Provider::Claude),
        Some("codex") => Ok(Provider::Codex),
        Some("opencode") => Ok(Provider::Opencode),
        Some(v) => Err(format!("cockpit: invalid provider \"{v}\"")),
    }
}
pub fn timestamp() -> String {
    registry::iso_timestamp(registry::now_ms())
}
pub fn upsert(
    provider: Provider,
    cwd: &Path,
    session: &str,
    logpath: &Path,
) -> std::io::Result<()> {
    registry::upsert_session(RegistryEntry::new(
        provider,
        &cwd.to_string_lossy(),
        session,
        &logpath.to_string_lossy(),
        &timestamp(),
    ));
    Ok(())
}
pub fn flag_value<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter()
        .position(|s| s == &format!("--{name}"))
        .and_then(|i| rest.get(i + 1))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }
    #[test]
    fn recent_lookahead() {
        let a = parse(&["--recent", "12", "--provider", "codex"]).unwrap();
        assert_eq!(a.recent, Some(12));
        assert_eq!(a.value("provider"), Some("codex"));
        let a = parse(&["--recent", "--provider", "claude"]).unwrap();
        assert!(a.flag("recent"));
        assert_eq!(a.recent, None);
        assert_eq!(a.value("provider"), Some("claude"));
    }
    #[test]
    fn unknown_flag() {
        assert_eq!(
            parse(&["--typo"]).unwrap_err(),
            format!("cockpit: unknown flag \"--typo\"\n{USAGE}")
        );
    }
    #[test]
    fn repeated_and_positionals() {
        let a = parse(&["--file", "a", "--file", "b", "skip", "--needs-call"]).unwrap();
        assert_eq!(a.list("file"), ["a", "b"]);
        assert!(a.flag("needs-call"));
        assert_eq!(
            positionals(&["--x".into(), "hidden".into(), "shown".into()]),
            ["shown"]
        );
    }
}
