use crate::paths::{cockpit_home, registry_path};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(transparent)]
pub struct RegistryEntry {
    pub raw: Map<String, Value>,
}

impl RegistryEntry {
    fn string(&self, key: &str) -> &str {
        self.raw.get(key).and_then(Value::as_str).unwrap_or("")
    }
    pub fn provider(&self) -> Provider {
        match self.string("provider") {
            "codex" => Provider::Codex,
            "opencode" => Provider::Opencode,
            _ => Provider::Claude,
        }
    }
    pub fn project(&self) -> &str {
        self.string("project")
    }
    pub fn session_id(&self) -> &str {
        self.string("sessionId")
    }
    pub fn title(&self) -> Option<&str> {
        self.raw.get("title").and_then(Value::as_str)
    }
    pub fn title_resolved(&self) -> bool {
        self.raw.get("titleResolved") == Some(&Value::Bool(true))
    }
    pub fn log_path(&self) -> &str {
        self.string("logPath")
    }
    pub fn last_heartbeat(&self) -> &str {
        self.string("lastHeartbeat")
    }
    pub fn set(&mut self, key: &str, value: Value) {
        self.raw.insert(key.to_owned(), value);
    }
    pub fn new(
        provider: Provider,
        project: &str,
        session_id: &str,
        log_path: &str,
        last_heartbeat: &str,
    ) -> Self {
        let mut entry = Self { raw: Map::new() };
        for (key, value) in [
            ("provider", provider.as_str()),
            ("project", project),
            ("sessionId", session_id),
            ("logPath", log_path),
            ("lastHeartbeat", last_heartbeat),
        ] {
            entry.set(key, Value::String(value.to_owned()));
        }
        entry
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Ended,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveStatus {
    Working,
    Waiting,
    YourCall,
    Idle,
    Shell,
    Ended,
}

pub struct TitleUpdate {
    pub provider: Provider,
    pub session_id: String,
    pub title: String,
}

pub const STALE_MS: i64 = 10 * 60 * 1000;
pub const REGISTRY_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;

pub fn read_registry() -> Vec<RegistryEntry> {
    let Some(value) = fs::read_to_string(registry_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    else {
        return Vec::new();
    };
    let Some(sessions) = value.get("sessions").and_then(Value::as_array) else {
        return Vec::new();
    };
    sessions
        .iter()
        .filter_map(|value| {
            let mut entry: RegistryEntry = serde_json::from_value(value.clone()).ok()?;
            entry.raw.get("sessionId")?.as_str()?;
            entry.set(
                "provider",
                Value::String(entry.provider().as_str().to_owned()),
            );
            Some(entry)
        })
        .collect()
}

fn last_signal_ms(entry: &RegistryEntry) -> i64 {
    let heartbeat = parse_timestamp(entry.last_heartbeat()).unwrap_or(0);
    let mtime = fs::metadata(entry.log_path())
        .and_then(|m| m.modified())
        .ok()
        .map(system_ms)
        .unwrap_or(0);
    heartbeat.max(mtime)
}

pub fn status_of(entry: &RegistryEntry, now_ms: i64) -> SessionStatus {
    if now_ms.saturating_sub(last_signal_ms(entry)) < STALE_MS {
        SessionStatus::Active
    } else {
        SessionStatus::Ended
    }
}

pub fn derive_live_status(active: bool, open_call: bool, harness: Option<&str>) -> LiveStatus {
    if !active {
        return LiveStatus::Ended;
    }
    if open_call {
        return LiveStatus::YourCall;
    }
    match harness {
        Some("busy") => LiveStatus::Working,
        Some("waiting") => LiveStatus::Waiting,
        Some("shell") => LiveStatus::Shell,
        _ => LiveStatus::Idle,
    }
}

fn persist(entries: Vec<RegistryEntry>) {
    #[derive(Serialize)]
    struct Registry {
        sessions: Vec<RegistryEntry>,
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        fs::create_dir_all(cockpit_home())?;
        fs::write(
            registry_path(),
            serde_json::to_string_pretty(&Registry { sessions: entries })?,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        panic!("cockpit: cannot write registry: {error}");
    }
}

pub fn write_registry(mut entries: Vec<RegistryEntry>, now_ms: i64) {
    entries.retain(|e| now_ms.saturating_sub(last_signal_ms(e)) < REGISTRY_TTL_MS);
    persist(entries);
}

// no lock, same as TS; add a lockfile if two writers ever lose an update
pub fn upsert_session(entry: RegistryEntry) {
    let mut entries = read_registry();
    if let Some(old) = entries
        .iter_mut()
        .find(|e| e.session_id() == entry.session_id())
    {
        for (key, value) in entry.raw {
            old.set(&key, value);
        }
    } else {
        entries.push(entry);
    }
    write_registry(entries, now_ms());
}

pub fn refresh_heartbeat(project: &str, session_id: &str, provider: Provider, log_path: &str) {
    let mut entries = read_registry();
    let now = now_ms();
    let heartbeat = iso_timestamp(now);
    if let Some(entry) = entries.iter_mut().find(|e| e.session_id() == session_id) {
        for (key, value) in [
            ("provider", provider.as_str()),
            ("project", project),
            ("logPath", log_path),
            ("lastHeartbeat", &heartbeat),
        ] {
            entry.set(key, Value::String(value.to_owned()));
        }
        write_registry(entries, now);
    } else {
        upsert_session(RegistryEntry::new(
            provider, project, session_id, log_path, &heartbeat,
        ));
    }
}

pub fn persist_title_updates(updates: &[TitleUpdate]) {
    if updates.is_empty() {
        return;
    }
    let mut entries = read_registry();
    let mut changed = false;
    for update in updates {
        let Some(entry) = entries
            .iter_mut()
            .find(|e| e.provider() == update.provider && e.session_id() == update.session_id)
        else {
            continue;
        };
        if !update.title.is_empty() && entry.title() != Some(update.title.as_str()) {
            entry.set("title", Value::String(update.title.clone()));
            changed = true;
        }
        if !entry.title_resolved() {
            entry.set("titleResolved", Value::Bool(true));
            changed = true;
        }
    }
    if changed {
        persist(entries);
    }
}

fn system_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    }
}

pub fn now_ms() -> i64 {
    system_ms(SystemTime::now())
}

pub fn iso_timestamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000) as libc::time_t;
    // gmtime_r writes every calendar field into the supplied storage without shared state.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut tm) }.is_null() {
        panic!("cockpit: heartbeat is outside the UTC calendar range");
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        ms.rem_euclid(1000)
    )
}

fn parse_timestamp(text: &str) -> Option<i64> {
    fn number(text: &str, start: usize, end: usize) -> Option<i32> {
        let part = text.get(start..end)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    }
    let bytes = text.as_bytes();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let year = number(text, 0, 4)?;
    let month = number(text, 5, 7)?;
    let day = number(text, 8, 10)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute, second, mut pos) = if text.len() == 10 {
        (0, 0, 0, 10)
    } else {
        if bytes.get(10) != Some(&b'T')
            || bytes.get(13) != Some(&b':')
            || bytes.get(16) != Some(&b':')
        {
            return None;
        }
        (
            number(text, 11, 13)?,
            number(text, 14, 16)?,
            number(text, 17, 19)?,
            19,
        )
    };
    if !(0..=24).contains(&hour) || !(0..60).contains(&minute) || !(0..60).contains(&second) {
        return None;
    }
    let mut millis = 0;
    if bytes.get(pos) == Some(&b'.') {
        pos += 1;
        let start = pos;
        while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if pos == start {
            return None;
        }
        for i in 0..3 {
            millis = millis * 10
                + bytes
                    .get(start + i)
                    .filter(|_| start + i < pos)
                    .map_or(0, |b| i32::from(b - b'0'));
        }
    }
    if hour == 24 && (minute != 0 || second != 0 || millis != 0) {
        return None;
    }
    let offset = match bytes.get(pos) {
        None if text.len() == 10 => 0,
        Some(b'Z') if pos + 1 == text.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if pos + 6 == text.len() && bytes.get(pos + 3) == Some(&b':') =>
        {
            let hours = number(text, pos + 1, pos + 3)?;
            let minutes = number(text, pos + 4, pos + 6)?;
            if hours >= 24 || minutes >= 60 {
                return None;
            }
            (hours * 60 + minutes) * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    // timegm handles UTC calendar arithmetic, including the TS rollover of days 29–31.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900;
    tm.tm_mon = month - 1;
    tm.tm_mday = day;
    tm.tm_hour = hour;
    tm.tm_min = minute;
    tm.tm_sec = second;
    let seconds = unsafe { libc::timegm(&mut tm) };
    Some(seconds as i64 * 1000 + i64::from(millis) - i64::from(offset) * 60_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use serde_json::json;
    use std::fs::{File, FileTimes};
    use std::time::Duration;

    fn fixture() -> TestEnv {
        let env = TestEnv::new();
        TestEnv::set("COCKPIT_HOME", env.dir.path().join("cockpit"));
        env
    }

    fn seed(value: Value) {
        fs::create_dir_all(cockpit_home()).unwrap();
        fs::write(registry_path(), value.to_string()).unwrap();
    }

    fn entry(sid: &str, heartbeat: i64) -> RegistryEntry {
        RegistryEntry::new(
            Provider::Claude,
            "/project",
            sid,
            "/missing",
            &iso_timestamp(heartbeat),
        )
    }

    #[test]
    fn read_missing_corrupt_and_non_array() {
        let _env = fixture();
        assert!(read_registry().is_empty());
        fs::create_dir_all(cockpit_home()).unwrap();
        fs::write(registry_path(), "{not json").unwrap();
        assert!(read_registry().is_empty());
        for value in [json!(null), json!({}), json!({"sessions": {}})] {
            seed(value);
            assert!(read_registry().is_empty());
        }
    }

    #[test]
    fn read_normalizes_each_entry_without_losing_good_neighbors() {
        let _env = fixture();
        seed(
            json!({"sessions": [null, 4, "bad", [], {}, {"sessionId": 1},
            {"sessionId":"legacy"}, {"sessionId":"unknown", "provider":"other"},
            {"sessionId":"codex", "provider":"codex"},
            {"sessionId":"opencode", "provider":"opencode"},
            {"sessionId":"wrong", "provider":false, "project":12, "title":true}]}),
        );
        let entries = read_registry();
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries
                .iter()
                .map(RegistryEntry::provider)
                .collect::<Vec<_>>(),
            [
                Provider::Claude,
                Provider::Claude,
                Provider::Codex,
                Provider::Opencode,
                Provider::Claude
            ]
        );
        assert_eq!(entries[0].raw["provider"], "claude");
        assert_eq!(entries[4].project(), "");
        assert_eq!(entries[4].title(), None);
    }

    #[test]
    fn flat_entry_round_trip_is_byte_identical() {
        let raw = r#"{"extra":{"x":1},"sessionId":"s","provider":"codex","project":"/p","title":"hello","titleResolved":true,"logPath":"/l","lastHeartbeat":"2026-09-30T12:00:00.000Z"}"#;
        let e: RegistryEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_string(&e).unwrap(), raw);
        assert_eq!(e.title(), Some("hello"));
        assert!(e.title_resolved());
        assert_eq!(e.session_id(), "s");
        assert_eq!(e.log_path(), "/l");
    }

    #[test]
    fn status_uses_freshest_signal_and_exact_ten_minute_boundary() {
        let env = fixture();
        let now = 1_800_000_000_000;
        assert_eq!(status_of(&entry("fresh", now), now), SessionStatus::Active);
        assert_eq!(
            status_of(&entry("edge", now - STALE_MS), now),
            SessionStatus::Ended
        );
        assert_eq!(
            status_of(&entry("inside", now - STALE_MS + 1), now),
            SessionStatus::Active
        );
        assert_eq!(
            status_of(&entry("old", now - 20 * 60 * 1000), now),
            SessionStatus::Ended
        );
        assert_eq!(
            status_of(&entry("future", now + 1), now),
            SessionStatus::Active
        );
        let log = env.dir.path().join("log");
        let file = File::create(&log).unwrap();
        file.set_times(
            FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(now as u64)),
        )
        .unwrap();
        let mut e = entry("mtime", 0);
        e.set("logPath", json!(log));
        e.set("lastHeartbeat", json!("garbage"));
        assert_eq!(status_of(&e, now), SessionStatus::Active);
        file.set_times(
            FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_millis((now - 20 * 60 * 1000) as u64)),
        )
        .unwrap();
        assert_eq!(status_of(&e, now), SessionStatus::Ended);
        e.set("lastHeartbeat", json!(iso_timestamp(now)));
        assert_eq!(status_of(&e, now), SessionStatus::Active);
    }

    #[test]
    fn live_status_priority_and_serialized_vocabulary() {
        for harness in [
            None,
            Some("busy"),
            Some("waiting"),
            Some("shell"),
            Some("unknown"),
        ] {
            for call in [true, false] {
                assert_eq!(derive_live_status(false, call, harness), LiveStatus::Ended);
            }
            assert_eq!(
                derive_live_status(true, true, harness),
                LiveStatus::YourCall
            );
        }
        for (harness, status, text) in [
            (Some("busy"), LiveStatus::Working, "working"),
            (Some("waiting"), LiveStatus::Waiting, "waiting"),
            (Some("shell"), LiveStatus::Shell, "shell"),
            (Some("unknown"), LiveStatus::Idle, "idle"),
            (None, LiveStatus::Idle, "idle"),
        ] {
            assert_eq!(derive_live_status(true, false, harness), status);
            assert_eq!(serde_json::to_value(status).unwrap(), text);
        }
        assert_eq!(
            serde_json::to_value(LiveStatus::YourCall).unwrap(),
            "your-call"
        );
        assert_eq!(serde_json::to_value(LiveStatus::Ended).unwrap(), "ended");
        assert_eq!(
            serde_json::to_value(SessionStatus::Active).unwrap(),
            "active"
        );
    }

    #[test]
    fn writer_reaps_by_max_signal_and_formats_without_newline() {
        let env = fixture();
        let now = 1_800_000_000_000;
        let log = env.dir.path().join("log");
        let file = File::create(&log).unwrap();
        file.set_times(
            FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(now as u64)),
        )
        .unwrap();
        let mut mtime = entry("mtime", now - 20 * 86_400_000);
        mtime.set("logPath", json!(log));
        let mut invalid = entry("invalid", now);
        invalid.set("lastHeartbeat", json!("not-a-date"));
        write_registry(
            vec![
                entry("stale", now - 20 * 86_400_000),
                entry("recent", now - 2 * 86_400_000),
                entry("exact-ttl", now - REGISTRY_TTL_MS),
                entry("inside-ttl", now - REGISTRY_TTL_MS + 1),
                entry("new", now),
                mtime,
                invalid,
            ],
            now,
        );
        assert_eq!(
            read_registry()
                .iter()
                .map(RegistryEntry::session_id)
                .collect::<Vec<_>>(),
            ["recent", "inside-ttl", "new", "mtime"]
        );
        write_registry(vec![entry("s", now)], now);
        let expected = format!(
            "{{\n  \"sessions\": [\n    {{\n      \"provider\": \"claude\",\n      \"project\": \"/project\",\n      \"sessionId\": \"s\",\n      \"logPath\": \"/missing\",\n      \"lastHeartbeat\": \"{}\"\n    }}\n  ]\n}}",
            iso_timestamp(now)
        );
        assert_eq!(fs::read_to_string(registry_path()).unwrap(), expected);
    }

    #[test]
    fn upsert_and_heartbeat_preserve_order_unknown_keys_and_title() {
        let _env = fixture();
        let mut original = Map::new();
        for (key, value) in [
            ("unknown", json!({"nested":true})),
            ("title", json!("Kept title")),
            ("sessionId", json!("s")),
            ("titleResolved", json!(true)),
            ("project", json!("/old/sub")),
            ("logPath", json!("/old/sub/.cockpit/logs/s.jsonl")),
            ("lastHeartbeat", json!(iso_timestamp(now_ms()))),
            ("provider", json!("claude")),
        ] {
            original.insert(key.into(), value);
        }
        let keys = original.keys().cloned().collect::<Vec<_>>();
        seed(json!({"sessions": [original]}));
        upsert_session(RegistryEntry::new(
            Provider::Codex,
            "/new",
            "s",
            "/new/log",
            &iso_timestamp(now_ms()),
        ));
        let updated = &read_registry()[0];
        assert_eq!(updated.raw.keys().cloned().collect::<Vec<_>>(), keys);
        assert_eq!(updated.raw["unknown"], json!({"nested":true}));
        assert_eq!(updated.title(), Some("Kept title"));
        assert_eq!(updated.provider(), Provider::Codex);
        refresh_heartbeat(
            "/repo",
            "s",
            Provider::Opencode,
            "/repo/.cockpit/logs/s.jsonl",
        );
        let updated = &read_registry()[0];
        assert_eq!(updated.raw.keys().cloned().collect::<Vec<_>>(), keys);
        assert_eq!(updated.raw["unknown"], json!({"nested":true}));
        assert_eq!(updated.title(), Some("Kept title"));
        assert!(updated.title_resolved());
        assert_eq!(updated.project(), "/repo");
        assert_eq!(updated.provider(), Provider::Opencode);
        assert_eq!(updated.log_path(), "/repo/.cockpit/logs/s.jsonl");
        assert!(parse_timestamp(updated.last_heartbeat()).unwrap() >= now_ms() - 1000);
    }

    #[test]
    fn heartbeat_auto_registers_and_refreshes_existing_timestamp() {
        let _env = fixture();
        let before = now_ms();
        refresh_heartbeat("/repo", "new", Provider::Codex, "/repo/log");
        let e = &read_registry()[0];
        assert_eq!(e.provider(), Provider::Codex);
        assert_eq!(e.project(), "/repo");
        assert_eq!(e.log_path(), "/repo/log");
        assert!(parse_timestamp(e.last_heartbeat()).unwrap() >= before);
        let mut old = e.clone();
        old.set("lastHeartbeat", json!("1970-01-01T00:00:00.000Z"));
        seed(json!({"sessions": [old]}));
        refresh_heartbeat("/repo", "new", Provider::Claude, "/repo/log");
        assert!(parse_timestamp(read_registry()[0].last_heartbeat()).unwrap() >= before);
    }

    #[test]
    fn titles_match_provider_write_only_changes_and_do_not_reap() {
        let _env = fixture();
        let mut claude = entry("same", 0);
        claude.set("title", json!("Existing"));
        let mut codex = claude.clone();
        codex.set("provider", json!("codex"));
        seed(json!({"sessions": [claude, codex, entry("other", 0)]}));
        let untouched = fs::read(registry_path()).unwrap();
        persist_title_updates(&[]);
        persist_title_updates(&[TitleUpdate {
            provider: Provider::Opencode,
            session_id: "same".into(),
            title: "No match".into(),
        }]);
        assert_eq!(fs::read(registry_path()).unwrap(), untouched);
        persist_title_updates(&[
            TitleUpdate {
                provider: Provider::Codex,
                session_id: "same".into(),
                title: "New title".into(),
            },
            TitleUpdate {
                provider: Provider::Claude,
                session_id: "same".into(),
                title: String::new(),
            },
        ]);
        let entries = read_registry();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].title(), Some("Existing"));
        assert_eq!(entries[1].title(), Some("New title"));
        assert!(entries[0].title_resolved());
        assert!(entries[1].title_resolved());
        let raw = fs::read_to_string(registry_path()).unwrap();
        assert!(!raw.ends_with('\n'));
        // A compact sentinel proves no write occurred, even on coarse-mtime filesystems.
        seed(json!({"sessions": entries}));
        let raw = fs::read(registry_path()).unwrap();
        persist_title_updates(&[TitleUpdate {
            provider: Provider::Codex,
            session_id: "same".into(),
            title: "New title".into(),
        }]);
        assert_eq!(fs::read(registry_path()).unwrap(), raw);
        persist_title_updates(&[TitleUpdate {
            provider: Provider::Claude,
            session_id: "other".into(),
            title: String::new(),
        }]);
        assert_eq!(read_registry()[2].title(), None);
        assert!(read_registry()[2].title_resolved());
    }

    #[test]
    fn iso_dates_parse_and_format_milliseconds_and_offsets() {
        for (text, ms) in [
            ("1970-01-01T00:00:00.000Z", 0),
            ("2026-09-30T12:00:00.000Z", 1_790_769_600_000),
            ("2026-09-30T20:00:00+08:00", 1_790_769_600_000),
            ("1969-12-31T23:59:59.999Z", -1),
        ] {
            assert_eq!(parse_timestamp(text), Some(ms));
            assert_eq!(parse_timestamp(&iso_timestamp(ms)), Some(ms));
        }
        for text in [
            "",
            "garbage",
            "2026-13-30T12:00:00.000Z",
            "2026-09-30T99:00:00Z",
        ] {
            assert_eq!(parse_timestamp(text), None);
        }
    }
}
