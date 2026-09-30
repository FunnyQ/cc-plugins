// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::{Ctx, InternalLedgerRow, ProviderUsage, UsageLimits};
use serde::Serialize;

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCache {}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {}

pub struct ClaudeSource {
    pub usage: ProviderUsage,
    pub ledger: Vec<InternalLedgerRow>,
    pub transcript_file_count: usize,
    pub stats_cache: StatsCache,
    pub history: History,
}

pub fn load(ctx: &Ctx) -> anyhow::Result<ClaudeSource> {
    todo!()
}

pub fn read_usage_limits(ctx: &Ctx) -> UsageLimits {
    todo!()
}

/// The full `--source claude` shape, usageLimits included.
pub fn source_json(ctx: &Ctx, src: &ClaudeSource) -> serde_json::Value {
    todo!()
}
