mod channel;

use clap::{Args, Parser, Subcommand};
use std::process::ExitCode;

mod server;

mod hook;

// Consumed by later subcommand ports.
#[allow(dead_code)]
mod paths;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod config;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod tunables;

// Consumed by later subcommand ports.
#[allow(dead_code)]
mod registry;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod log_root;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod daemon_info;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod process_alive;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod call_log;

// Consumed by later subcommand ports.
#[allow(dead_code)]
mod find_session;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod nudge_toggle;

mod cli;

#[derive(Parser)]
#[command(name = "cockpit", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct TrailingArgs {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    Server(TrailingArgs),
    Channel(TrailingArgs),
    Log(TrailingArgs),
    Scribe(TrailingArgs),
    Prep(TrailingArgs),
    Config(TrailingArgs),
    Wait(TrailingArgs),
    Send(TrailingArgs),
    Restart(TrailingArgs),
    Nudge(TrailingArgs),
    FindSession(TrailingArgs),
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
}

#[derive(Subcommand)]
enum HookCommand {
    SessionStart(TrailingArgs),
    Stop(TrailingArgs),
}

fn stub(subcommand: &str, _args: TrailingArgs) -> ExitCode {
    eprintln!("cockpit: {subcommand} not implemented yet");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = cli::preflight(&argv) {
        return code;
    }
    match Cli::parse().command {
        Command::Server(args) => server::run(&args.args),
        Command::Channel(_) => channel::run(),
        Command::Log(args) => cli::run("log", &args.args),
        Command::Scribe(args) => cli::run("scribe", &args.args),
        Command::Prep(args) => cli::run("prep", &args.args),
        Command::Config(args) => cli::run("config", &args.args),
        Command::Wait(args) => stub("wait", args),
        Command::Send(args) => stub("send", args),
        Command::Restart(args) => stub("restart", args),
        Command::Nudge(args) => cli::run("nudge", &args.args),
        Command::FindSession(args) => cli::run("find-session", &args.args),
        Command::Hook { command } => match command {
            HookCommand::SessionStart(_) => hook::run(true),
            HookCommand::Stop(_) => hook::run(false),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stub_accepts_arbitrary_trailing_arguments() {
        for sub in [
            "server",
            "channel",
            "log",
            "scribe",
            "prep",
            "config",
            "wait",
            "send",
            "restart",
            "nudge",
            "find-session",
        ] {
            assert!(Cli::try_parse_from(["cockpit", sub, "--unknown", "value", "-x"]).is_ok());
            assert!(Cli::try_parse_from(["cockpit", sub]).is_ok());
        }
        for sub in ["session-start", "stop"] {
            assert!(
                Cli::try_parse_from(["cockpit", "hook", sub, "--unknown", "value", "-x"]).is_ok()
            );
        }
        assert!(Cli::try_parse_from(["cockpit", "unknown"]).is_err());
    }
}
