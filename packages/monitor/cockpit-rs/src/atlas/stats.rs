// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::Ctx;
use super::{claude, codex, opencode, pricing};
use std::process::ExitCode;

const USAGE: &str = "usage: cockpit atlas stats [--source claude|codex|opencode|pricing]";

pub async fn build(ctx: &Ctx) -> anyhow::Result<serde_json::Value> {
    todo!()
}

pub fn fingerprint(ctx: &Ctx) -> String {
    todo!()
}

pub fn models_in(stats: &serde_json::Value) -> Vec<String> {
    todo!()
}

#[derive(Clone, Copy)]
enum Source {
    Claude,
    Codex,
    Opencode,
    Pricing,
}

fn parse_args(args: &[String]) -> Option<Option<Source>> {
    match args {
        [] => Some(None),
        [flag, name] if flag == "--source" => match name.as_str() {
            "claude" => Some(Some(Source::Claude)),
            "codex" => Some(Some(Source::Codex)),
            "opencode" => Some(Some(Source::Opencode)),
            "pricing" => Some(Some(Source::Pricing)),
            _ => None,
        },
        _ => None,
    }
}

// Each module's source_json owns the whole `--source` shape; this only prints it.
async fn produce(ctx: &Ctx, source: Option<Source>) -> anyhow::Result<serde_json::Value> {
    Ok(match source {
        None => build(ctx).await?,
        Some(Source::Claude) => claude::source_json(ctx, &claude::load(ctx)?),
        Some(Source::Codex) => codex::source_json(
            &codex::load(ctx)?,
            &codex::read_codex_usage_limits(ctx).await,
        ),
        Some(Source::Opencode) => opencode::source_json(&opencode::load(ctx)?),
        Some(Source::Pricing) => pricing::source_json(&pricing::load_pricing_with_meta(ctx).await?),
    })
}

pub fn run_cli(args: &[String]) -> ExitCode {
    let Some(source) = parse_args(args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| {
            let ctx = Ctx::from_env()?;
            runtime.block_on(produce(&ctx, source))
        });
    match result {
        Ok(value) => {
            // JSON.stringify(data, null, 2) with no trailing newline, as api.ts prints it.
            print!(
                "{}",
                serde_json::to_string_pretty(&value).expect("a Value always serializes")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("atlas: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn illegal_source_is_rejected_before_any_module() {
        assert!(matches!(parse_args(&args(&[])), Some(None)));
        assert!(matches!(
            parse_args(&args(&["--source", "codex"])),
            Some(Some(Source::Codex))
        ));
        for bad in [&["--source"][..], &["--source", "nope"], &["--bogus"]] {
            assert!(parse_args(&args(bad)).is_none(), "{bad:?}");
            assert_eq!(run_cli(&args(bad)), ExitCode::from(2));
        }
    }
}
