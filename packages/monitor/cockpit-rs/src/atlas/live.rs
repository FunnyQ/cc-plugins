// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::Ctx;
use serde::Serialize;
use std::process::ExitCode;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {}

pub fn live_sessions(ctx: &Ctx) -> Vec<LiveSession> {
    todo!()
}

pub fn cockpit_daemon_port() -> Option<serde_json::Number> {
    todo!()
}

pub fn run_cli(args: &[String]) -> ExitCode {
    todo!()
}
