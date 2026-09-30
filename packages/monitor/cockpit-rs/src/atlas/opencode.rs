// Stub until its port lands; the port removes this allow.
#![allow(dead_code, unused_variables)]

use super::model::{Ctx, ProviderUsage};

pub struct OpenCodeSource {
    pub usage: ProviderUsage,
}

pub fn load(ctx: &Ctx) -> anyhow::Result<OpenCodeSource> {
    todo!()
}

/// The full `--source opencode` shape: `{usage}`.
pub fn source_json(src: &OpenCodeSource) -> serde_json::Value {
    todo!()
}
