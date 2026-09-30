use crate::{paths, process_alive::is_alive};
use serde_json::Value;
use std::{
    fs,
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
};
use tokio::time::{Duration, Instant, sleep};

// Give the detached server the same startup grace period as the Bun channel.
const STARTUP_BUDGET: Duration = Duration::from_secs(3);
// Discover a just-written daemon record without busy polling.
const STARTUP_POLL: Duration = Duration::from_millis(100);
// Pad instant timeout responses to avoid hammering the daemon.
pub const POLL_FLOOR_MS: u64 = 1000;
// Desynchronize channels after simultaneous long-poll timeouts.
const POLL_JITTER_MS: f64 = 250.0;
// Bound reconnect latency while a daemon is unavailable.
const MAX_RECONNECT_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonCoords {
    pub port: u16,
    pub token: String,
}
#[derive(Debug)]
pub struct ProcessInfo {
    pub pid: i32,
    // Keep the required process-record interface even though liveness needs only pid.
    #[cfg_attr(not(test), expect(dead_code))]
    pub port: u16,
    pub root: Option<String>,
}

pub fn read_daemon_coords() -> Option<DaemonCoords> {
    read_coords(&paths::daemon_info_path())
}
fn read_coords(path: &Path) -> Option<DaemonCoords> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    Some(DaemonCoords {
        port: u16::try_from(value.get("port")?.as_u64()?).ok()?,
        token: value.get("token")?.as_str()?.to_owned(),
    })
}
pub fn read_process_info(path: &Path) -> Option<ProcessInfo> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    Some(ProcessInfo {
        pid: i32::try_from(value.get("pid")?.as_i64()?).ok()?,
        port: u16::try_from(value.get("port")?.as_u64()?).ok()?,
        root: value.get("root").and_then(Value::as_str).map(str::to_owned),
    })
}
pub use crate::daemon_info::{compare_versions, version_from_root};
pub fn should_supersede_daemon(daemon_root: Option<&str>, my_root: &str) -> bool {
    let Some(root) = daemon_root.filter(|root| *root != my_root) else {
        return false;
    };
    match (version_from_root(my_root), version_from_root(root)) {
        (Some(mine), Some(theirs)) => {
            compare_versions(&mine, &theirs) == std::cmp::Ordering::Greater
        }
        _ => false,
    }
}
fn should_spawn(info: Option<&ProcessInfo>, my_root: &str, alive: impl Fn(i32) -> bool) -> bool {
    info.is_none_or(|info| {
        !alive(info.pid) || should_supersede_daemon(info.root.as_deref(), my_root)
    })
}
pub fn ensure_server(info_path: &Path, my_root: &str) -> bool {
    if !should_spawn(read_process_info(info_path).as_ref(), my_root, is_alive) {
        return false;
    }
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let mut command = Command::new(executable);
    command
        .args(["server", "--no-open"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // setsid detaches the server from the channel's terminal and process group.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    command.spawn().is_ok()
}
pub async fn ensure_cockpit_daemon() -> Option<DaemonCoords> {
    let root = paths::plugin_root().ok()?.join("skills/cockpit/scripts");
    let info_path = paths::daemon_info_path();
    ensure_server(&info_path, &root.to_string_lossy());
    let deadline = Instant::now() + STARTUP_BUDGET;
    loop {
        if let Some(info) = read_process_info(&info_path)
            && is_alive(info.pid)
            && let Some(coords) = read_daemon_coords()
        {
            return Some(coords);
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep(STARTUP_POLL.min(deadline.saturating_duration_since(Instant::now()))).await;
    }
}
pub fn next_reconnect_delay_ms(failures: u32) -> u64 {
    (POLL_FLOOR_MS * (1_u64 << failures.min(5))).min(MAX_RECONNECT_MS)
}
pub fn poll_floor_delay_ms(elapsed_ms: u64, floor_ms: u64, rand: f64) -> u64 {
    let remaining = floor_ms.saturating_sub(elapsed_ms);
    if remaining == 0 {
        0
    } else {
        remaining + (rand * POLL_JITTER_MS).floor() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;
    #[test]
    fn numeric_versions_and_supersede_convergence() {
        let old = "/x/monitor/3.9.0/skills/cockpit/scripts";
        let new = "/x/monitor/3.19.0/skills/cockpit/scripts";
        assert_eq!(version_from_root(new).as_deref(), Some("3.19.0"));
        assert_eq!(
            version_from_root("/repo/packages/monitor/skills/cockpit/scripts"),
            None
        );
        assert_eq!(
            version_from_root(r"C:\monitor\3.19.0\skills").as_deref(),
            Some("3.19.0")
        );
        assert_eq!(compare_versions("3.10.0", "3.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("3.1", "3.1.0"), Ordering::Equal);
        assert!(!should_supersede_daemon(Some(new), new));
        assert!(should_supersede_daemon(Some(old), new));
        assert!(!should_supersede_daemon(Some(new), old));
        assert!(!should_supersede_daemon(Some("/repo/scripts"), new));
        assert!(!should_supersede_daemon(None, new));
        assert!(should_spawn(None, new, |_| true));
        let info = ProcessInfo {
            pid: 1,
            port: 42,
            root: Some(old.into()),
        };
        assert!(should_spawn(Some(&info), old, |_| false));
        assert!(!should_spawn(Some(&info), old, |_| true));
        assert!(should_spawn(Some(&info), new, |_| true));
        assert!(!should_supersede_daemon(Some(new), old));
    }
    #[test]
    fn backoff_and_floor() {
        assert_eq!(
            (0..8).map(next_reconnect_delay_ms).collect::<Vec<_>>(),
            vec![1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
        );
        assert_eq!(poll_floor_delay_ms(1000, 1000, 0.5), 0);
        assert_eq!(poll_floor_delay_ms(1100, 1000, 0.5), 0);
        assert_eq!(poll_floor_delay_ms(100, 1000, 0.5), 1025);
    }
    #[test]
    fn records_validate_fields_and_read_fresh() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let file = dir.path().join("daemon.json");
        assert!(read_coords(&file).is_none());
        for value in [
            r#"{"port":"42","token":"t","pid":1}"#,
            r#"{"port":42,"token":0,"pid":1}"#,
            "garbage",
        ] {
            fs::write(&file, value).unwrap();
            assert!(read_coords(&file).is_none());
        }
        fs::write(&file, r#"{"port":42,"token":"t","pid":1,"root":4}"#).unwrap();
        assert_eq!(read_coords(&file).unwrap().token, "t");
        let info = read_process_info(&file).unwrap();
        assert_eq!(info.port, 42);
        assert_eq!(info.root, None);
        fs::write(&file, r#"{"port":43,"token":"new","pid":"1"}"#).unwrap();
        assert_eq!(read_coords(&file).unwrap().token, "new");
        assert!(read_process_info(&file).is_none());
    }
}
