use super::AppState;
use axum::{
    Router,
    body::Bytes,
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use regex::Regex;
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Stdio, sync::LazyLock, time::Duration};

#[derive(Default)]
pub struct OpencodeState {}

const UNAVAILABLE: &str = "OpenCode TUI server unavailable. Start the visible TUI with opencode --port <n>, or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n> before starting cockpit.";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

// Match opencode-send.ts isOpenCodeServer's AbortSignal.timeout(1_000).
const HEALTH_TIMEOUT: Duration = Duration::from_secs(1);
// Match opencode-send.ts checkOpenCodeSession's AbortSignal.timeout(2_000).
const SESSION_TIMEOUT: Duration = Duration::from_secs(2);
// Match opencode-send.ts sendOpenCodePrompt's append/submit AbortSignal.timeout(5_000).
const PROMPT_TIMEOUT: Duration = Duration::from_secs(5);

fn authenticated(request: RequestBuilder, timeout: Duration) -> RequestBuilder {
    let request = request.timeout(timeout);
    match env("OPENCODE_SERVER_PASSWORD") {
        Some(password) => request.basic_auth(
            env("OPENCODE_SERVER_USERNAME").unwrap_or_else(|| "opencode".into()),
            Some(password),
        ),
        None => request,
    }
}

fn process_urls(output: &str) -> Vec<String> {
    static COMMAND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(^|[/\s])opencode(\s|$)").expect("constant regex"));
    static EXCLUDE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\bopencode\s+(serve|web|attach)\b").expect("constant regex"));
    static PORT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"--port(?:=|\s+)(\d{1,5})").expect("constant regex"));
    static SHORT_PORT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"-p\s+(\d{1,5})").expect("constant regex"));
    static HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"--hostname(?:=|\s+)(\S+)").expect("constant regex"));
    output
        .lines()
        .map(str::trim)
        .filter(|line| COMMAND.is_match(line) && !EXCLUDE.is_match(line))
        .filter_map(|line| {
            let port = PORT.captures(line).or_else(|| SHORT_PORT.captures(line))?;
            let host = HOST.captures(line);
            Some(format!(
                "http://{}:{}",
                host.as_ref().map(|c| &c[1]).unwrap_or("127.0.0.1"),
                &port[1]
            ))
        })
        .collect()
}

async fn discover(client: &Client, candidates: Vec<String>) -> Option<String> {
    for url in candidates {
        let response = authenticated(client.get(format!("{url}/global/health")), HEALTH_TIMEOUT)
            .send()
            .await;
        if let Ok(response) = response
            && response.status().is_success()
            && response
                .json::<Value>()
                .await
                .ok()
                .is_some_and(|v| v.get("healthy") == Some(&Value::Bool(true)))
        {
            return Some(url);
        }
    }
    None
}

async fn candidates() -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(url) = env("OPENCODE_TUI_SERVER_URL").or_else(|| env("OPENCODE_SERVER_URL")) {
        urls.push(url.trim_end_matches('/').to_owned());
    }
    if let Ok(output) = tokio::process::Command::new("ps")
        .args(["-axo", "command"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        && output.status.success()
    {
        urls.extend(process_urls(&String::from_utf8_lossy(&output.stdout)));
    }
    urls
}

#[derive(Default)]
struct Report {
    ready: bool,
    server: Option<String>,
    directory: String,
    delivered: bool,
    errors: Vec<String>,
}

async fn check(client: &Client, urls: Vec<String>, session: &str) -> Report {
    let Some(server) = discover(client, urls).await else {
        return Report {
            errors: vec![UNAVAILABLE.into()],
            ..Report::default()
        };
    };
    let mut report = Report {
        server: Some(server.clone()),
        ..Report::default()
    };
    match authenticated(
        client.get(format!("{server}/session/{session}")),
        SESSION_TIMEOUT,
    )
    .send()
    .await
    {
        Ok(response) if response.status().is_success() => {
            report.directory = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| {
                    v.get("directory")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            report.ready = true;
        }
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
    for action in ["append", "submit"] {
        let mut request = authenticated(
            client.post(format!("{server}/tui/{action}-prompt")),
            PROMPT_TIMEOUT,
        );
        if !report.directory.is_empty() {
            request = request.query(&[("directory", &report.directory)]);
        }
        if action == "append" {
            request = request.json(&json!({"text": text}));
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.json::<Value>().await.unwrap_or(Value::Null);
                // opencode-send.ts requires both 2xx and a JSON body strictly equal to true.
                if !status.is_success() || body != Value::Bool(true) {
                    let message = [
                        body.pointer("/data/message"),
                        body.get("message"),
                        body.get("error"),
                    ]
                    .into_iter()
                    .flatten()
                    .find(|value| js_truthy(value))
                    .map(js_string)
                    .unwrap_or_else(|| {
                        format!("OpenCode TUI {action} failed: {}", status.as_u16())
                    });
                    report.errors.push(message);
                    return;
                }
            }
            Err(error) => {
                report.errors.push(error.to_string());
                return;
            }
        }
    }
    report.delivered = true;
}

fn js_truthy(value: &Value) -> bool {
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

fn response(status: StatusCode, body: Value) -> axum::response::Response {
    (
        status,
        [
            ("content-type", "application/json; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
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
        Err((status, error)) => return response(status, json!({"error": error})),
    };
    let report = check(&Client::new(), candidates().await, session).await;
    let mut body = json!({"ready": report.ready});
    if let Some(server) = report.server {
        body["serverUrl"] = json!(server);
    }
    body["warnings"] = json!([]);
    body["errors"] = json!(report.errors);
    response(StatusCode::OK, body)
}

async fn message(bytes: Bytes) -> axum::response::Response {
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => return response(StatusCode::BAD_REQUEST, json!({"error": "invalid json"})),
    };
    let session = match validate(
        body.get("token"),
        body.get("session").and_then(Value::as_str),
    ) {
        Ok(session) => session,
        Err((status, error)) => return response(status, json!({"error": error})),
    };
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return response(StatusCode::BAD_REQUEST, json!({"error": "empty text"}));
    }
    let client = Client::new();
    let mut report = check(&client, candidates().await, session).await;
    send(&client, &mut report, text).await;
    if !report.delivered {
        let error = report.errors.join("; ");
        return response(
            StatusCode::BAD_GATEWAY,
            json!({"error": if error.is_empty() { "OpenCode send failed".into() } else { error }, "warnings": []}),
        );
    }
    response(
        StatusCode::OK,
        json!({"delivered": true, "delivery": "tui", "serverUrl": report.server, "warnings": []}),
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
    fn parses_only_tui_processes() {
        assert_eq!(
            process_urls(
                "opencode --port 4096\n/usr/local/bin/opencode -p 4096 --hostname 0.0.0.0\nopencode serve --port 4096\nopencode web --port 9\nopencode attach --port 9\nopencode\nnotopencode --port 9"
            ),
            vec!["http://127.0.0.1:4096", "http://0.0.0.0:4096"]
        );
        assert_eq!(
            process_urls("opencode --port=123 --hostname=localhost"),
            vec!["http://localhost:123"]
        );
    }

    #[test]
    fn auth_is_optional_and_uses_default_username() {
        let _env = crate::paths::tests::TestEnv::new();
        let saved: Vec<_> = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        // TestEnv holds the shared environment lock for these request-building checks.
        unsafe {
            std::env::remove_var("OPENCODE_SERVER_PASSWORD");
            std::env::remove_var("OPENCODE_SERVER_USERNAME");
        }
        let client = Client::new();
        assert!(
            !authenticated(client.get("http://localhost"), HEALTH_TIMEOUT)
                .build()
                .unwrap()
                .headers()
                .contains_key("authorization")
        );
        unsafe {
            std::env::set_var("OPENCODE_SERVER_PASSWORD", "secret");
        }
        assert_eq!(
            authenticated(client.get("http://localhost"), HEALTH_TIMEOUT)
                .build()
                .unwrap()
                .headers()["authorization"],
            "Basic b3BlbmNvZGU6c2VjcmV0"
        );
        unsafe {
            std::env::set_var("OPENCODE_SERVER_USERNAME", "user");
        }
        assert_eq!(
            authenticated(client.get("http://localhost"), HEALTH_TIMEOUT)
                .build()
                .unwrap()
                .headers()["authorization"],
            "Basic dXNlcjpzZWNyZXQ="
        );
        for (key, value) in saved {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    type Calls = Arc<Mutex<Vec<(String, String, Value)>>>;
    async fn fake(
        State((calls, fail)): State<(Calls, bool)>,
        request: Request<Body>,
    ) -> axum::response::Response {
        let path = request.uri().path().to_owned();
        let query = request.uri().query().unwrap_or_default().to_owned();
        let bytes = axum::body::to_bytes(request.into_body(), 4096)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        calls.lock().unwrap().push((path.clone(), query, body));
        let body = match path.as_str() {
            "/global/health" => json!({"healthy": true}),
            "/session/ses_12345678" => json!({"directory": "/tmp/project with spaces"}),
            "/tui/append-prompt" if fail => json!({"data": {"message": "append denied"}}),
            _ => json!(true),
        };
        response(StatusCode::OK, body)
    }

    #[test]
    fn delivers_in_order_and_surfaces_append_errors() {
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
                    // TestEnv serializes this environment override with the other crate tests.
                    unsafe {
                        std::env::set_var("OPENCODE_TUI_SERVER_URL", &url);
                    }
                    let mut report = check(&client, candidates().await, "ses_12345678").await;
                    assert!(report.ready);
                    send(&client, &mut report, "Hello").await;
                    assert_eq!(report.delivered, !fail);
                    let calls = calls.lock().unwrap();
                    assert_eq!(
                        calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
                        if fail {
                            vec![
                                "/global/health",
                                "/session/ses_12345678",
                                "/tui/append-prompt",
                            ]
                        } else {
                            vec![
                                "/global/health",
                                "/session/ses_12345678",
                                "/tui/append-prompt",
                                "/tui/submit-prompt",
                            ]
                        }
                    );
                    assert_eq!(calls[2].1, "directory=%2Ftmp%2Fproject+with+spaces");
                    assert_eq!(calls[2].2, json!({"text": "Hello"}));
                    if fail {
                        assert_eq!(report.errors, vec!["append denied"]);
                    } else {
                        assert_eq!(calls[3].1, calls[2].1);
                        assert_eq!(calls[3].2, Value::Null);
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
    fn validates_token_first_and_reads_it_fresh() {
        let fixture = crate::paths::tests::TestEnv::new();
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", fixture.dir.path());
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
                    axum::Json(json!({"healthy": true}))
                }
            });
            tasks.push(tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            }));
        }
        let started = std::time::Instant::now();
        assert_eq!(
            discover(&Client::new(), urls.clone()).await,
            Some(urls[2].clone())
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = Client::new();
        let start = std::time::Instant::now();
        let report = check(&client, vec![closed.clone()], "ses_12345678").await;
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
        let mut report = check(
            &client,
            vec![closed.clone(), closed, url.clone()],
            "ses_12345678",
        )
        .await;
        send(&client, &mut report, "Third candidate").await;
        assert!(report.delivered);
        assert_eq!(report.server, Some(url));
        task.abort();
    }
}
