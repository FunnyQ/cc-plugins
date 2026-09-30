use super::{flag_value, positionals};
use crate::{call_log, daemon_info, process_alive, registry, tunables};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    process::ExitCode,
    time::{Duration, Instant},
};
use tokio::time::sleep;

pub struct Daemon {
    pub pid: Option<i32>,
    pub port: u16,
    pub token: String,
}
pub fn read_daemon() -> Option<Daemon> {
    let record = daemon_info::read_daemon_info()?;
    Some(Daemon {
        pid: record.pid,
        port: record.port?,
        token: record.token?,
    })
}
fn require_daemon() -> Result<Daemon, String> {
    read_daemon()
        .filter(|d| !d.pid.is_some_and(|p| !process_alive::is_alive(p)))
        .ok_or_else(|| "cockpit daemon not running — start the dashboard first".into())
}
pub fn resolve_call_id(session: &str, explicit: Option<&str>) -> Option<String> {
    if let Some(call) = explicit.filter(|s| !s.is_empty()) {
        return Some(call.into());
    }
    let entry = registry::read_registry()
        .into_iter()
        .find(|e| e.session_id() == session)?;
    let text = fs::read_to_string(entry.log_path()).ok()?;
    call_log::latest_open_call_id(&text.split('\n').collect::<Vec<_>>())
}
pub fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
async fn error_text(res: reqwest::Response) -> String {
    let status = res.status().as_u16();
    if let Ok(body) = res.json::<Value>().await
        && let Some(error) = body.get("error").filter(|v| truthy(v))
    {
        let error = error
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string());
        return format!("{error} (HTTP {status})");
    }
    format!("HTTP {status}")
}
pub fn run(sub: &str, rest: &[String]) -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let result = match runtime {
        Ok(rt) => rt.block_on(command(sub, rest)),
        Err(e) => Err(format!("cockpit {sub}: {e}")),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
async fn command(sub: &str, rest: &[String]) -> Result<u8, String> {
    let pos = positionals(rest);
    let session = pos
        .first()
        .copied()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            if sub == "wait" {
                "cockpit wait: <sessionId> is required".to_owned()
            } else {
                "cockpit send: <sessionId> <answer> is required".to_owned()
            }
        })?;
    let d = require_daemon()?;
    let call = resolve_call_id(session, flag_value(rest, "call"));
    let client = client()?;
    if sub == "send" {
        #[derive(Serialize)]
        struct Answer<'a> {
            session: &'a str,
            answer: String,
            call: Option<String>,
            token: &'a str,
        }
        let res = client
            .post(format!("http://127.0.0.1:{}/api/respond", d.port))
            .json(&Answer {
                session,
                answer: pos[1..].join(" "),
                call,
                token: &d.token,
            })
            .send()
            .await
            .map_err(|e| format!("cockpit send: lost connection to daemon ({e})"))?;
        if !res.status().is_success() {
            return Err(format!("cockpit send: {}", error_text(res).await));
        }
        let data = res.json::<Value>().await.unwrap_or(Value::Null);
        if data.get("delivered").is_some_and(truthy) {
            println!("delivered: true");
        } else {
            println!(
                "delivered: false\n  (answer logged, but the session isn't parked/listening right now)"
            );
        }
        return Ok(0);
    }
    // COCKPIT_WAIT_MAX_MS is the TS-honored total wait override, defaulting to six hours.
    let max = Duration::from_millis(tunables::env_int("COCKPIT_WAIT_MAX_MS", 21_600_000));
    let mut url = format!(
        "http://127.0.0.1:{}/api/wait?session={}&token={}&require_watcher=1",
        d.port,
        encode_component(session),
        encode_component(&d.token)
    );
    if let Some(call) = call.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&call={}", encode_component(&call)));
    }
    let start = Instant::now();
    let mut failures = 0;
    while start.elapsed() < max {
        let res = match client.get(&url).send().await {
            Ok(res) => {
                failures = 0;
                res
            }
            Err(e) => {
                failures += 1;
                let fresh = read_daemon();
                if failures >= 3
                    || fresh.is_none_or(|f| {
                        f.port != d.port
                            || f.token != d.token
                            || f.pid.is_some_and(|p| !process_alive::is_alive(p))
                    })
                {
                    return Err(format!("cockpit wait: lost connection to daemon ({e})"));
                }
                sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if !res.status().is_success() {
            return Err(format!("cockpit wait: {}", error_text(res).await));
        }
        let Ok(data) = res.json::<Value>().await else {
            sleep(Duration::from_secs(1)).await;
            continue;
        };
        if let Some(answer) = data.get("answer").and_then(Value::as_str) {
            println!("{answer}");
            return Ok(0);
        }
        if data.get("superseded") == Some(&Value::Bool(true)) {
            eprintln!("cockpit wait: call is no longer open (superseded)");
            return Ok(3);
        }
        if data.get("not_watching") == Some(&Value::Bool(true)) {
            if data.get("reason").and_then(Value::as_str) == Some("toggle_off") {
                eprintln!("cockpit wait: nobody is watching — the answer-here switch is off");
            } else {
                eprintln!(
                    "cockpit wait: nobody is watching — no cockpit tab has this session open"
                );
            }
            return Ok(4);
        }
    }
    Err("cockpit wait: no answer received".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn component_matches_javascript() {
        assert_eq!(encode_component("session/ with&"), "session%2F%20with%26");
        assert_eq!(
            encode_component("!~*'()-_.中文"),
            "!~*'()-_.%E4%B8%AD%E6%96%87"
        );
    }
    #[test]
    fn resolves_call_from_registry_and_explicit_override() {
        let env = crate::paths::tests::TestEnv::new();
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", env.dir.path());
        assert_eq!(resolve_call_id("s", None), None);
        let log = env.dir.path().join("log.jsonl");
        fs::write(
            &log,
            r#"{"type":"decision","id":"c","needs_your_call":true}"#,
        )
        .unwrap();
        fs::write(
            crate::paths::registry_path(),
            serde_json::json!({"sessions":[{"sessionId":"s","logPath":log}]}).to_string(),
        )
        .unwrap();
        assert_eq!(resolve_call_id("s", None).as_deref(), Some("c"));
        assert_eq!(
            resolve_call_id("s", Some("explicit")).as_deref(),
            Some("explicit")
        );
        fs::write(&log, "invalid").unwrap();
        assert_eq!(resolve_call_id("s", None), None);
        fs::write(
            crate::paths::registry_path(),
            r#"{"sessions":[{"sessionId":"s","logPath":"/missing"}]}"#,
        )
        .unwrap();
        assert_eq!(resolve_call_id("s", None), None);
    }
}
