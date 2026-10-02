use crate::server::opencode::js_truthy;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitCode, ExitStatus, Stdio};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

use super::model::iso_ms;
use super::paths;

const ROLLUP_NUDGE_THROTTLE_MS: i64 = 5 * 60 * 1000;
const PUSH_NUDGE_THROTTLE_MS: i64 = 2 * 60 * 1000;
const DEFAULT_COMMAND: &str = "bunx -y ccstatusline@latest";

pub fn run(_args: &[String]) -> ExitCode {
    let mut payload = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut payload);
    ingest(&payload);
    ExitCode::from(run_statusline(payload) as u8)
}

// The monitor mod's session.measure hook: the statusline's ingest without a statusline to render.
pub fn run_measure(_args: &[String]) -> ExitCode {
    let mut payload = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut payload);
    ingest(&payload);
    ExitCode::SUCCESS
}

fn ingest(payload: &[u8]) {
    cache_rate_limits(payload);

    let cache_dir = paths::token_atlas_cache_dir();
    nudge(
        &cache_dir.join(".rollup-nudge"),
        ROLLUP_NUDGE_THROTTLE_MS,
        "rollup-update",
    );
    if std::env::var("LLM_QUOTA_INGEST_URL").is_ok_and(|url| !url.trim().is_empty()) {
        nudge(
            &cache_dir.join(".push-nudge"),
            PUSH_NUDGE_THROTTLE_MS,
            "push-usage",
        );
    }
}

// The TS stamps rate-limits.json and throttles nudges off the real clock, not the TOKEN_ATLAS_NOW_MS seam.
fn real_now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

fn build_rate_limits_record(payload: &[u8], now_ms: i64) -> Option<Value> {
    let parsed: Value = serde_json::from_slice(payload).ok()?;
    let rate_limits = parsed.get("rate_limits")?;
    if !js_truthy(rate_limits) {
        return None;
    }
    Some(json!({
        "capturedAt": iso_ms(now_ms).unwrap_or_default(),
        "capturedAtEpochMs": now_ms,
        "rate_limits": rate_limits,
    }))
}

fn cache_rate_limits(payload: &[u8]) {
    let Some(record) = build_rate_limits_record(payload, real_now_ms()) else {
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(&record) else {
        return;
    };
    let _ = std::fs::create_dir_all(paths::token_atlas_cache_dir())
        .and_then(|()| std::fs::write(paths::rate_limits_cache(), text));
}

fn should_nudge(last_mtime_ms: Option<i64>, now_ms: i64, throttle_ms: i64) -> bool {
    now_ms - last_mtime_ms.unwrap_or(0) >= throttle_ms
}

fn marker_mtime_ms(marker: &Path) -> Option<i64> {
    let modified = std::fs::metadata(marker).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn nudge(marker: &Path, throttle_ms: i64, sub: &str) {
    if !should_nudge(marker_mtime_ms(marker), real_now_ms(), throttle_ms) {
        return;
    }
    if std::fs::create_dir_all(paths::token_atlas_cache_dir()).is_err()
        || std::fs::write(marker, "").is_err()
    {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(exe);
    command
        .args(["atlas", sub])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::process_alive::detach(&mut command);
    // No reap: this process exits within ms, so init adopts and reaps the child.
    let _ = command.spawn();
}

fn exit_code_for(result: &std::io::Result<ExitStatus>) -> i32 {
    match result {
        Ok(status) => status.code().unwrap_or(0),
        Err(_) => 1,
    }
}

fn run_statusline(payload: Vec<u8>) -> i32 {
    let command = std::env::var("TOKEN_ATLAS_STATUSLINE_COMMAND")
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| DEFAULT_COMMAND.to_string());
    let spawned = Command::new("sh")
        .arg("-c")
        .arg(&command)
        // An inner command that is itself `atlas statusline` would otherwise re-read the var and spawn forever.
        .env_remove("TOKEN_ATLAS_STATUSLINE_COMMAND")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => return exit_code_for(&Err(e)),
    };
    // Feed stdin from a thread so an inner command that prints before reading cannot deadlock us.
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        })
    });
    let output = child.wait_with_output();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    if let Ok(out) = &output {
        // Raw bytes: identical to the TS utf8 decode/re-encode for valid UTF-8.
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(&out.stdout);
        let _ = stdout.flush();
    }
    exit_code_for(&output.map(|o| o.status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    const NOW: i64 = 1_779_667_200_000;

    fn record(payload: &str) -> Option<String> {
        build_rate_limits_record(payload.as_bytes(), NOW).map(|v| v.to_string())
    }

    #[test]
    fn falsy_or_missing_rate_limits_write_nothing() {
        for p in [
            "not json",
            r#"{"model":"x"}"#,
            r#"{"rate_limits":null}"#,
            r#"{"rate_limits":0}"#,
            r#"{"rate_limits":0.0}"#,
            r#"{"rate_limits":-0}"#,
            r#"{"rate_limits":false}"#,
            r#"{"rate_limits":""}"#,
        ] {
            assert_eq!(record(p), None, "{p}");
        }
    }

    #[test]
    fn truthy_rate_limits_are_cached_in_key_order() {
        let head = r#"{"capturedAt":"2026-05-25T00:00:00.000Z","capturedAtEpochMs":1779667200000,"rate_limits":"#;
        for (input, cached) in [
            (
                r#"{"primary":{"used_percent":12}}"#,
                r#"{"primary":{"used_percent":12}}"#,
            ),
            ("[]", "[]"),
            ("{}", "{}"),
            (r#"{"z":1,"a":2}"#, r#"{"z":1,"a":2}"#),
        ] {
            let payload = format!(r#"{{"rate_limits":{input}}}"#);
            assert_eq!(record(&payload), Some(format!("{head}{cached}}}")));
        }
    }

    #[test]
    fn iso_string_keeps_milliseconds() {
        let ms = 1_779_712_496_000 + 7;
        assert_eq!(iso_ms(ms).unwrap(), "2026-05-25T12:34:56.007Z");
    }

    #[test]
    fn nudge_throttle_boundary() {
        assert!(should_nudge(None, NOW, 300_000));
        assert!(!should_nudge(Some(NOW - 299_999), NOW, 300_000));
        assert!(should_nudge(Some(NOW - 300_000), NOW, 300_000));
    }

    #[test]
    fn exit_code_mapping() {
        assert_eq!(exit_code_for(&Ok(ExitStatus::from_raw(3 << 8))), 3);
        assert_eq!(exit_code_for(&Ok(ExitStatus::from_raw(9))), 0);
        assert_eq!(exit_code_for(&Err(std::io::Error::other("x"))), 1);
    }
}
