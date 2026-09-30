use super::{
    AppState,
    broker::{Parks, Stash, budget, error, expires, parse, reply, take_stash, validate},
};
use axum::{
    Router,
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::Response,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct InboxState {
    parks: Arc<Parks>,
    stash: Mutex<HashMap<String, Stash>>,
}

async fn inbox(
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
    state.presence.mark_channel_seen(session);
    if let Some(message) = take_stash(
        &mut state.inbox.stash.lock().expect("stash lock poisoned"),
        session,
        None,
    ) {
        return reply(json!({"message": message}));
    }
    let (guard, receiver) = state
        .inbox
        .parks
        .park(session, None, Some(state.presence.clone()));
    let message = tokio::time::timeout(budget(), receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    drop(guard);
    match message {
        Some(message) => reply(json!({"message": message})),
        None => reply(json!({"message": null, "timeout": true})),
    }
}

async fn send_message(State(state): State<AppState>, body: Bytes) -> Response {
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
    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    if text
        .trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
        .is_empty()
    {
        return error(StatusCode::BAD_REQUEST, "empty text");
    }
    let delivered = state.inbox.parks.deliver(session, None, text.into());
    if !delivered {
        state
            .inbox
            .stash
            .lock()
            .expect("stash lock poisoned")
            .insert(
                session.into(),
                Stash {
                    text: text.into(),
                    call: None,
                    expires: expires(),
                },
            );
    }
    reply(json!({"delivered": delivered}))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/inbox", get(inbox))
        .route("/api/send-message", post(send_message))
}
