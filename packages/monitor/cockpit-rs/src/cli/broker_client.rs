use super::{flag_value, positionals};
use crate::{
    call_log,
    daemon_info::{self, DaemonCoords},
    process_alive, registry,
    server::opencode::js_truthy,
    tunables,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};
use tokio::time::sleep;

fn require_daemon() -> Result<DaemonCoords, String> {
    daemon_info::read_daemon_info()
        .filter(|d| !d.pid.is_some_and(|p| !process_alive::is_alive(p)))
        .and_then(|d| d.coords())
        .ok_or_else(|| "cockpit daemon not running — start the dashboard first".into())
}
pub fn resolve_call_id(session: &str, explicit: Option<&str>) -> Option<String> {
    if let Some(call) = explicit.filter(|s| !s.is_empty()) {
        return Some(call.into());
    }
    call_log::latest_open_call_in(registry::entry_for(session)?.log_path())
}
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}
async fn error_text(res: reqwest::Response) -> String {
    let status = res.status().as_u16();
    if let Ok(body) = res.json::<Value>().await
        && let Some(error) = body.get("error").filter(|v| js_truthy(v))
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
        if data.get("delivered").is_some_and(js_truthy) {
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
    let mut query = vec![
        ("session", session.to_owned()),
        ("token", d.token.clone()),
        ("require_watcher", "1".to_owned()),
    ];
    if let Some(call) = call.filter(|s| !s.is_empty()) {
        query.push(("call", call));
    }
    let url = format!("http://127.0.0.1:{}/api/wait", d.port);
    let start = Instant::now();
    let mut failures = 0;
    while start.elapsed() < max {
        let res = match client.get(&url).query(&query).send().await {
            Ok(res) => {
                failures = 0;
                res
            }
            Err(e) => {
                failures += 1;
                let fresh = daemon_info::read_daemon_info();
                if failures >= 3
                    || fresh.is_none_or(|f| {
                        f.coords().as_ref() != Some(&d)
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
    use std::fs;
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
