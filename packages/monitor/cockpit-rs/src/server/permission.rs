use super::{
    AppState,
    broker::{budget, expires, parse, validate},
    json_error, json_response,
    sources::resolve_claude_transcript_path,
};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::Response,
    routing::any,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::AbortHandle,
};

#[derive(Default)]
pub struct PermissionState {
    entries: Mutex<Entries>,
}
#[derive(Default)]
struct Entries {
    pending: HashMap<String, PendingRequest>,
    verdict_stash: HashMap<String, (Value, Instant)>,
    pulls: HashMap<String, (u64, oneshot::Sender<Value>)>,
    generation: u64,
}
struct PendingRequest {
    id: String,
    generation: u64,
    frame: String,
    expires: Instant,
    watcher: Option<RecommendedWatcher>,
    tasks: Vec<AbortHandle>,
}
impl Drop for PendingRequest {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
fn frame(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn timeout() -> Value {
    json!({"verdict": null, "timeout": true})
}
fn take_pending<'a>(entries: &'a mut Entries, session: &str) -> Option<&'a PendingRequest> {
    if entries
        .pending
        .get(session)
        .is_some_and(|p| p.expires <= Instant::now())
    {
        entries.pending.remove(session);
    }
    entries.pending.get(session)
}
fn resolve_elsewhere(state: &AppState, session: &str, id: &str) -> bool {
    let mut entries = state
        .permission
        .entries
        .lock()
        .expect("permission lock poisoned");
    if !entries.pending.get(session).is_some_and(|p| p.id == id) {
        return false;
    }
    entries.pending.remove(session);
    state.presence.broadcast(
        session,
        &frame(json!({"type": "resolved", "request_id": id, "source": "elsewhere"})),
    );
    if let Some((_, sender)) = entries.pulls.remove(session) {
        let _ = sender.send(json!({"abandoned": true}));
    }
    true
}
fn is_forward_progress(
    registered_at: u64,
    registered_size: u64,
    now: u64,
    new_size: u64,
    guard_ms: u64,
) -> bool {
    now.saturating_sub(registered_at) >= guard_ms && new_size > registered_size
}
fn watch_progress(
    state: &AppState,
    session: &str,
    id: &str,
) -> Option<(RecommendedWatcher, AbortHandle)> {
    let path = resolve_claude_transcript_path(session)?;
    let size = std::fs::metadata(&path).ok()?.len();
    let registered = Instant::now();
    let guard = crate::tunables::env_int("COCKPIT_TRANSCRIPT_GUARD_MS", 1000);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            let _ = tx.send(());
        }
    })
    .ok()?;
    watcher.watch(&path, RecursiveMode::NonRecursive).ok()?;
    let state = state.clone();
    let session = session.to_owned();
    let id = id.to_owned();
    let task = tokio::spawn(async move {
        while rx.recv().await.is_some() {
            if let Ok(meta) = std::fs::metadata(&path)
                && is_forward_progress(
                    0,
                    size,
                    registered.elapsed().as_millis() as u64,
                    meta.len(),
                    guard,
                )
            {
                resolve_elsewhere(&state, &session, &id);
                break;
            }
        }
    });
    Some((watcher, task.abort_handle()))
}
async fn mutate(State(state): State<AppState>, uri: axum::http::Uri, body: Bytes) -> Response {
    let body = match parse(&body) {
        Ok(b) => b,
        Err(e) => return *e,
    };
    let session = match validate(
        body.get("token").and_then(Value::as_str),
        body.get("session").and_then(Value::as_str),
    ) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let Some(id) = body
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return json_error(StatusCode::BAD_REQUEST, "invalid request_id");
    };
    match uri.path() {
        "/api/permission-resolved" => json_response(
            StatusCode::OK,
            json!({"resolved": resolve_elsewhere(&state, session, id)}),
        ),
        "/api/permission-verdict" => {
            let Some(behavior) = body
                .get("behavior")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "allow" | "deny"))
            else {
                return json_error(StatusCode::BAD_REQUEST, "invalid behavior");
            };
            let mut entries = state
                .permission
                .entries
                .lock()
                .expect("permission lock poisoned");
            if !take_pending(&mut entries, session).is_some_and(|p| p.id == id) {
                return json_error(StatusCode::CONFLICT, "stale request");
            }
            entries.pending.remove(session);
            let verdict = json!({"request_id": id, "behavior": behavior});
            let delivered = if let Some((_, sender)) = entries.pulls.remove(session) {
                let _ = sender.send(verdict);
                true
            } else {
                entries
                    .verdict_stash
                    .insert(session.into(), (verdict, expires()));
                false
            };
            state.presence.broadcast(
                session,
                &frame(json!({"type": "resolved", "request_id": id, "source": "ui"})),
            );
            json_response(StatusCode::OK, json!({"delivered": delivered}))
        }
        _ => {
            let prior = state
                .permission
                .entries
                .lock()
                .expect("permission lock poisoned")
                .pending
                .get(session)
                .map(|p| p.id.clone());
            if let Some(prior) = prior.filter(|prior| prior != id) {
                resolve_elsewhere(&state, session, &prior);
            }
            let request_frame = frame(
                json!({"type": "request", "request_id": id, "tool_name": body.get("tool_name").and_then(Value::as_str).unwrap_or(""), "description": body.get("description").and_then(Value::as_str).unwrap_or(""), "input_preview": body.get("input_preview").and_then(Value::as_str).unwrap_or("")}),
            );
            let deadline = expires();
            let mut entries = state
                .permission
                .entries
                .lock()
                .expect("permission lock poisoned");
            entries.generation += 1;
            let generation = entries.generation;
            entries.pending.insert(
                session.into(),
                PendingRequest {
                    id: id.into(),
                    generation,
                    frame: request_frame.clone(),
                    expires: deadline,
                    watcher: None,
                    tasks: Vec::new(),
                },
            );
            state.presence.broadcast(session, &request_frame);
            let watched = watch_progress(&state, session, id);
            let weak = Arc::downgrade(&state.permission);
            let session_owned = session.to_owned();
            let expiry = tokio::spawn(async move {
                tokio::time::sleep_until(deadline.into()).await;
                if let Some(state) = weak.upgrade() {
                    let mut entries = state.entries.lock().expect("permission lock poisoned");
                    if entries
                        .pending
                        .get(&session_owned)
                        .is_some_and(|p| p.generation == generation)
                    {
                        entries.pending.remove(&session_owned);
                    }
                }
            });
            let pending = entries.pending.get_mut(session).expect("request inserted");
            pending.tasks.push(expiry.abort_handle());
            if let Some((watcher, task)) = watched {
                pending.watcher = Some(watcher);
                pending.tasks.push(task);
            }
            json_response(StatusCode::OK, json!({"ok": true}))
        }
    }
}
struct PullGuard {
    state: Arc<PermissionState>,
    session: String,
    generation: u64,
}
impl Drop for PullGuard {
    fn drop(&mut self) {
        let mut entries = self.state.entries.lock().expect("permission lock poisoned");
        if entries
            .pulls
            .get(&self.session)
            .is_some_and(|(id, _)| *id == self.generation)
        {
            entries.pulls.remove(&self.session);
        }
    }
}
async fn pull(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let session = match validate(
        query.get("token").map(String::as_str),
        query.get("session").map(String::as_str),
    ) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let (guard, receiver) = {
        let mut entries = state
            .permission
            .entries
            .lock()
            .expect("permission lock poisoned");
        if let Some((verdict, deadline)) = entries.verdict_stash.remove(session)
            && deadline > Instant::now()
        {
            return json_response(StatusCode::OK, verdict);
        }
        if let Some((_, sender)) = entries.pulls.remove(session) {
            let _ = sender.send(timeout());
        }
        entries.generation += 1;
        let generation = entries.generation;
        let (sender, receiver) = oneshot::channel();
        entries.pulls.insert(session.into(), (generation, sender));
        (
            PullGuard {
                state: state.permission.clone(),
                session: session.into(),
                generation,
            },
            receiver,
        )
    };
    let value = tokio::time::timeout(budget(), receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(timeout);
    drop(guard);
    json_response(StatusCode::OK, value)
}
async fn stream(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let session = match validate(
        query.get("token").map(String::as_str),
        query.get("session").map(String::as_str),
    ) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let (sender, receiver) = mpsc::unbounded_channel();
    state.presence.add_subscriber(session, sender.clone());
    let _ = sender.send(": connected\n\n".into());
    if let Some(pending) = take_pending(
        &mut state
            .permission
            .entries
            .lock()
            .expect("permission lock poisoned"),
        session,
    ) {
        let _ = sender.send(pending.frame.clone());
    }
    // Dropping the body closes this receiver, so presence can prune without probe bytes.
    drop(sender);
    sse_response(receiver).await
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/permission-request", any(mutate))
        .route("/api/permission-verdict", any(mutate))
        .route("/api/permission-resolved", any(mutate))
        .route("/api/permission-stream", any(stream))
        .route("/api/permission-pull", any(pull))
}

async fn sse_response(mut receiver: mpsc::UnboundedReceiver<String>) -> Response {
    super::log_stream::sse_tailer::sse_response(|sender| async move {
        let mut heartbeat = tokio::time::interval(Duration::from_millis(
            super::log_stream::sse_tailer::HEARTBEAT_MS,
        ));
        heartbeat.tick().await;
        loop {
            let chunk = tokio::select! {
                _ = sender.closed() => break,
                chunk = receiver.recv() => { let Some(chunk) = chunk else { break; }; chunk },
                _ = heartbeat.tick() => ": ping\n\n".into(),
            };
            if sender.send(chunk).await.is_err() {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_requires_guard_boundary_and_growth() {
        assert!(!is_forward_progress(100, 10, 199, 11, 100));
        assert!(is_forward_progress(100, 10, 200, 11, 100));
        assert!(!is_forward_progress(100, 10, 200, 10, 100));
        assert!(!is_forward_progress(100, 10, 200, 9, 100));
    }
    #[tokio::test]
    async fn expired_pending_releases_watcher_and_aborts_timer() {
        let (sender, receiver) = mpsc::unbounded_channel::<()>();
        let watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
            let _ = &sender;
        })
        .unwrap();
        let task = tokio::spawn(std::future::pending::<()>());
        let mut entries = Entries::default();
        entries.pending.insert(
            "session".into(),
            PendingRequest {
                id: "request".into(),
                generation: 1,
                frame: String::new(),
                expires: Instant::now(),
                watcher: Some(watcher),
                tasks: vec![task.abort_handle()],
            },
        );
        assert!(take_pending(&mut entries, "session").is_none());
        assert!(entries.pending.is_empty());
        assert!(receiver.is_closed());
        assert!(task.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn old_pull_guard_cannot_remove_replacement() {
        let state = Arc::new(PermissionState::default());
        let (old_sender, old_receiver) = oneshot::channel();
        state
            .entries
            .lock()
            .unwrap()
            .pulls
            .insert("session".into(), (1, old_sender));
        let old_guard = PullGuard {
            state: state.clone(),
            session: "session".into(),
            generation: 1,
        };
        let (new_sender, mut new_receiver) = oneshot::channel();
        state
            .entries
            .lock()
            .unwrap()
            .pulls
            .insert("session".into(), (2, new_sender));
        drop(old_receiver);
        drop(old_guard);
        assert!(state.entries.lock().unwrap().pulls.contains_key("session"));
        drop(PullGuard {
            state: state.clone(),
            session: "session".into(),
            generation: 2,
        });
        assert!(state.entries.lock().unwrap().pulls.is_empty());
        assert!(matches!(
            new_receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[tokio::test]
    async fn dropping_sse_body_closes_presence_receiver() {
        let presence = super::super::presence::Presence::default();
        let (sender, receiver) = mpsc::unbounded_channel();
        presence.add_subscriber("session", sender);
        let response = sse_response(receiver).await;
        assert!(presence.has_visible_subscriber("session"));
        drop(response);
        tokio::task::yield_now().await;
        assert!(!presence.has_visible_subscriber("session"));
    }
}
