use super::{AppState, presence::Presence};
use crate::{call_log, config, daemon_info, registry, tunables};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replacement_and_old_guard_cannot_remove_new_park() {
        let parks = Arc::new(Parks::default());
        let (old, first) = parks.park("s", Some("one".into()), None);
        let (new, second) = parks.park("s", Some("two".into()), None);
        assert_eq!(first.await.unwrap(), None);
        drop(old);
        assert!(!parks.deliver("s", Some("one"), "wrong".into()));
        assert!(parks.deliver("s", Some("two"), "right".into()));
        assert_eq!(second.await.unwrap(), Some("right".into()));
        drop(new);
        assert!(parks.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn dropped_park_cleans_entry_and_presence() {
        let parks = Arc::new(Parks::default());
        let presence = Arc::new(Presence::default());
        let (guard, receiver) = parks.park("s", None, Some(presence.clone()));
        drop(receiver);
        drop(guard);
        assert!(parks.entries.lock().unwrap().is_empty());
        assert!(presence.has_channel("s"));
        let (next, _) = parks.park("s", None, None);
        drop(next);
        assert!(!parks.deliver("s", None, "late".into()));
    }

    #[tokio::test]
    async fn cancelled_future_drops_park_and_old_inbox_guard_preserves_presence() {
        let parks = Arc::new(Parks::default());
        let presence = Arc::new(Presence::default());
        let (old, first) = parks.park("s", None, Some(presence.clone()));
        let (new, second) = parks.park("s", None, Some(presence.clone()));
        assert_eq!(first.await.unwrap(), None);
        drop(old);
        assert!(presence.has_channel("s"));
        let mut future = Box::pin(async move {
            let _guard = new;
            second.await
        });
        tokio::select! {
            biased;
            _ = &mut future => panic!("park unexpectedly resolved"),
            _ = tokio::task::yield_now() => {}
        }
        drop(future);
        assert!(parks.entries.lock().unwrap().is_empty());
        assert!(presence.has_channel("s"));
    }

    #[test]
    fn stash_matches_call_and_expires() {
        let mut stash = HashMap::new();
        stash.insert(
            "s".into(),
            Stash {
                text: "answer".into(),
                call: Some("one".into()),
                expires: Instant::now() + Duration::from_secs(1),
            },
        );
        assert_eq!(take_stash(&mut stash, "s", Some("two")), None);
        assert_eq!(
            take_stash(&mut stash, "s", Some("one")),
            Some("answer".into())
        );
        stash.insert(
            "s".into(),
            Stash {
                text: "old".into(),
                call: None,
                expires: Instant::now(),
            },
        );
        assert_eq!(take_stash(&mut stash, "s", None), None);
        assert!(stash.is_empty());
    }
}

#[derive(Default)]
pub struct BrokerState {
    parks: Arc<Parks>,
    stash: Mutex<HashMap<String, Stash>>,
}

struct Parked {
    id: u64,
    call: Option<String>,
    sender: oneshot::Sender<Option<String>>,
    presence: Option<Arc<Presence>>,
}

impl Parked {
    fn finish(self, session: &str, text: Option<String>) {
        if let Some(presence) = &self.presence {
            presence.mark_channel_seen(session);
            presence.set_channel_parked(session, false);
        }
        let _ = self.sender.send(text);
    }
}

#[derive(Default)]
pub(super) struct Parks {
    entries: Mutex<HashMap<String, Parked>>,
    generation: AtomicU64,
}

pub(super) struct ParkGuard {
    parks: Arc<Parks>,
    session: String,
    id: u64,
}

impl Drop for ParkGuard {
    fn drop(&mut self) {
        let mut entries = self.parks.entries.lock().expect("park lock poisoned");
        // A replaced request must never clear the newer request or its presence.
        if entries
            .get(&self.session)
            .is_some_and(|entry| entry.id == self.id)
        {
            entries
                .remove(&self.session)
                .expect("park exists")
                .finish(&self.session, None);
        }
    }
}

impl Parks {
    pub(super) fn park(
        self: &Arc<Self>,
        session: &str,
        call: Option<String>,
        presence: Option<Arc<Presence>>,
    ) -> (ParkGuard, oneshot::Receiver<Option<String>>) {
        let mut entries = self.entries.lock().expect("park lock poisoned");
        if let Some(old) = entries.remove(session) {
            old.finish(session, None);
        }
        let id = self.generation.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        if let Some(presence) = &presence {
            presence.set_channel_parked(session, true);
        }
        entries.insert(
            session.into(),
            Parked {
                id,
                call,
                sender,
                presence,
            },
        );
        (
            ParkGuard {
                parks: self.clone(),
                session: session.into(),
                id,
            },
            receiver,
        )
    }

    pub(super) fn deliver(&self, session: &str, call: Option<&str>, text: String) -> bool {
        let mut entries = self.entries.lock().expect("park lock poisoned");
        if entries
            .get(session)
            .is_some_and(|entry| call_log::call_matches(entry.call.as_deref(), call))
        {
            entries
                .remove(session)
                .expect("park exists")
                .finish(session, Some(text));
            true
        } else {
            false
        }
    }
}

pub(super) struct Stash {
    pub text: String,
    pub call: Option<String>,
    pub expires: Instant,
}

pub(super) fn take_stash(
    stash: &mut HashMap<String, Stash>,
    session: &str,
    call: Option<&str>,
) -> Option<String> {
    if !call_log::call_matches(stash.get(session)?.call.as_deref(), call) {
        return None;
    }
    let entry = stash.remove(session)?;
    (entry.expires > Instant::now()).then_some(entry.text)
}

pub(super) fn budget() -> Duration {
    Duration::from_millis(tunables::env_int("COCKPIT_WAIT_TIMEOUT_MS", 240_000))
}

pub(super) fn expires() -> Instant {
    Instant::now() + Duration::from_millis(tunables::env_int("COCKPIT_STASH_TTL_MS", 60_000))
}

pub(super) fn reply(value: Value) -> Response {
    (
        [
            ("content-type", "application/json; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        value.to_string(),
    )
        .into_response()
}

pub(super) fn error(status: StatusCode, message: &str) -> Response {
    (status, reply(json!({"error": message}))).into_response()
}

pub(super) fn authorized(token: Option<&str>) -> bool {
    let expected = daemon_info::read_daemon_info().and_then(|info| info.token);
    expected.is_some() && token == expected.as_deref()
}

pub(super) fn validate<'a>(
    token: Option<&str>,
    session: Option<&'a str>,
) -> Result<&'a str, Box<Response>> {
    if !authorized(token) {
        return Err(Box::new(error(StatusCode::UNAUTHORIZED, "unauthorized")));
    }
    session
        .filter(|s| {
            s.len() == 36
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        })
        .ok_or_else(|| Box::new(error(StatusCode::BAD_REQUEST, "invalid session")))
}

pub(super) fn parse(body: &[u8]) -> Result<Value, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|_| Box::new(error(StatusCode::BAD_REQUEST, "invalid json")))
}

fn log_path(session: &str) -> Option<String> {
    registry::read_registry()
        .iter()
        .find(|entry| entry.session_id() == session)
        .map(|entry| entry.log_path().to_owned())
        .filter(|path| !path.is_empty())
}

fn open_call(path: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    call_log::latest_open_call_id(&raw.lines().collect::<Vec<_>>())
}

fn uuid() -> std::io::Result<String> {
    let mut bytes = [0_u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

async fn wait(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let session = match validate(
        Some(query.get("token").map_or("", String::as_str)),
        query.get("session").map(String::as_str),
    ) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let call = query
        .get("call")
        .filter(|s| !s.is_empty())
        .map(String::as_str);
    // Drain first: an already logged answer must survive the superseded and presence checks.
    if let Some(answer) = take_stash(
        &mut state.broker.stash.lock().expect("stash lock poisoned"),
        session,
        call,
    ) {
        return reply(json!({"answer": answer}));
    }
    // A moot call gets the precise superseded sentinel even when no watcher is present.
    if let Some(call) = call
        && let Some(path) = log_path(session)
        && open_call(&path).as_deref() != Some(call)
    {
        return reply(json!({"answer": null, "superseded": true}));
    }
    // Presence comes last because it must not hide a delivered answer or superseded call.
    if query
        .get("require_watcher")
        .is_some_and(|value| value == "1")
    {
        let reason = if !config::get_answer_here() {
            Some("toggle_off")
        } else if !state.presence.has_visible_subscriber(session) {
            Some("no_tab")
        } else {
            None
        };
        if let Some(reason) = reason {
            return reply(json!({"answer": null, "not_watching": true, "reason": reason}));
        }
    }
    let (guard, receiver) = state
        .broker
        .parks
        .park(session, call.map(str::to_owned), None);
    let answer = tokio::time::timeout(budget(), receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    drop(guard);
    match answer {
        Some(answer) => reply(json!({"answer": answer})),
        None => reply(json!({"answer": null, "timeout": true})),
    }
}

async fn respond(State(state): State<AppState>, body: Bytes) -> Response {
    let body = match parse(&body) {
        Ok(body) => body,
        Err(e) => return *e,
    };
    let session = match validate(
        body.get("token").and_then(Value::as_str),
        body.get("session").and_then(Value::as_str),
    ) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let answer = body.get("answer").and_then(Value::as_str).unwrap_or("");
    let path = log_path(session);
    let open = path.as_deref().and_then(open_call);
    let target = body.get("call").and_then(Value::as_str).or(open.as_deref());
    if let Some(path) = path
        && let Ok(id) = uuid()
    {
        let record = json!({"id": id, "type": "response", "call": target, "answer": answer, "ts": registry::iso_timestamp(registry::now_ms())});
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{record}");
        }
    }
    let delivered = state.broker.parks.deliver(session, target, answer.into());
    if !delivered && open.is_some() {
        state
            .broker
            .stash
            .lock()
            .expect("stash lock poisoned")
            .insert(
                session.into(),
                Stash {
                    text: answer.into(),
                    call: target.map(str::to_owned),
                    expires: expires(),
                },
            );
    }
    reply(json!({"delivered": delivered}))
}

async fn answer_here(
    method: Method,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if method == Method::POST {
        let body = match parse(&body) {
            Ok(body) => body,
            Err(e) => return *e,
        };
        if !authorized(body.get("token").and_then(Value::as_str)) {
            return error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        let Some(on) = body.get("on").and_then(Value::as_bool) else {
            return error(StatusCode::BAD_REQUEST, "invalid on");
        };
        config::set_answer_here(on);
        reply(json!({"answer_here": on}))
    } else {
        if !authorized(Some(query.get("token").map_or("", String::as_str))) {
            return error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        reply(json!({"answer_here": config::get_answer_here()}))
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/wait", get(wait))
        .route("/api/respond", post(respond))
        .route("/api/answer-here", any(answer_here))
}
