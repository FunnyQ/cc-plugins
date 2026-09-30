// `cockpit atlas serve [--port N] [--no-open]`.
use super::model::{Ctx, now_ms};
use super::{live, pricing, stats};
use crate::server::{json_error, json_response, static_files};
use crate::{paths, process_alive};
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::{Compression, write::GzEncoder};
use serde_json::{Number, Value, json};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;

const DEFAULT_PORT: u16 = 5938;

// ---------- argv ----------

// JavaScript parseInt: optional leading whitespace and sign, then the leading digits.
fn parse_port_value(value: &str) -> Option<u16> {
    let value = value.trim_start();
    let digits = value.strip_prefix('+').unwrap_or(value);
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    digits[..end].parse::<u16>().ok().filter(|port| *port > 0)
}

fn parse_port(args: &[String]) -> u16 {
    args.iter()
        .position(|arg| arg == "--port")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| parse_port_value(value))
        .unwrap_or(DEFAULT_PORT)
}

fn open_browser(url: &str, no_open: bool) {
    if no_open {
        return;
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut command = Command::new(opener);
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    process_alive::detach(&mut command);
    // A spawn failure is ignored: the URL is already printed.
    if let Ok(child) = command.spawn() {
        process_alive::reap_in_background(child);
    }
}

// ---------- startup decision ----------

#[derive(Debug, PartialEq)]
struct AtlasInfo {
    pid: Number,
    port: Number,
    root: String,
}

#[derive(Debug, PartialEq)]
enum Startup {
    Reuse(AtlasInfo),
    Supersede(AtlasInfo),
    Start,
}

// readAtlasInfo checks only `typeof === "number"`, so a fractional port survives to the reuse message.
fn parse_atlas_info(raw: &str) -> Option<AtlasInfo> {
    let value: Value = serde_json::from_str(raw).ok()?;
    match (value.get("pid"), value.get("port"), value.get("root")) {
        (Some(Value::Number(pid)), Some(Value::Number(port)), Some(Value::String(root))) => {
            Some(AtlasInfo {
                pid: pid.clone(),
                port: port.clone(),
                root: root.clone(),
            })
        }
        _ => None,
    }
}

// Bun's process.kill throws on a non-integer pid, which isAlive reads as dead.
fn signal_pid(pid: &Number) -> Option<i32> {
    let pid = pid.as_f64()?;
    (pid.fract() == 0.0 && pid > 0.0 && pid <= f64::from(i32::MAX)).then_some(pid as i32)
}

fn decide_startup(
    info: Option<AtlasInfo>,
    my_root: &str,
    is_alive: impl Fn(i32) -> bool,
) -> Startup {
    let Some(info) = info else {
        return Startup::Start;
    };
    if !signal_pid(&info.pid).is_some_and(is_alive) {
        return Startup::Start;
    }
    if info.root == my_root {
        Startup::Reuse(info)
    } else {
        Startup::Supersede(info)
    }
}

// tokio's OnceCell rather than a Shared future (`futures` is not a dependency): concurrent callers
// await one build, and a failed or cancelled init leaves the cell empty so the next caller rebuilds,
// which is TS's "never cache a rejection" without a separate clear step.
type StatsSlot = Mutex<Option<(String, Arc<OnceCell<Arc<Value>>>)>>;

async fn cached_stats<F, Fut>(
    slot: &StatsSlot,
    fingerprint: &str,
    build: F,
) -> anyhow::Result<Arc<Value>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<Value>>,
{
    let cell = {
        let mut entry = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match entry.as_ref() {
            Some((fp, cell)) if fp == fingerprint => cell.clone(),
            _ => {
                let cell = Arc::new(OnceCell::new());
                *entry = Some((fingerprint.to_owned(), cell.clone()));
                cell
            }
        }
    };
    let value = cell
        .get_or_try_init(|| async { build().await.map(Arc::new) })
        .await?;
    Ok(value.clone())
}

// ---------- handlers ----------

struct App {
    plugin_root: PathBuf,
    dist: PathBuf,
    boot_id: String,
    stats: StatsSlot,
}

impl App {
    // A fresh Ctx per request, so an unset TOKEN_ATLAS_NOW_MS means the clock at request time.
    fn ctx(&self) -> Ctx {
        Ctx {
            now_ms: now_ms(),
            plugin_root: self.plugin_root.clone(),
        }
    }
}

async fn dispatch(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path();
    let result = if path == "/api/stats" {
        handle_stats(&app, req.headers()).await
    } else if path == "/api/live" {
        handle_live(&app).await
    } else if path == "/api/pricing/refresh" && req.method() == Method::POST {
        handle_pricing_refresh(&app, req).await
    } else {
        return static_files::serve_dir(&app.dist, req.uri(), req.headers()).await;
    };
    result.unwrap_or_else(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()))
}

async fn handle_stats(app: &App, request_headers: &HeaderMap) -> anyhow::Result<Response> {
    let ctx = Arc::new(app.ctx());
    let fingerprint = tokio::task::spawn_blocking({
        let ctx = ctx.clone();
        move || stats::fingerprint(&ctx)
    })
    .await?;
    let etag = format!("W/\"{}-{fingerprint}\"", app.boot_id);
    // A 304 must repeat the cache-relevant headers its 200 would have carried.
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::ETAG, HeaderValue::from_str(&etag)?);
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return Ok((StatusCode::NOT_MODIFIED, headers).into_response());
    }
    let payload = cached_stats(&app.stats, &fingerprint, || stats::build(&ctx)).await?;
    let gzip = request_headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("gzip"));
    let body = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let json = serde_json::to_vec(&*payload)?;
        if !gzip {
            return Ok(json);
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
        encoder.write_all(&json)?;
        Ok(encoder.finish()?)
    })
    .await??;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if gzip {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    Ok((headers, body).into_response())
}

// Deliberate TS deviation: TS's one event loop stalled here during a build; this never waits on the stats slot.
async fn handle_live(app: &App) -> anyhow::Result<Response> {
    let ctx = app.ctx();
    let (sessions, cockpit_port) = tokio::task::spawn_blocking(move || {
        (live::live_sessions(&ctx), live::cockpit_daemon_port())
    })
    .await?;
    Ok(json_response(
        StatusCode::OK,
        json!({
            "sessions": sessions,
            "cockpitUp": cockpit_port.is_some(),
            "cockpitPort": cockpit_port,
        }),
    ))
}

async fn handle_pricing_refresh(app: &App, req: Request) -> anyhow::Result<Response> {
    // A missing or invalid body falls back to deriving the model list, as TS's swallowed req.json().
    let body = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let mut models: Vec<String> = body
        .as_ref()
        .and_then(|body| body.get("models"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .collect();
    let ctx = app.ctx();
    // refreshPricingOverride derives from a fresh build whenever the usable list is empty.
    if models.is_empty() {
        models = stats::models_in(&stats::build(&ctx).await?);
    }
    let result = pricing::refresh_pricing_override(&ctx, models).await?;
    Ok(json_response(StatusCode::OK, serde_json::to_value(result)?))
}

// ---------- lifecycle ----------

fn write_atlas_info(home: &Path, port: u16, root: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(home)?;
    let info = json!({ "pid": std::process::id(), "port": port, "root": root });
    let text = serde_json::to_string_pretty(&info).map_err(std::io::Error::other)?;
    std::fs::write(home.join("atlas.json"), format!("{text}\n"))
}

async fn serve(port: u16, plugin_root: PathBuf, my_root: String, no_open: bool) -> ExitCode {
    let listener = match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
    {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!(
                "atlas: port {port} is in use by another process — stop it or pass --port <n>."
            );
            return ExitCode::FAILURE;
        }
        Err(error) => {
            eprintln!("atlas: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(error) = write_atlas_info(&paths::cockpit_home(), port, &my_root) {
        eprintln!("atlas: {error}");
        return ExitCode::FAILURE;
    }
    let app = Arc::new(App {
        dist: plugin_root.join("skills/usage-dashboard/dashboard/dist"),
        plugin_root,
        boot_id: uuid::Uuid::new_v4().simple().to_string(),
        stats: Mutex::new(None),
    });
    let router = Router::new().fallback(dispatch).with_state(app);
    let url = format!("http://localhost:{port}");
    println!("Claude Stats Dashboard → {url}");
    open_browser(&url, no_open);
    match axum::serve(listener, router).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atlas: {error}");
            ExitCode::FAILURE
        }
    }
}

// The startup decision sleeps and signals synchronously, so it runs before any runtime exists.
pub fn run(args: &[String]) -> ExitCode {
    let port = parse_port(args);
    let no_open = args.iter().any(|arg| arg == "--no-open");
    let plugin_root = match paths::plugin_root() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    // The root the retired TS server wrote, so a Rust server reuses one still running from the same install.
    let my_root = plugin_root
        .join("skills/usage-dashboard/scripts")
        .to_string_lossy()
        .into_owned();
    let info = std::fs::read_to_string(paths::cockpit_home().join("atlas.json"))
        .ok()
        .and_then(|raw| parse_atlas_info(&raw));
    match decide_startup(info, &my_root, process_alive::is_alive) {
        Startup::Reuse(info) => {
            println!(
                "Claude Stats Dashboard already running → http://localhost:{} (pid {})",
                info.port, info.pid
            );
            open_browser(&format!("http://localhost:{}", info.port), no_open);
            return ExitCode::SUCCESS;
        }
        Startup::Supersede(info) => {
            println!(
                "superseding stale atlas server (pid {}, root {}) — this install is {my_root}",
                info.pid, info.root
            );
            // terminate's SIGTERM, 1.5 s, SIGKILL, 1 s schedule is waitForExit's exactly.
            if let Some(pid) = signal_pid(&info.pid) {
                process_alive::terminate(pid);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Startup::Start => {}
    }
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(serve(port, plugin_root, my_root, no_open)),
        Err(error) => {
            eprintln!("atlas: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ROOT: &str = "/install/a/scripts";

    fn alive(_: i32) -> bool {
        true
    }

    fn dead(_: i32) -> bool {
        false
    }

    fn decide(raw: &str, is_alive: fn(i32) -> bool) -> Startup {
        decide_startup(parse_atlas_info(raw), ROOT, is_alive)
    }

    fn info(root: &str) -> AtlasInfo {
        AtlasInfo {
            pid: 1234.into(),
            port: 5938.into(),
            root: root.into(),
        }
    }

    #[test]
    fn no_record_starts_fresh() {
        assert_eq!(decide_startup(None, ROOT, alive), Startup::Start);
        assert_eq!(decide("{not json", alive), Startup::Start);
    }

    #[test]
    fn dead_pid_starts_fresh() {
        let raw = r#"{"pid":1234,"port":5938,"root":"/install/a/scripts"}"#;
        assert_eq!(decide(raw, dead), Startup::Start);
    }

    #[test]
    fn missing_or_non_number_pid_starts_fresh() {
        let missing = r#"{"port":5938,"root":"/install/a/scripts"}"#;
        let string = r#"{"pid":"1234","port":5938,"root":"/install/a/scripts"}"#;
        assert_eq!(decide(missing, alive), Startup::Start);
        assert_eq!(decide(string, alive), Startup::Start);
    }

    #[test]
    fn missing_or_non_string_root_starts_fresh_not_supersede() {
        assert_eq!(decide(r#"{"pid":1234,"port":5938}"#, alive), Startup::Start);
        let number = r#"{"pid":1234,"port":5938,"root":7}"#;
        assert_eq!(decide(number, alive), Startup::Start);
    }

    #[test]
    fn alive_same_root_reuses() {
        let raw = r#"{"pid":1234,"port":5938,"root":"/install/a/scripts"}"#;
        assert_eq!(decide(raw, alive), Startup::Reuse(info(ROOT)));
    }

    #[test]
    fn alive_different_root_supersedes() {
        let raw = r#"{"pid":1234,"port":5938,"root":"/install/b/scripts"}"#;
        let expected = Startup::Supersede(info("/install/b/scripts"));
        assert_eq!(decide(raw, alive), expected);
    }

    #[test]
    fn fractional_port_is_kept_and_echoed() {
        let raw = r#"{"pid":1234,"port":5999.5,"root":"/install/a/scripts"}"#;
        let Startup::Reuse(info) = decide(raw, alive) else {
            panic!("expected reuse");
        };
        assert_eq!(info.port.to_string(), "5999.5");
    }

    #[test]
    fn string_port_or_fractional_pid_starts_fresh() {
        let string_port = r#"{"pid":1234,"port":"5938","root":"/install/a/scripts"}"#;
        let fractional_pid = r#"{"pid":1234.5,"port":5938,"root":"/install/a/scripts"}"#;
        assert_eq!(decide(string_port, alive), Startup::Start);
        assert_eq!(decide(fractional_pid, alive), Startup::Start);
    }

    #[test]
    fn port_flag_parses_like_parse_int_within_range() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        for (argv, expected) in [
            (args(&["--port", "6001"]), 6001),
            (args(&["--port", "6001x", "--no-open"]), 6001),
            (args(&["--port", "65535"]), 65535),
            (args(&["--port", "0"]), DEFAULT_PORT),
            (args(&["--port", "65536"]), DEFAULT_PORT),
            (args(&["--port", "-1"]), DEFAULT_PORT),
            (args(&["--port", "garbage"]), DEFAULT_PORT),
            (args(&["--port", ""]), DEFAULT_PORT),
            (args(&["--port"]), DEFAULT_PORT),
            (args(&["--port", "--no-open"]), DEFAULT_PORT),
            (args(&["--no-open"]), DEFAULT_PORT),
            (args(&[]), DEFAULT_PORT),
            (args(&["--port", "7001", "--port", "7002"]), 7001),
        ] {
            assert_eq!(parse_port(&argv), expected, "{argv:?}");
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn concurrent_requests_for_one_fingerprint_share_one_build() {
        let slot: StatsSlot = Mutex::new(None);
        let builds = AtomicUsize::new(0);
        let build = || async {
            builds.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(json!({"n": 1}))
        };
        runtime().block_on(async {
            let (a, b) = tokio::join!(
                cached_stats(&slot, "1:1", build),
                cached_stats(&slot, "1:1", build)
            );
            assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
            assert_eq!(builds.load(Ordering::SeqCst), 1);
            cached_stats(&slot, "1:1", build).await.unwrap();
            assert_eq!(builds.load(Ordering::SeqCst), 1, "same fingerprint reuses");
            cached_stats(&slot, "2:2", build).await.unwrap();
            assert_eq!(builds.load(Ordering::SeqCst), 2, "new fingerprint rebuilds");
        });
    }

    #[test]
    fn failed_build_is_not_cached() {
        let slot: StatsSlot = Mutex::new(None);
        let builds = AtomicUsize::new(0);
        runtime().block_on(async {
            let failed = cached_stats(&slot, "1:1", || async {
                builds.fetch_add(1, Ordering::SeqCst);
                Err(anyhow::anyhow!("boom"))
            })
            .await;
            assert_eq!(failed.unwrap_err().to_string(), "boom");
            let retried = cached_stats(&slot, "1:1", || async {
                builds.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"n": 2}))
            })
            .await
            .unwrap();
            assert_eq!(*retried, json!({"n": 2}));
            assert_eq!(builds.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn atlas_json_matches_the_ts_writer() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("cockpit");
        write_atlas_info(&home, 6001, "/x/skills/usage-dashboard/scripts").unwrap();
        let text = std::fs::read_to_string(home.join("atlas.json")).unwrap();
        let expected = format!(
            "{{\n  \"pid\": {},\n  \"port\": 6001,\n  \"root\": \"/x/skills/usage-dashboard/scripts\"\n}}\n",
            std::process::id()
        );
        assert_eq!(text, expected);
    }
}
