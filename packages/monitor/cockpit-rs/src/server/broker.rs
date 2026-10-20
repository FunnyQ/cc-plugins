use super::{AppState, json_error, json_response, presence::Presence};
use crate::{call_log, config, daemon_info, registry, tunables};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{any, get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
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

    #[test]
    fn default_budget_stays_below_the_daemon_idle_timeout() {
        let _env = crate::paths::tests::TestEnv::new();
        assert!(budget() < Duration::from_millis(255_000));
    }

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";

    fn wait_body(
        env: &crate::paths::tests::TestEnv,
        log: &str,
        stash: Option<&str>,
        query: &[(&str, &str)],
    ) -> Value {
        let home = env.dir.path();
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", home);
        crate::paths::tests::TestEnv::set("COCKPIT_WAIT_TIMEOUT_MS", "50");
        std::fs::write(
            home.join("daemon.json"),
            r#"{"pid":1,"port":1,"token":"t","root":"r"}"#,
        )
        .unwrap();
        let log_path = home.join("log.jsonl");
        std::fs::write(&log_path, log).unwrap();
        let registry = json!({"sessions": [{"sessionId": SESSION, "logPath": log_path}]});
        std::fs::write(home.join("registry.json"), registry.to_string()).unwrap();
        let state = AppState {
            presence: Default::default(),
            broker: Default::default(),
            inbox: Default::default(),
            permission: Default::default(),
            plugin_root: home.into(),
        };
        if let Some(call) = stash {
            state.broker.stash.lock().unwrap().insert(
                SESSION.into(),
                Stash {
                    text: "stashed".into(),
                    call: Some(call.into()),
                    expires: expires(),
                },
            );
        }
        let mut params: HashMap<String, String> = [("token", "t"), ("session", SESSION)]
            .into_iter()
            .chain(query.iter().copied())
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        params.insert("require_watcher".into(), "1".into());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let response = wait(State(state), Query(params)).await;
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            serde_json::from_slice(&bytes).unwrap()
        })
    }

    const OPEN_C1: &str = "{\"type\":\"decision\",\"id\":\"c1\",\"needs_your_call\":true}\n";

    #[test]
    fn stashed_answer_returns_even_when_superseded_and_unwatched() {
        let env = crate::paths::tests::TestEnv::new();
        let body = wait_body(&env, OPEN_C1, Some("c2"), &[("call", "c2")]);
        assert_eq!(body, json!({"answer": "stashed"}));
    }

    #[test]
    fn moot_call_is_superseded_before_the_watcher_check() {
        let env = crate::paths::tests::TestEnv::new();
        let body = wait_body(&env, OPEN_C1, None, &[("call", "c2")]);
        assert_eq!(body, json!({"answer": null, "superseded": true}));
    }

    #[test]
    fn not_watching_refuses_only_a_live_call_with_no_stash() {
        let env = crate::paths::tests::TestEnv::new();
        let body = wait_body(&env, OPEN_C1, None, &[("call", "c1")]);
        assert_eq!(
            body,
            json!({"answer": null, "not_watching": true, "reason": "toggle_off"})
        );
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

pub(super) fn authorized(token: Option<&str>) -> bool {
    let expected = daemon_info::read_daemon_info().and_then(|info| info.token);
    expected.is_some() && token == expected.as_deref()
}

pub(super) fn validate<'a>(
    token: Option<&str>,
    session: Option<&'a str>,
) -> Result<&'a str, Box<Response>> {
    if !authorized(token) {
        return Err(Box::new(json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
        )));
    }
    session
        .filter(|s| registry::is_session_id(s))
        .ok_or_else(|| Box::new(json_error(StatusCode::BAD_REQUEST, "invalid session")))
}

pub(super) fn parse(body: &[u8]) -> Result<Value, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|_| Box::new(json_error(StatusCode::BAD_REQUEST, "invalid json")))
}

fn log_path(session: &str) -> Option<String> {
    registry::entry_for(session)
        .map(|entry| entry.log_path().to_owned())
        .filter(|path| !path.is_empty())
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
    if let Some(answer) = take_stash(
        &mut state.broker.stash.lock().expect("stash lock poisoned"),
        session,
        call,
    ) {
        return json_response(StatusCode::OK, json!({"answer": answer}));
    }
    if let Some(call) = call
        && let Some(path) = log_path(session)
        && call_log::latest_open_call_in(&path).as_deref() != Some(call)
    {
        return json_response(StatusCode::OK, json!({"answer": null, "superseded": true}));
    }
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
            return json_response(
                StatusCode::OK,
                json!({"answer": null, "not_watching": true, "reason": reason}),
            );
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
        Some(answer) => json_response(StatusCode::OK, json!({"answer": answer})),
        None => json_response(StatusCode::OK, json!({"answer": null, "timeout": true})),
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
    let open = path.as_deref().and_then(call_log::latest_open_call_in);
    let target = body.get("call").and_then(Value::as_str).or(open.as_deref());
    if let Some(path) = path {
        let id = uuid::Uuid::new_v4().to_string();
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
    json_response(StatusCode::OK, json!({"delivered": delivered}))
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
            return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        let Some(on) = body.get("on").and_then(Value::as_bool) else {
            return json_error(StatusCode::BAD_REQUEST, "invalid on");
        };
        config::set_answer_here(on);
        json_response(StatusCode::OK, json!({"answer_here": on}))
    } else {
        if !authorized(Some(query.get("token").map_or("", String::as_str))) {
            return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        json_response(
            StatusCode::OK,
            json!({"answer_here": config::get_answer_here()}),
        )
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/wait", get(wait))
        .route("/api/respond", post(respond))
        .route("/api/answer-here", any(answer_here))
}
