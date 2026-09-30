use super::{broker_client, flag_value};
use crate::{daemon_info, paths, process_alive};
use std::{
    os::unix::process::CommandExt,
    process::{Command, ExitCode, Stdio},
    time::{Duration, Instant},
};
use tokio::time::sleep;

#[derive(Debug, PartialEq, Eq)]
pub enum DaemonKind {
    Ours,
    Foreign,
    Absent,
}
pub fn classify_daemon(
    pid: Option<i64>,
    root: Option<&str>,
    my_root: &str,
    is_alive: impl Fn(i64) -> bool,
) -> DaemonKind {
    if !pid.is_some_and(is_alive) {
        DaemonKind::Absent
    } else if root == Some(my_root) {
        DaemonKind::Ours
    } else {
        DaemonKind::Foreign
    }
}
fn read_daemon_file() -> Option<daemon_info::PartialDaemonInfo> {
    daemon_info::read_daemon_info()
}
async fn stop_pid(pid: i32) {
    // A failed signal means the daemon has already gone, matching the TS best effort stop.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return;
    }
    for _ in 0..30 {
        if !process_alive::is_alive(pid) {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    for _ in 0..20 {
        if !process_alive::is_alive(pid) {
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
}
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
    let root = paths::plugin_root()?
        .join("skills/cockpit/scripts")
        .to_string_lossy()
        .into_owned();
    let exe = std::env::current_exe().map_err(|e| format!("cockpit restart: {e}"))?;
    let client = broker_client::client()?;
    if let Some(pid) = read_daemon_file()
        .and_then(|d| d.pid)
        .filter(|p| process_alive::is_alive(*p))
    {
        stop_pid(pid).await;
    }
    for attempt in 1..=4 {
        // Rust spawns its own exe instead of bun cockpit-server.ts; this is the sole intended behavioral difference.
        let mut cmd = Command::new(&exe);
        cmd.arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(port) = flag_value(rest, "port") {
            cmd.args(["--port", port]);
        }
        if attempt > 1 || rest.iter().any(|s| s == "--no-open") {
            cmd.arg("--no-open");
        }
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().map_err(|e| format!("cockpit restart: {e}"))?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(4) {
            sleep(Duration::from_millis(100)).await;
            let snapshot = read_daemon_file();
            let pid = snapshot.as_ref().and_then(|s| s.pid);
            let kind = classify_daemon(
                pid.map(i64::from),
                snapshot.as_ref().and_then(|s| s.root.as_deref()),
                &root,
                |p| i32::try_from(p).is_ok_and(process_alive::is_alive),
            );
            match kind {
                DaemonKind::Ours => {
                    if let Some(d) = broker_client::read_daemon()
                        && let Ok(res) = client
                            .get(format!("http://127.0.0.1:{}/api/token", d.port))
                            .timeout(Duration::from_millis(800))
                            .send()
                            .await
                        && (res.status().is_success() || res.status().as_u16() == 503)
                    {
                        println!(
                            "cockpit: daemon restarted → http://localhost:{} (pid {})\n  serving: {root}",
                            d.port,
                            pid.unwrap_or_default()
                        );
                        return Ok(());
                    }
                }
                DaemonKind::Foreign => {
                    if let Some(pid) = pid {
                        stop_pid(pid).await;
                    }
                    break;
                }
                DaemonKind::Absent => {}
            }
            let _ = child.try_wait();
        }
    }
    Err("cockpit restart: could not confirm a fresh daemon from this install — a respawn from another install may be contending for the port. Retry, or restart the Claude session so its channel uses the updated plugin.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_without_record() {
        assert_eq!(
            classify_daemon(None, None, "ours", |_| panic!("no pid")),
            DaemonKind::Absent
        );
    }
    #[test]
    fn absent_without_numeric_pid() {
        assert_eq!(
            classify_daemon(None, Some("ours"), "ours", |_| panic!("no pid")),
            DaemonKind::Absent
        );
    }
    #[test]
    fn absent_dead_pid() {
        assert_eq!(
            classify_daemon(Some(1), Some("ours"), "ours", |_| false),
            DaemonKind::Absent
        );
    }
    #[test]
    fn ours_live_pid() {
        assert_eq!(
            classify_daemon(Some(1), Some("ours"), "ours", |_| true),
            DaemonKind::Ours
        );
    }
    #[test]
    fn foreign_live_pid() {
        for root in [Some("other"), None] {
            assert_eq!(
                classify_daemon(Some(1), root, "ours", |_| true),
                DaemonKind::Foreign
            );
        }
    }
}
