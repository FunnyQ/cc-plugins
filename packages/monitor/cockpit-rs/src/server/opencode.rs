use super::{AppState, json_error, json_response};
use axum::{
    Router,
    body::Bytes,
    extract::Query,
    http::StatusCode,
    routing::{get, post},
};
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

const UNAVAILABLE: &str = "OpenCode background service unavailable. Start OpenCode (the TUI or opencode serve), or set OPENCODE_SERVER_URL=http://127.0.0.1:<port> — with OPENCODE_SERVER_PASSWORD when the service requires auth — before starting cockpit.";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

const HEALTH_TIMEOUT: Duration = Duration::from_secs(1);
const SESSION_TIMEOUT: Duration = Duration::from_secs(2);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(15);

/// V2 always authenticates as the fixed user; 1.x accepted a username override.
const AUTH_USERNAME: &str = "opencode";

fn authenticated(
    request: RequestBuilder,
    password: Option<&str>,
    timeout: Duration,
) -> RequestBuilder {
    let request = request.timeout(timeout);
    match password {
        Some(password) => request.basic_auth(AUTH_USERNAME, Some(password)),
        None => request,
    }
}

/// The background service registration V2 writes on every start. Each candidate
/// carries its own password so one service's credential never reaches another.
fn service_info() -> Option<(String, Option<String>)> {
    let value: Value =
        serde_json::from_str(&std::fs::read_to_string(crate::paths::opencode_service_json()).ok()?)
            .ok()?;
    let url = value.get("url")?.as_str()?.trim_end_matches('/').to_owned();
    if url.is_empty() {
        return None;
    }
    let password = value
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some((url, password))
}

type Candidate = (String, Option<String>);

fn candidates() -> Vec<Candidate> {
    let file = service_info();
    let mut candidates = Vec::new();
    if let Some(url) = env("OPENCODE_TUI_SERVER_URL").or_else(|| env("OPENCODE_SERVER_URL")) {
        let url = url.trim_end_matches('/').to_owned();
        let password = env("OPENCODE_SERVER_PASSWORD").or_else(|| {
            file.as_ref()
                .filter(|(file_url, _)| *file_url == url)
                .and_then(|(_, password)| password.clone())
        });
        candidates.push((url, password));
    }
    if let Some(candidate) = file
        && !candidates.iter().any(|(url, _)| *url == candidate.0)
    {
        candidates.push(candidate);
    }
    candidates
}

/// Health is "answers /api/info with JSON that names its version" — the 1.x
/// /global/health probe is gone in V2.
async fn discover(client: &Client, candidates: Vec<Candidate>) -> Result<Candidate, String> {
    let mut rejected = None;
    for candidate in candidates {
        let Ok(response) = authenticated(
            client.get(format!("{}/api/info", candidate.0)),
            candidate.1.as_deref(),
            HEALTH_TIMEOUT,
        )
        .send()
        .await
        else {
            continue;
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            rejected.get_or_insert(format!(
                "OpenCode rejected the service password: {}",
                status.as_u16()
            ));
            continue;
        }
        if status.is_success()
            && response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|version| !version.is_empty())
        {
            return Ok(candidate);
        }
    }
    Err(rejected.unwrap_or_else(|| UNAVAILABLE.into()))
}

#[derive(Default)]
struct Report {
    ready: bool,
    server: Option<String>,
    password: Option<String>,
    session: Option<String>,
    delivered: bool,
    errors: Vec<String>,
}

async fn check(client: &Client, candidates: Vec<Candidate>, session: &str) -> Report {
    let (server, password) = match discover(client, candidates).await {
        Ok(found) => found,
        Err(error) => {
            return Report {
                errors: vec![error],
                ..Report::default()
            };
        }
    };
    let mut report = Report {
        server: Some(server),
        password,
        ..Report::default()
    };
    match authenticated(
        client.get(format!(
            "{}/api/session/{session}",
            report.server.as_deref().expect("discovered server")
        )),
        report.password.as_deref(),
        SESSION_TIMEOUT,
    )
    .send()
    .await
    {
        Ok(response) if response.status().is_success() => report.ready = true,
        Ok(response) => report
            .errors
            .push(if response.status() == StatusCode::NOT_FOUND {
                "OpenCode session not found".into()
            } else {
                format!(
                    "OpenCode session check failed: {}",
                    response.status().as_u16()
                )
            }),
        Err(error) => report.errors.push(error.to_string()),
    }
    report
}

async fn send(client: &Client, report: &mut Report, text: &str) {
    if !report.ready {
        return;
    }
    let server = report.server.as_deref().expect("ready report has server");
    let response = authenticated(
        client.post(format!(
            "{server}/api/session/{}/prompt",
            session_of(report)
        )),
        report.password.as_deref(),
        PROMPT_TIMEOUT,
    )
    .json(&json!({"text": text, "delivery": "queue"}))
    .send()
    .await;
    match response {
        Ok(response) => {
            let status = response.status();
            let body = response.json::<Value>().await.unwrap_or(Value::Null);
            if !status.is_success() {
                report.errors.push(prompt_error(&body, status));
                return;
            }
        }
        Err(error) => {
            report.errors.push(error.to_string());
            return;
        }
    }
    report.delivered = true;
}

fn session_of(report: &Report) -> String {
    report
        .session
        .as_deref()
        .expect("ready report carries its session")
        .to_owned()
}

fn prompt_error(body: &Value, status: StatusCode) -> String {
    let message = [
        body.pointer("/error/message"),
        body.get("message"),
        body.get("error"),
    ]
    .into_iter()
    .flatten()
    .find(|value| js_truthy(value))
    .map(js_string);
    match message {
        Some(message) => message,
        None if status.as_u16() == 401 || status.as_u16() == 403 => {
            format!(
                "OpenCode rejected the service password: {}",
                status.as_u16()
            )
        }
        None => format!("OpenCode prompt failed: {}", status.as_u16()),
    }
}

pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}

fn validate<'a>(
    token: Option<&Value>,
    session: Option<&'a str>,
) -> Result<&'a str, (StatusCode, &'static str)> {
    let daemon_token = crate::daemon_info::read_daemon_info()
        .and_then(|info| info.token)
        .map(Value::String)
        .unwrap_or(Value::Null);
    if token != Some(&daemon_token) {
        return Err((StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    let session = session.unwrap_or_default();
    if !session.strip_prefix("ses_").is_some_and(|s| {
        (8..=160).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        return Err((StatusCode::BAD_REQUEST, "invalid session"));
    }
    Ok(session)
}

async fn status(Query(query): Query<HashMap<String, String>>) -> axum::response::Response {
    let session = match validate(
        Some(
            &query
                .get("token")
                .map(|token| json!(token))
                .unwrap_or(Value::Null),
        ),
        query.get("session").map(String::as_str),
    ) {
        Ok(session) => session,
        Err((status, error)) => return json_error(status, error),
    };
    let report = check(&Client::new(), candidates(), session).await;
    let mut body = json!({"ready": report.ready});
    if let Some(server) = report.server {
        body["serverUrl"] = json!(server);
    }
    body["warnings"] = json!([]);
    body["errors"] = json!(report.errors);
    json_response(StatusCode::OK, body)
}

async fn message(bytes: Bytes) -> axum::response::Response {
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid json"),
    };
    let session = match validate(
        body.get("token"),
        body.get("session").and_then(Value::as_str),
    ) {
        Ok(session) => session,
        Err((status, error)) => return json_error(status, error),
    };
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "empty text");
    }
    let client = Client::new();
    let mut report = check(&client, candidates(), session).await;
    report.session = Some(session.to_owned());
    send(&client, &mut report, text).await;
    if !report.delivered {
        let error = report.errors.join("; ");
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({"error": if error.is_empty() { "OpenCode send failed".into() } else { error }, "warnings": []}),
        );
    }
    json_response(
        StatusCode::OK,
        json!({"delivered": true, "delivery": "prompt", "serverUrl": report.server, "warnings": []}),
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/opencode-control/status", get(status))
        .route("/api/send-opencode-message", post(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::State, http::Request};
    use std::sync::{Arc, Mutex};

    #[test]
    fn auth_is_fixed_user_with_optional_password() {
        let _env = crate::paths::tests::TestEnv::new();
        let saved = std::env::var_os("OPENCODE_SERVER_PASSWORD");
        unsafe {
            std::env::remove_var("OPENCODE_SERVER_PASSWORD");
        }
        let client = Client::new();
        assert!(
            !authenticated(client.get("http://localhost"), None, HEALTH_TIMEOUT)
                .build()
                .unwrap()
                .headers()
                .contains_key("authorization")
        );
        assert_eq!(
            authenticated(
                client.get("http://localhost"),
                Some("secret"),
                HEALTH_TIMEOUT
            )
            .build()
            .unwrap()
            .headers()["authorization"],
            "Basic b3BlbmNvZGU6c2VjcmV0"
        );
        unsafe {
            match saved {
                Some(value) => std::env::set_var("OPENCODE_SERVER_PASSWORD", value),
                None => std::env::remove_var("OPENCODE_SERVER_PASSWORD"),
            }
        }
    }

    #[test]
    fn service_info_reads_url_and_password_pair() {
        let fixture = crate::paths::tests::TestEnv::new();
        fixture.set(
            "COCKPIT_OPENCODE_SERVICE_JSON",
            fixture.dir.path().join("service.json"),
        );
        assert_eq!(service_info(), None);
        std::fs::write(
            crate::paths::opencode_service_json(),
            r#"{"url":"http://127.0.0.1:49374/","password":"secret"}"#,
        )
        .unwrap();
        assert_eq!(
            service_info(),
            Some(("http://127.0.0.1:49374".into(), Some("secret".into())))
        );
        std::fs::write(crate::paths::opencode_service_json(), r#"{"url":""}"#).unwrap();
        assert_eq!(service_info(), None);
    }

    type Calls = Arc<Mutex<Vec<(String, String, Value, String)>>>;
    async fn fake(
        State((calls, fail)): State<(Calls, bool)>,
        request: Request<Body>,
    ) -> axum::response::Response {
        let path = request.uri().path().to_owned();
        let query = request.uri().query().unwrap_or_default().to_owned();
        let authorization = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = axum::body::to_bytes(request.into_body(), 4096)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        calls
            .lock()
            .unwrap()
            .push((path.clone(), query, body, authorization));
        let body = match path.as_str() {
            "/api/info" => StatusCode::OK,
            "/api/session/ses_12345678" => StatusCode::OK,
            "/api/session/ses_12345678/prompt" if fail => StatusCode::BAD_GATEWAY,
            _ => StatusCode::OK,
        };
        let payload = match path.as_str() {
            "/api/info" => json!({"version": "2.2.7"}),
            "/api/session/ses_12345678" => {
                json!({"data": {"location": {"directory": "/tmp/project with spaces"}}})
            }
            "/api/session/ses_12345678/prompt" if fail => {
                json!({"error": {"message": "prompt denied"}})
            }
            _ => json!({"data": {"id": "msg_1"}}),
        };
        json_response(body, payload)
    }

    #[test]
    fn delivers_one_prompt_and_surfaces_errors() {
        let _env = crate::paths::tests::TestEnv::new();
        let saved = std::env::var_os("OPENCODE_TUI_SERVER_URL");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                for fail in [false, true] {
                    let calls: Calls = Arc::default();
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let url = format!("http://{}", listener.local_addr().unwrap());
                    let router = Router::new()
                        .fallback(fake)
                        .with_state((calls.clone(), fail));
                    let task = tokio::spawn(async move {
                        axum::serve(listener, router).await.unwrap();
                    });
                    let client = Client::new();
                    unsafe {
                        std::env::set_var("OPENCODE_TUI_SERVER_URL", &url);
                    }
                    let mut report = check(&client, candidates(), "ses_12345678").await;
                    assert!(report.ready);
                    report.session = Some("ses_12345678".into());
                    send(&client, &mut report, "Hello").await;
                    assert_eq!(report.delivered, !fail);
                    let calls = calls.lock().unwrap();
                    assert_eq!(
                        calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
                        if fail {
                            vec![
                                "/api/info",
                                "/api/session/ses_12345678",
                                "/api/session/ses_12345678/prompt",
                            ]
                        } else {
                            vec![
                                "/api/info",
                                "/api/session/ses_12345678",
                                "/api/session/ses_12345678/prompt",
                            ]
                        }
                    );
                    assert_eq!(calls[2].2, json!({"text": "Hello", "delivery": "queue"}));
                    if fail {
                        assert_eq!(report.errors, vec!["prompt denied"]);
                    }
                    task.abort();
                }
            });
        unsafe {
            match saved {
                Some(value) => std::env::set_var("OPENCODE_TUI_SERVER_URL", value),
                None => std::env::remove_var("OPENCODE_TUI_SERVER_URL"),
            }
        }
    }

    #[test]
    fn password_pairs_with_its_url() {
        let fixture = crate::paths::tests::TestEnv::new();
        let saved = std::env::var_os("OPENCODE_TUI_SERVER_URL");
        std::fs::create_dir_all(fixture.dir.path().join("opencode")).unwrap();
        fixture.set(
            "COCKPIT_OPENCODE_SERVICE_JSON",
            fixture.dir.path().join("opencode/service.json"),
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let calls: Calls = Arc::default();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}", listener.local_addr().unwrap());
                std::fs::write(
                    crate::paths::opencode_service_json(),
                    json!({"url": url, "password": "file-secret"}).to_string(),
                )
                .unwrap();
                let router = Router::new()
                    .fallback(fake)
                    .with_state((calls.clone(), false));
                let task = tokio::spawn(async move {
                    axum::serve(listener, router).await.unwrap();
                });
                let client = Client::new();
                let mut report = check(&client, candidates(), "ses_12345678").await;
                assert!(report.ready);
                assert_eq!(report.server.as_deref(), Some(url.as_str()));
                assert_eq!(report.password.as_deref(), Some("file-secret"));
                report.session = Some("ses_12345678".into());
                send(&client, &mut report, "Hello").await;
                assert!(report.delivered);
                let calls = calls.lock().unwrap();
                assert_eq!(
                    calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
                    vec![
                        "/api/info",
                        "/api/session/ses_12345678",
                        "/api/session/ses_12345678/prompt"
                    ]
                );
                assert!(
                    calls
                        .iter()
                        .all(|call| call.3 == "Basic b3BlbmNvZGU6ZmlsZS1zZWNyZXQ=")
                );
                task.abort();
            });
        unsafe {
            match saved {
                Some(value) => std::env::set_var("OPENCODE_TUI_SERVER_URL", value),
                None => std::env::remove_var("OPENCODE_TUI_SERVER_URL"),
            }
        }
    }

    #[test]
    fn env_url_matching_service_json_reuses_its_password() {
        let fixture = crate::paths::tests::TestEnv::new();
        fixture.set(
            "COCKPIT_OPENCODE_SERVICE_JSON",
            fixture.dir.path().join("service.json"),
        );
        std::fs::write(
            crate::paths::opencode_service_json(),
            r#"{"url":"http://127.0.0.1:49374","password":"file-secret"}"#,
        )
        .unwrap();
        fixture.set("OPENCODE_SERVER_URL", "http://127.0.0.1:49374/");
        assert_eq!(
            candidates(),
            vec![("http://127.0.0.1:49374".into(), Some("file-secret".into()))]
        );
        fixture.set("OPENCODE_SERVER_PASSWORD", "env-secret");
        assert_eq!(
            candidates(),
            vec![("http://127.0.0.1:49374".into(), Some("env-secret".into()))]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejected_password_reports_auth_not_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(|| async { StatusCode::UNAUTHORIZED });
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let report = check(
            &Client::new(),
            vec![(url, Some("wrong".into()))],
            "ses_12345678",
        )
        .await;
        assert!(!report.ready);
        assert_eq!(
            report.errors,
            vec!["OpenCode rejected the service password: 401"]
        );
        task.abort();
    }

    #[test]
    fn validates_token_first_and_reads_it_fresh() {
        let fixture = crate::paths::tests::TestEnv::new();
        fixture.set("COCKPIT_HOME", fixture.dir.path());
        let path = crate::paths::daemon_info_path();
        std::fs::write(&path, r#"{"token":"first"}"#).unwrap();
        assert_eq!(
            validate(Some(&json!("bad")), Some("bad")),
            Err((StatusCode::UNAUTHORIZED, "unauthorized"))
        );
        assert_eq!(
            validate(Some(&json!("first")), Some("bad")),
            Err((StatusCode::BAD_REQUEST, "invalid session"))
        );
        for session in [
            "ses_1234567",
            "ses_12345678!",
            "ses_12345678/",
            "ses_12345678\n",
        ] {
            assert!(validate(Some(&json!("first")), Some(session)).is_err());
        }
        assert_eq!(
            validate(Some(&json!("first")), Some("ses_12345678")),
            Ok("ses_12345678")
        );
        let longest = format!("ses_{}", "a".repeat(160));
        assert!(validate(Some(&json!("first")), Some(&longest)).is_ok());
        assert!(validate(Some(&json!("first")), Some(&(longest + "a"))).is_err());
        std::fs::write(path, r#"{"token":"second"}"#).unwrap();
        assert!(validate(Some(&json!("first")), Some("ses_12345678")).is_err());
        assert!(validate(Some(&json!("second")), Some("ses_12345678")).is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn health_timeouts_probe_candidates_in_order() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut urls = Vec::new();
        let mut tasks = Vec::new();
        for index in 0..3 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            urls.push(format!("http://{}", listener.local_addr().unwrap()));
            let calls = calls.clone();
            let router = Router::new().fallback(move || {
                let calls = calls.clone();
                async move {
                    calls.lock().unwrap().push(index);
                    if index < 2 {
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                    axum::Json(json!({"version": "2.2.7"}))
                }
            });
            tasks.push(tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            }));
        }
        let started = std::time::Instant::now();
        assert_eq!(
            discover(
                &Client::new(),
                urls.iter().map(|url| (url.clone(), None)).collect()
            )
            .await
            .map(|(url, _)| url),
            Ok(urls[2].clone())
        );
        assert_eq!(*calls.lock().unwrap(), vec![0, 1, 2]);
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(3));
        for task in tasks {
            task.abort();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unavailable_and_ordered_discovery() {
        let fixture = crate::paths::tests::TestEnv::new();
        fixture.set(
            "COCKPIT_OPENCODE_SERVICE_JSON",
            fixture.dir.path().join("none/service.json"),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = Client::new();
        let start = std::time::Instant::now();
        let mut report = check(&client, candidates(), "ses_12345678").await;
        assert!(!report.ready);
        assert_eq!(report.errors, vec![UNAVAILABLE]);
        assert!(start.elapsed() < Duration::from_secs(2));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let calls: Calls = Arc::default();
        let router = Router::new()
            .fallback(fake)
            .with_state((calls.clone(), false));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        report = check(
            &client,
            vec![(closed.clone(), None), (closed, None), (url.clone(), None)],
            "ses_12345678",
        )
        .await;
        report.session = Some("ses_12345678".into());
        send(&client, &mut report, "Third candidate").await;
        assert!(report.delivered);
        assert_eq!(report.server, Some(url));
        task.abort();
    }
}
