pub use crate::daemon_info::{DaemonCoords, read_daemon_coords};
use crate::{
    daemon_info::{self, PartialDaemonInfo, should_supersede_daemon},
    process_alive::is_alive,
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

fn should_spawn(
    info: Option<&PartialDaemonInfo>,
    my_root: &str,
    alive: impl Fn(i32) -> bool,
) -> bool {
    info.is_none_or(|info| {
        !info.pid.is_some_and(&alive) || should_supersede_daemon(info.root.as_deref(), my_root)
    })
}
pub fn ensure_server(my_root: &str) -> bool {
    should_spawn(daemon_info::read_process_info().as_ref(), my_root, is_alive)
        && daemon_info::spawn_detached_server(&["--no-open"])
            .map(crate::process_alive::reap_in_background)
            .is_ok()
}
pub async fn ensure_cockpit_daemon() -> Option<DaemonCoords> {
    ensure_server(&daemon_info::daemon_root().ok()?);
    let deadline = Instant::now() + STARTUP_BUDGET;
    loop {
        if let Some(info) = daemon_info::read_process_info()
            && info.pid.is_some_and(is_alive)
            && let Some(coords) = info.coords()
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
    use crate::{
        daemon_info::{compare_versions, version_from_root},
        paths,
    };
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
        let info = PartialDaemonInfo {
            pid: Some(1),
            port: Some(42),
            token: None,
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
        let fixture = crate::paths::tests::TestEnv::new();
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", fixture.dir.path());
        let file = paths::daemon_info_path();
        assert!(read_daemon_coords().is_none());
        for value in [
            r#"{"port":"42","token":"t","pid":1}"#,
            r#"{"port":42,"token":0,"pid":1}"#,
            "garbage",
        ] {
            std::fs::write(&file, value).unwrap();
            assert!(read_daemon_coords().is_none());
        }
        std::fs::write(&file, r#"{"port":42,"token":"t","pid":1,"root":4}"#).unwrap();
        assert_eq!(read_daemon_coords().unwrap().token, "t");
        let info = daemon_info::read_process_info().unwrap();
        assert_eq!(info.port, Some(42));
        assert_eq!(info.root, None);
        std::fs::write(&file, r#"{"port":43,"token":"new","pid":"1"}"#).unwrap();
        assert_eq!(read_daemon_coords().unwrap().token, "new");
        assert!(daemon_info::read_process_info().is_none());
    }
}
