use crate::paths;
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, fs};

#[derive(Serialize, Deserialize, Clone)]
pub struct DaemonInfo {
    pub pid: i32,
    pub port: u16,
    pub token: String,
    pub root: String,
}

#[derive(Deserialize, Default, Clone)]
pub struct PartialDaemonInfo {
    pub pid: Option<i32>,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub root: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonCoords {
    pub port: u16,
    pub token: String,
}

impl PartialDaemonInfo {
    pub fn coords(&self) -> Option<DaemonCoords> {
        Some(DaemonCoords {
            port: self.port?,
            token: self.token.clone()?,
        })
    }
}

#[cfg(test)]
pub fn read_daemon_coords() -> Option<DaemonCoords> {
    read_daemon_info()?.coords()
}

pub enum StartupDecision {
    Reuse(PartialDaemonInfo),
    Supersede(PartialDaemonInfo),
    Start,
}

pub fn read_daemon_info() -> Option<PartialDaemonInfo> {
    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(paths::daemon_info_path()).ok()?).ok()?;
    let record = raw.as_object()?;
    Some(PartialDaemonInfo {
        pid: record
            .get("pid")
            .and_then(|v| v.as_i64())
            .and_then(|v| i32::try_from(v).ok()),
        port: record
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|v| u16::try_from(v).ok()),
        token: record
            .get("token")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        root: record
            .get("root")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
    })
}

// A record without a pid or port counts as no daemon.
pub fn read_process_info() -> Option<PartialDaemonInfo> {
    read_daemon_info().filter(|info| info.pid.is_some() && info.port.is_some())
}

pub fn write_daemon_info(info: &DaemonInfo) {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(paths::cockpit_home())?;
        fs::write(
            paths::daemon_info_path(),
            serde_json::to_string_pretty(info)? + "\n",
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        panic!("cockpit: cannot write daemon info: {error}");
    }
}

pub fn decide_startup(
    info: Option<&PartialDaemonInfo>,
    my_root: &str,
    alive: impl Fn(i32) -> bool,
) -> StartupDecision {
    let Some(info) = info else {
        return StartupDecision::Start;
    };
    if !info.pid.is_some_and(alive) {
        return StartupDecision::Start;
    }
    if info.root.as_deref() == Some(my_root) {
        StartupDecision::Reuse(info.clone())
    } else {
        StartupDecision::Supersede(info.clone())
    }
}

pub fn version_from_root(root: &str) -> Option<String> {
    let segments: Vec<_> = root.split(['/', '\\']).collect();
    for (index, window) in segments.windows(3).enumerate() {
        if window[1] != "monitor" {
            continue;
        }
        // The regex requires a separator after the version as well as before monitor.
        if index + 3 >= segments.len() {
            continue;
        }
        let version = window[2];
        let parts: Vec<_> = version.split('.').collect();
        if parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        {
            return Some(version.to_owned());
        }
    }
    None
}

pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let mut a = a.split('.');
    let mut b = b.split('.');
    for _ in 0..3 {
        let a = a.next().and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0);
        let b = b.next().and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0);
        match a.partial_cmp(&b).unwrap_or(Ordering::Equal) {
            Ordering::Equal => {}
            order => return order,
        }
    }
    Ordering::Equal
}

pub fn should_supersede_daemon(daemon_root: Option<&str>, my_root: &str) -> bool {
    let Some(root) = daemon_root.filter(|root| *root != my_root) else {
        return false;
    };
    let (Some(mine), Some(theirs)) = (version_from_root(my_root), version_from_root(root)) else {
        return false;
    };
    compare_versions(&mine, &theirs) == Ordering::Greater
}

// Keep the TS `<plugin root>/skills/cockpit/scripts` shape so a 5.x channel's version rule reads it.
pub fn daemon_root() -> Result<String, String> {
    Ok(paths::plugin_root()?
        .join("skills/cockpit/scripts")
        .to_string_lossy()
        .into_owned())
}

pub fn spawn_detached_server(args: &[&str]) -> std::io::Result<std::process::Child> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .arg("server")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::process_alive::detach(&mut command).spawn()
}

pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    const ROOT: &str = "/install/a/scripts";
    fn info() -> PartialDaemonInfo {
        PartialDaemonInfo {
            pid: Some(1234),
            port: Some(5858),
            token: Some("tok".into()),
            root: Some(ROOT.into()),
        }
    }
    fn version(v: &str) -> String {
        format!("/cache/monitor/{v}/skills/cockpit/scripts")
    }

    #[test]
    fn startup_matches_every_lifecycle_case() {
        assert!(matches!(
            decide_startup(None, ROOT, |_| panic!("no pid")),
            StartupDecision::Start
        ));
        assert!(matches!(
            decide_startup(Some(&info()), ROOT, |_| false),
            StartupDecision::Start
        ));
        assert!(matches!(
            decide_startup(
                Some(&PartialDaemonInfo {
                    port: Some(5858),
                    ..Default::default()
                }),
                ROOT,
                |_| panic!("no pid")
            ),
            StartupDecision::Start
        ));
        match decide_startup(Some(&info()), ROOT, |_| true) {
            StartupDecision::Reuse(record) => assert_eq!(record.pid, Some(1234)),
            _ => panic!("expected reuse"),
        }
        let mut other = info();
        other.root = Some("/install/b/scripts".into());
        assert!(matches!(
            decide_startup(Some(&other), ROOT, |_| true),
            StartupDecision::Supersede(_)
        ));
        other.root = None;
        match decide_startup(Some(&other), ROOT, |_| true) {
            StartupDecision::Supersede(record) => {
                assert_eq!(record.pid, Some(1234));
                assert_eq!(record.root, None);
            }
            _ => panic!("expected supersede"),
        }
    }

    #[test]
    fn channel_versions_and_supersede_match_ts() {
        let dev = "/repo/packages/monitor/skills/cockpit/scripts";
        assert_eq!(version_from_root(&version("3.18.5")), Some("3.18.5".into()));
        assert_eq!(version_from_root(dev), None);
        assert_eq!(compare_versions("3.19.0", "3.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("3.18.5", "3.18.10"), Ordering::Less);
        assert_eq!(compare_versions("3.18.5", "3.18.5"), Ordering::Equal);
        assert!(!should_supersede_daemon(
            Some(&version("3.19.0")),
            &version("3.19.0")
        ));
        assert!(should_supersede_daemon(
            Some(&version("3.18.4")),
            &version("3.19.0")
        ));
        assert!(!should_supersede_daemon(
            Some(&version("3.19.0")),
            &version("3.18.4")
        ));
        assert!(!should_supersede_daemon(Some(dev), &version("3.19.0")));
        assert!(!should_supersede_daemon(Some(&version("3.19.0")), dev));
        assert!(!should_supersede_daemon(None, &version("3.19.0")));
        assert!(!should_supersede_daemon(Some(""), &version("3.19.0")));
    }

    #[test]
    fn channels_on_different_versions_converge_after_one_supersede() {
        let older = version("3.18.4");
        let newer = version("3.19.0");
        let mut daemon_root = older.clone();
        let mut supersedes = 0;
        for _ in 0..5 {
            if should_supersede_daemon(Some(&daemon_root), &newer) {
                daemon_root = newer.clone();
                supersedes += 1;
            }
            assert!(!should_supersede_daemon(Some(&daemon_root), &older));
        }
        assert_eq!(daemon_root, newer);
        assert_eq!(supersedes, 1);
    }

    #[test]
    fn write_failure_is_reported_like_the_ts_writer() {
        let env = TestEnv::new();
        let blocked = env.dir.path().join("blocked");
        fs::write(&blocked, "file").unwrap();
        TestEnv::set("COCKPIT_HOME", &blocked);
        let info = DaemonInfo {
            pid: 1234,
            port: 5858,
            token: "tok".into(),
            root: ROOT.into(),
        };
        assert!(std::panic::catch_unwind(|| write_daemon_info(&info)).is_err());
    }

    #[test]
    fn version_segment_boundaries_and_missing_parts() {
        assert_eq!(
            version_from_root(r"C:\cache\monitor\3.18.5\scripts"),
            Some("3.18.5".into())
        );
        assert_eq!(
            version_from_root("/monitor/1.2.3/monitor/4.5.6/"),
            Some("1.2.3".into())
        );
        for invalid in [
            "monitor/1.2.3/",
            "/monitor/1.2.3",
            "/monitor/1.2/",
            "/monitor/1.2.3-beta/",
            "/monitor/1.2.3.4/",
        ] {
            assert_eq!(version_from_root(invalid), None, "{invalid}");
        }
        assert_eq!(compare_versions("1", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2", "1.1.99"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.3.99", "1.2.3.0"), Ordering::Equal);
    }

    #[test]
    fn daemon_file_bytes_and_lenient_fields() {
        let env = TestEnv::new();
        TestEnv::set("COCKPIT_HOME", env.dir.path().join("cockpit"));
        assert!(read_daemon_info().is_none());
        let info = DaemonInfo {
            pid: 1234,
            port: 5858,
            token: "tok".into(),
            root: ROOT.into(),
        };
        write_daemon_info(&info);
        assert_eq!(
            fs::read_to_string(paths::daemon_info_path()).unwrap(),
            "{\n  \"pid\": 1234,\n  \"port\": 5858,\n  \"token\": \"tok\",\n  \"root\": \"/install/a/scripts\"\n}\n"
        );
        let read = read_daemon_info().unwrap();
        assert_eq!(read.pid, Some(1234));
        assert_eq!(read.port, Some(5858));
        assert_eq!(read.token.as_deref(), Some("tok"));
        assert_eq!(read.root.as_deref(), Some(ROOT));
        for raw in ["{", "null", "[]", "42"] {
            fs::write(paths::daemon_info_path(), raw).unwrap();
            assert!(read_daemon_info().is_none());
        }
        fs::write(
            paths::daemon_info_path(),
            r#"{"pid":1234,"port":"bad","token":true,"root":null}"#,
        )
        .unwrap();
        let partial = read_daemon_info().unwrap();
        assert_eq!(partial.pid, Some(1234));
        assert_eq!(partial.port, None);
        assert_eq!(partial.token, None);
        assert_eq!(partial.root, None);
        fs::write(paths::daemon_info_path(), "{}").unwrap();
        assert_eq!(read_daemon_info().unwrap().pid, None);
    }

    #[test]
    fn token_has_32_lowercase_hex_characters() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 32);
        assert!(
            a.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_ne!(a, b);
    }
}
