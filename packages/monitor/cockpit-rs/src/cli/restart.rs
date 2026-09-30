use super::{broker_client, flag_value};
use crate::{
    daemon_info::{self, StartupDecision},
    process_alive,
};
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};
use tokio::time::sleep;

pub fn run(rest: &[String]) -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let result = match runtime {
        Ok(rt) => rt.block_on(restart(rest)),
        Err(e) => Err(format!("cockpit restart: {e}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
async fn restart(rest: &[String]) -> Result<(), String> {
    let root = daemon_info::daemon_root()?;
    let client = broker_client::client()?;
    if let Some(pid) = daemon_info::read_daemon_info()
        .and_then(|d| d.pid)
        .filter(|p| process_alive::is_alive(*p))
    {
        process_alive::terminate(pid);
    }
    for attempt in 1..=4 {
        // Rust spawns its own exe instead of bun cockpit-server.ts; this is the sole intended behavioral difference.
        let mut args = Vec::new();
        if let Some(port) = flag_value(rest, "port") {
            args.extend(["--port", port]);
        }
        if attempt > 1 || rest.iter().any(|s| s == "--no-open") {
            args.push("--no-open");
        }
        let mut child = daemon_info::spawn_detached_server(&args)
            .map_err(|e| format!("cockpit restart: {e}"))?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(4) {
            sleep(Duration::from_millis(100)).await;
            let snapshot = daemon_info::read_daemon_info();
            match daemon_info::decide_startup(snapshot.as_ref(), &root, process_alive::is_alive) {
                StartupDecision::Reuse(info) => {
                    if let Some(port) = info.port
                        && let Ok(res) = client
                            .get(format!("http://127.0.0.1:{port}/api/token"))
                            .timeout(Duration::from_millis(800))
                            .send()
                            .await
                        && (res.status().is_success() || res.status().as_u16() == 503)
                    {
                        println!(
                            "cockpit: daemon restarted → http://localhost:{port} (pid {})\n  serving: {root}",
                            info.pid.unwrap_or_default()
                        );
                        return Ok(());
                    }
                }
                StartupDecision::Supersede(info) => {
                    if let Some(pid) = info.pid {
                        process_alive::terminate(pid);
                    }
                    break;
                }
                StartupDecision::Start => {}
            }
            let _ = child.try_wait();
        }
    }
    Err("cockpit restart: could not confirm a fresh daemon from this install — a respawn from another install may be contending for the port. Retry, or restart the Claude session so its channel uses the updated plugin.".into())
}
