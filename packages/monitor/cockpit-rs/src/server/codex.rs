use super::AppState;
use axum::{
    Router,
    body::Bytes,
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tokio::process::Command;

mod transport;
use transport::Transport;

#[derive(Default)]
pub struct CodexState {}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_cli_version: Option<String>,
    daemon_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    control_mode: Option<&'static str>,
    rpc_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    thread_resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_start_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_steer_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_completed_ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_status: Option<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/codex-control/status", any(status))
        .route("/api/send-codex-message", any(send))
}

fn response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            ("content-type", "application/json; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        value.to_string(),
    )
        .into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    response(status, json!({"error": message}))
}

fn authorized(token: Option<&str>) -> bool {
    token.is_some_and(|token| {
        crate::daemon_info::read_daemon_info()
            .and_then(|info| info.token)
            .as_deref()
            == Some(token)
    })
}

fn valid_session(session: &str) -> bool {
    session.len() == 36
        && session
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

async fn status(Query(query): Query<HashMap<String, String>>) -> Response {
    if !authorized(query.get("token").map(String::as_str)) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let session = query.get("session").map(String::as_str).unwrap_or("");
    if !valid_session(session) {
        return error(StatusCode::BAD_REQUEST, "invalid session");
    }
    let report = run_probe(Some(session), None).await;
    let mut value = json!({"ready": report.ok && report.resume_ok == Some(true)});
    if let Some(mode) = report.control_mode {
        value["controlMode"] = json!(mode);
    }
    value["warnings"] = json!(report.warnings);
    value["errors"] = json!(report.errors);
    response(StatusCode::OK, value)
}

async fn send(body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid json");
    };
    if !authorized(body.get("token").and_then(Value::as_str)) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let session = body.get("session").and_then(Value::as_str).unwrap_or("");
    if !valid_session(session) {
        return error(StatusCode::BAD_REQUEST, "invalid session");
    }
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return error(StatusCode::BAD_REQUEST, "empty text");
    }
    let report = run_probe(Some(session), Some(text)).await;
    if !report.ok || (report.turn_start_ok != Some(true) && report.turn_steer_ok != Some(true)) {
        return response(
            StatusCode::BAD_GATEWAY,
            json!({"error": if report.errors.is_empty() { "Codex send failed".into() } else { report.errors.join("; ") }, "warnings": report.warnings}),
        );
    }
    let mut value = json!({"delivered": true});
    if let Some(mode) = report.control_mode {
        value["controlMode"] = json!(mode);
    }
    if let Some(id) = report.turn_id {
        value["turnId"] = json!(id);
    }
    if let Some(status) = report.turn_status {
        value["turnStatus"] = json!(status);
    }
    value["warnings"] = json!(report.warnings);
    response(StatusCode::OK, value)
}

async fn cli(args: &[&str]) -> Result<String, String> {
    let output = Command::new("codex")
        .args(args)
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("codex exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn execute_probe_requests(
    transport: &mut Transport,
    thread: Option<&str>,
    text: Option<&str>,
    report: &mut ProbeReport,
) -> Result<(), String> {
    transport.request("initialize", json!({"clientInfo":{"name":"cockpit-codex-control-probe","title":"Cockpit Codex Control Probe","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":[]}})).await?;
    report.rpc_ready = true;
    let Some(thread) = thread else {
        transport
            .request("thread/loaded/list", json!({"limit":10}))
            .await?;
        report.ok = true;
        return Ok(());
    };
    let resumed = transport
        .request("thread/resume", json!({"threadId":thread}))
        .await?;
    report.thread_resolved = true;
    report.resume_ok = Some(true);
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        let active = if resumed["thread"]["status"]["type"] == "active" {
            resumed["thread"]["turns"]
                .as_array()
                .and_then(|turns| {
                    turns
                        .iter()
                        .rev()
                        .find(|turn| turn["status"] == "inProgress")
                })
                .and_then(|turn| turn["id"].as_str())
        } else {
            None
        };
        let input = json!([{"type":"text","text":text,"text_elements":[]}]);
        if let Some(active) = active {
            let result = transport
                .request(
                    "turn/steer",
                    json!({"threadId":thread,"input":input,"expectedTurnId":active}),
                )
                .await?;
            report.turn_id = Some(
                result["turnId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .unwrap_or(active)
                    .to_owned(),
            );
            report.turn_steer_ok = Some(true);
        } else {
            let result = transport
                .request("turn/start", json!({"threadId":thread,"input":input}))
                .await?;
            report.turn_id = result["turn"]["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            report.turn_start_ok = Some(true);
        }
    }
    report.ok = true;
    Ok(())
}

fn attempt_failed(report: &mut ProbeReport, message: String) -> bool {
    report.ok = false;
    if report.turn_id.is_some()
        || report.turn_start_ok == Some(true)
        || report.turn_steer_ok == Some(true)
    {
        report.errors.push(format!(
            "{} failed after Codex turn was submitted: {message}",
            report.control_mode.unwrap_or("Codex control")
        ));
        return false;
    }
    if report.control_mode != Some("remote-control") {
        report
            .errors
            .push(format!("direct app-server failed: {message}"));
        return false;
    }
    report
        .warnings
        .push(format!("remote-control proxy failed: {message}"));
    true
}

async fn run_probe(thread: Option<&str>, text: Option<&str>) -> ProbeReport {
    let mut report = ProbeReport {
        thread_id: thread.map(str::to_owned),
        ..Default::default()
    };
    if text.is_some_and(|text| !text.is_empty()) && thread.is_none() {
        report.errors.push("--send requires --thread".into());
        return report;
    }
    match cli(&["--version"]).await {
        Ok(version) => report.codex_cli_version = Some(version),
        Err(error) => report
            .errors
            .push(format!("codex --version failed: {error}")),
    }
    match cli(&["remote-control", "start", "--json"])
        .await
        .and_then(|raw| {
            if raw.is_empty() {
                Ok(())
            } else {
                serde_json::from_str::<Value>(&raw)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }) {
        Ok(()) => {
            report.daemon_ready = true;
            report.control_mode = Some("remote-control");
        }
        Err(error) => {
            report
                .warnings
                .push(format!("remote-control start failed: {error}"));
            report.control_mode = Some("direct-app-server");
        }
    }
    loop {
        let transport = if report.control_mode == Some("remote-control") {
            Transport::socket(
                &super::sources::codex_dir().join("app-server-control/app-server-control.sock"),
            )
            .await
        } else {
            Transport::stdio().await
        };
        let result = match transport {
            Ok(mut transport) => {
                let result =
                    execute_probe_requests(&mut transport, thread, text, &mut report).await;
                if result.is_ok()
                    && let (Some(thread), Some(turn)) = (thread, report.turn_id.clone())
                {
                    let thread = thread.to_owned();
                    // Keep the proxy alive until completion without delaying the dashboard response.
                    tokio::spawn(async move {
                        let _ = transport
                            .wait_for_notification(
                                |message| {
                                    let params = &message["params"];
                                    params["threadId"] == thread
                                        && ((message["method"] == "turn/completed"
                                            && params["turn"]["id"] == turn)
                                            || (message["method"] == "error"
                                                && params["turnId"] == turn))
                                },
                                Duration::from_secs(30 * 60),
                            )
                            .await;
                        transport.close();
                    });
                } else {
                    transport.close();
                }
                result
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => return report,
            Err(error) => {
                if !attempt_failed(&mut report, error) {
                    return report;
                }
                report.control_mode = Some("direct-app-server");
                report.rpc_ready = false;
                report.thread_resolved = false;
                report.resume_ok = None;
                report.turn_id = None;
                report.turn_start_ok = None;
                report.turn_steer_ok = None;
                report.turn_completed_ok = None;
                report.turn_status = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submitted_turn_never_falls_back() {
        for field in 0..3 {
            let mut report = ProbeReport {
                control_mode: Some("remote-control"),
                ..Default::default()
            };
            match field {
                0 => report.turn_id = Some("turn".into()),
                1 => report.turn_start_ok = Some(true),
                _ => report.turn_steer_ok = Some(true),
            }
            assert!(!attempt_failed(&mut report, "closed".into()));
            assert_eq!(
                report.errors,
                ["remote-control failed after Codex turn was submitted: closed"]
            );
            assert!(!report.ok);
        }
    }
}
