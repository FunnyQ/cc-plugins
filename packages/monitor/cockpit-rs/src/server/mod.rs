use crate::{daemon_info, paths, process_alive};
use axum::{
    Router,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
};
use std::{
    path::Path,
    process::{ExitCode, Stdio},
    sync::Arc,
    time::Duration,
};

pub mod broker;
pub mod codex;
pub mod inbox;
pub mod log_stream;
pub mod opencode;
pub mod permission;
pub mod presence;
pub mod sources;
pub mod static_files;
pub mod transcript;
pub mod views;

#[derive(Clone)]
pub struct AppState {
    pub presence: Arc<presence::Presence>,
    pub broker: Arc<broker::BrokerState>,
    pub inbox: Arc<inbox::InboxState>,
    pub permission: Arc<permission::PermissionState>,
    pub plugin_root: Arc<Path>,
}

fn parse_port(value: &str) -> Option<u16> {
    let value = value.trim_start();
    let digits = value.strip_prefix('+').unwrap_or(value);
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    digits[..end].parse::<u16>().ok().filter(|port| *port > 0)
}

fn port(args: &[String]) -> u16 {
    args.iter()
        .position(|arg| arg == "--port")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| parse_port(value))
        .or_else(|| {
            std::env::var("COCKPIT_SERVER_PORT")
                .ok()
                .and_then(|value| parse_port(&value))
        })
        .unwrap_or(5858)
}

fn open_browser(url: &str, no_open: bool) {
    if no_open {
        return;
    }
    use std::os::unix::process::CommandExt;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
}

async fn token() -> Response {
    let info = daemon_info::read_process_info();
    let (status, body) = match info
        .and_then(|info| info.token)
        .filter(|token| !token.is_empty())
    {
        Some(token) => (StatusCode::OK, serde_json::json!({"token": token})),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"error": "daemon token unavailable"}),
        ),
    };
    json_response(status, body)
}

pub(crate) fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
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

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    json_response(status, serde_json::json!({"error": message}))
}

pub fn run(args: &[String]) -> ExitCode {
    let (plugin_root, root) = match paths::plugin_root()
        .and_then(|plugin_root| daemon_info::daemon_root().map(|root| (plugin_root, root)))
    {
        Ok(roots) => roots,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let no_open = args.iter().any(|arg| arg == "--no-open");
    let info = daemon_info::read_process_info();
    match daemon_info::decide_startup(info.as_ref(), &root, process_alive::is_alive) {
        daemon_info::StartupDecision::Reuse(info) => {
            let pid = info.pid.expect("startup reuse has a live pid");
            let port = info.port.expect("startup record has a port");
            let url = format!("http://localhost:{port}");
            println!("cockpit daemon already running → {url} (pid {pid})");
            open_browser(&url, no_open);
            return ExitCode::SUCCESS;
        }
        daemon_info::StartupDecision::Supersede(info) => {
            let pid = info.pid.expect("startup supersede has a live pid");
            println!(
                "superseding stale cockpit daemon (pid {pid}, root {}) — this install is {root}",
                info.root.as_deref().unwrap_or("unknown")
            );
            process_alive::terminate(pid);
            std::thread::sleep(Duration::from_millis(100));
        }
        daemon_info::StartupDecision::Start => {}
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cockpit: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async {
        let port = port(args);
        let listener = match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => listener,
            Err(error) => {
                if error.kind() == std::io::ErrorKind::AddrInUse {
                    eprintln!("cockpit: port {port} is in use by another process — stop it or pass --port <n>.");
                } else { eprintln!("cockpit: {error}"); }
                return ExitCode::FAILURE;
            }
        };
        let token = daemon_info::new_token();
        daemon_info::write_daemon_info(&daemon_info::DaemonInfo {
            pid: std::process::id() as i32, port, token, root,
        });
        let state = AppState {
            presence: Arc::default(), broker: Arc::default(), inbox: Arc::default(),
            permission: Arc::default(), plugin_root: plugin_root.into(),
        };
        let router = Router::new().route("/api/token", any(self::token))
            .merge(views::router()).merge(log_stream::router()).merge(transcript::router())
            .merge(broker::router()).merge(inbox::router()).merge(permission::router())
            .merge(codex::router()).merge(opencode::router())
            .fallback(static_files::serve).with_state(state);
        let url = format!("http://localhost:{port}");
        println!("cockpit → {url}");
        open_browser(&url, no_open);
        match axum::serve(listener, router).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => { eprintln!("cockpit: {error}"); ExitCode::FAILURE }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn port_matches_javascript_parse_int_and_valid_range() {
        for (input, expected) in [
            ("42extra", Some(42)),
            (" +123", Some(123)),
            ("0", None),
            ("65536", None),
            ("-1", None),
            ("bad", None),
            ("65535", Some(65535)),
        ] {
            assert_eq!(parse_port(input), expected);
        }
    }
}
