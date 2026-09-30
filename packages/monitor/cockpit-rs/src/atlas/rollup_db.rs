// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use std::path::Path;

pub const SCHEMA_VERSION: i64 = 3;

pub fn open_rollup_db(path: &Path) -> anyhow::Result<rusqlite::Connection> {
    todo!()
}

pub fn open_sqlite_file(path: &Path) -> anyhow::Result<rusqlite::Connection> {
    todo!()
}
