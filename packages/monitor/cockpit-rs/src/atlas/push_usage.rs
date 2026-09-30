use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;

use super::model::Ctx;
use super::{claude, codex};

const PUSH_TIMEOUT: Duration = Duration::from_secs(8);

pub fn run(_args: &[String]) -> ExitCode {
    let url = std::env::var("LLM_QUOTA_INGEST_URL").unwrap_or_default();
    let url = url.trim();
    if url.is_empty() {
        return ExitCode::SUCCESS;
    }
    // Neither limits reader uses the plugin root, and the TS push never needed one.
    let ctx = Ctx::from_env().unwrap_or_else(|_| Ctx {
        now_ms: super::model::now_ms(),
        plugin_root: Default::default(),
    });
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return ExitCode::SUCCESS;
    };
    runtime.block_on(push(&ctx, url));
    ExitCode::SUCCESS
}

async fn push(ctx: &Ctx, url: &str) {
    let claude = claude::read_usage_limits(ctx);
    let codex = codex::read_codex_usage_limits(ctx).await;
    // Real clock: push-usage.ts stamps Date.now(), not the TOKEN_ATLAS_NOW_MS seam.
    let captured_at = jiff::Timestamp::now().as_millisecond();
    let payload = json!({ "capturedAt": captured_at, "claude": claude, "codex": codex });
    let Ok(body) = serde_json::to_string(&payload) else {
        return;
    };
    let secret = std::env::var("LLM_QUOTA_INGEST_SECRET").unwrap_or_default();
    let Ok(client) = reqwest::Client::builder().timeout(PUSH_TIMEOUT).build() else {
        return;
    };
    let _ = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Auth-Token", secret.trim())
        .body(body)
        .send()
        .await;
}
