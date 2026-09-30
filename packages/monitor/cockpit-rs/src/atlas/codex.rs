// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::{Ctx, ProviderUsage, UsageLimits};

pub struct CodexSource {
    pub usage: ProviderUsage,
}

pub fn load(ctx: &Ctx) -> anyhow::Result<CodexSource> {
    todo!()
}

pub async fn read_codex_usage_limits(ctx: &Ctx) -> UsageLimits {
    todo!()
}

/// The full `--source codex` shape: `{usage, usageLimits}`.
pub fn source_json(src: &CodexSource, limits: &UsageLimits) -> serde_json::Value {
    todo!()
}
