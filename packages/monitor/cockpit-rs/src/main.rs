use clap::{Args, Parser, Subcommand};
use std::process::ExitCode;

// Consumed by later subcommand ports.
#[allow(dead_code)]
mod paths;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod config;
// Consumed by later subcommand ports.
#[allow(dead_code)]
mod tunables;

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
    match Cli::parse().command {
        Command::Server(args) => stub("server", args),
        Command::Channel(args) => stub("channel", args),
        Command::Log(args) => stub("log", args),
        Command::Scribe(args) => stub("scribe", args),
        Command::Prep(args) => stub("prep", args),
        Command::Config(args) => stub("config", args),
        Command::Wait(args) => stub("wait", args),
        Command::Send(args) => stub("send", args),
        Command::Restart(args) => stub("restart", args),
        Command::Nudge(args) => stub("nudge", args),
        Command::FindSession(args) => stub("find-session", args),
        Command::Hook { command } => match command {
            HookCommand::SessionStart(args) => stub("hook session-start", args),
            HookCommand::Stop(args) => stub("hook stop", args),
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
