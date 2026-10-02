use crate::{
    daemon_info::{self, PartialDaemonInfo, should_supersede_daemon},
    process_alive::{self, is_alive},
};
use std::{
    process::ExitCode,
    thread::sleep,
    time::{Duration, Instant},
};

// Give the detached server the same startup grace period the Bun channel had.
const STARTUP_BUDGET: Duration = Duration::from_secs(3);
// Discover a just-written daemon record without busy polling.
const STARTUP_POLL: Duration = Duration::from_millis(100);

fn should_spawn(
    info: Option<&PartialDaemonInfo>,
    my_root: &str,
    alive: impl Fn(i32) -> bool,
) -> bool {
    info.is_none_or(|info| {
        !info.pid.is_some_and(&alive) || should_supersede_daemon(info.root.as_deref(), my_root)
    })
}
fn ensure_server(my_root: &str) -> bool {
    should_spawn(daemon_info::read_process_info().as_ref(), my_root, is_alive)
        && daemon_info::spawn_detached_server(&["--no-open"])
            .map(process_alive::reap_in_background)
            .is_ok()
}

pub fn run() -> ExitCode {
    match ensure() {
        Ok(coords) => {
            println!(
                "{}",
                serde_json::json!({"port": coords.port, "token": coords.token})
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("cockpit ensure-daemon: {e}");
            ExitCode::FAILURE
        }
    }
}
fn ensure() -> Result<daemon_info::DaemonCoords, String> {
    ensure_server(&daemon_info::daemon_root()?);
    let deadline = Instant::now() + STARTUP_BUDGET;
    loop {
        if let Some(info) = daemon_info::read_process_info()
            && info.pid.is_some_and(is_alive)
            && let Some(coords) = info.coords()
        {
            return Ok(coords);
        }
        if Instant::now() >= deadline {
            return Err("no live daemon within 3s".into());
        }
        sleep(STARTUP_POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        daemon_info::{compare_versions, read_daemon_coords, version_from_root},
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
