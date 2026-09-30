pub mod claude;
pub mod codex;
// Only tests call it until the engine ports land; the first caller removes this allow.
#[allow(dead_code)]
pub mod dedup;
// Only tests call it until the engine ports land; the first caller removes this allow.
#[allow(dead_code)]
pub mod jsonl;
pub mod live;
// Only tests call it until the engine ports land; the first caller removes this allow.
#[allow(dead_code)]
pub mod model;
pub mod opencode;
// Only tests call it until the engine ports land; the first caller removes this allow.
#[allow(dead_code)]
pub mod paths;
pub mod pricing;
pub mod push_usage;
pub mod rollup_db;
pub mod rollup_update;
pub mod server;
// Only tests call it until the engine ports land; the first caller removes this allow.
#[allow(dead_code)]
pub mod session_files;
pub mod stats;
pub mod statusline;

use std::process::ExitCode;

const USAGE: &str = "usage: cockpit atlas <serve|stats|live|rollup-update|statusline|push-usage>";

pub fn run(args: &[String]) -> ExitCode {
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("serve") => server::run(rest),
        Some("stats") => stats::run_cli(rest),
        Some("live") => live::run_cli(rest),
        Some("rollup-update") => rollup_update::run(rest),
        Some("statusline") => statusline::run(rest),
        Some("push-usage") => push_usage::run(rest),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
