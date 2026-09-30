// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use serde::Serialize;
use std::path::Path;
use std::process::ExitCode;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {}

pub struct UpdateOptions {
    pub rebuild: bool,
}

pub fn update_rollup(
    db: &mut rusqlite::Connection,
    projects_dir: &Path,
    opts: UpdateOptions,
) -> anyhow::Result<UpdateResult> {
    todo!()
}

pub fn run(args: &[String]) -> ExitCode {
    todo!()
}
