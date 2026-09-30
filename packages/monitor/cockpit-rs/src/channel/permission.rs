use super::{AbortToken, ChannelPeer, ChannelServer, daemon, sleep};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::Instant,
};

// A prompt resolved in the terminal must not leave the relay parked forever.
const PULL_BUDGET_MS: u64 = 5 * 60 * 1000;
// Bound repeated daemon failures without dropping transient restart recovery.
const MAX_FAILURES: u32 = 6;
// Restrict forwarding to Claude's permission notification namespace.
const PREFIX: &str = "notifications/claude/channel/permission";
// New requests supersede the prior tool prompt.
const REQUEST: &str = "notifications/claude/channel/permission_request";
// Verdict notifications must never be reflected back as cancellation.
const VERDICT: &str = "notifications/claude/channel/permission";

#[derive(Debug, PartialEq)]
enum PullOutcome {
    Verdict {
        request_id: String,
        behavior: String,
    },
    Abandoned,
    GaveUp,
}

fn field<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

fn request_payload(session: &str, token: &str, params: &Value) -> Value {
    json!({"session": session, "token": token,
        "request_id": field(params, "request_id"),
        "tool_name": field(params, "tool_name"),
        "description": field(params, "description"),
        "input_preview": field(params, "input_preview")})
}

fn resolved_payload(session: &str, token: &str, params: &Value) -> Value {
    json!({"session": session, "token": token, "request_id": field(params, "request_id")})
}

async fn post(
    client: &reqwest::Client,
    session: &str,
    params: &Value,
    request: bool,
) -> anyhow::Result<()> {
    let coords = match daemon::read_daemon_coords() {
        Some(coords) => coords,
        None => daemon::ensure_cockpit_daemon()
            .await
            .ok_or_else(|| anyhow::anyhow!("cockpit daemon unavailable"))?,
    };
    let path = if request {
        "/api/permission-request"
    } else {
        "/api/permission-resolved"
    };
    let body = if request {
        request_payload(session, &coords.token, params)
    } else {
        resolved_payload(session, &coords.token, params)
    };
    let response = client
        .post(format!("http://127.0.0.1:{}{path}", coords.port))
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("{path} failed: {}", response.status().as_u16());
    }
    Ok(())
}

async fn pull_verdict(client: &reqwest::Client, session: &str, token: &AbortToken) -> PullOutcome {
    pull_with(
        daemon::read_daemon_coords(),
        token,
        Duration::from_millis(PULL_BUDGET_MS),
        daemon::POLL_FLOOR_MS,
        MAX_FAILURES,
        daemon::ensure_cockpit_daemon,
        |coords| async move {
            let response = client
                .get(format!(
                    "http://127.0.0.1:{}/api/permission-pull",
                    coords.port
                ))
                .query(&[("session", session), ("token", coords.token.as_str())])
                .send()
                .await?;
            if !response.status().is_success() {
                anyhow::bail!("permission-pull failed: {}", response.status().as_u16());
            }
            Ok(response.json::<Value>().await?)
        },
    )
    .await
}

async fn pull_with<Ensure, EnsureFuture, Fetch, FetchFuture>(
    mut coords: Option<daemon::DaemonCoords>,
    token: &AbortToken,
    budget: Duration,
    floor_ms: u64,
    max_failures: u32,
    mut ensure: Ensure,
    mut fetch: Fetch,
) -> PullOutcome
where
    Ensure: FnMut() -> EnsureFuture,
    EnsureFuture: Future<Output = Option<daemon::DaemonCoords>>,
    Fetch: FnMut(daemon::DaemonCoords) -> FetchFuture,
    FetchFuture: Future<Output = anyhow::Result<Value>>,
{
    if token.is_aborted() {
        return PullOutcome::Abandoned;
    }
    let deadline = Instant::now() + budget;
    let operation = async {
        let mut failures = 0;
        loop {
            if token.is_aborted() || Instant::now() >= deadline {
                return PullOutcome::Abandoned;
            }
            if coords.is_none() {
                coords = ensure().await;
            }
            let Some(current) = coords.as_ref() else {
                if failures >= max_failures {
                    return PullOutcome::GaveUp;
                }
                let delay = daemon::next_reconnect_delay_ms(failures);
                failures += 1;
                sleep(delay, token).await;
                continue;
            };
            let started = Instant::now();
            match fetch(daemon::DaemonCoords {
                port: current.port,
                token: current.token.clone(),
            })
            .await
            {
                Ok(body) => {
                    failures = 0;
                    if body.get("abandoned") == Some(&Value::Bool(true)) {
                        return PullOutcome::Abandoned;
                    }
                    if body.get("timeout") == Some(&Value::Bool(true)) {
                        let elapsed = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                        let delay = daemon::poll_floor_delay_ms(elapsed, floor_ms, super::jitter());
                        sleep(delay, token).await;
                        continue;
                    }
                    if let (Some(request_id), Some(behavior @ ("allow" | "deny"))) = (
                        body.get("request_id").and_then(Value::as_str),
                        body.get("behavior").and_then(Value::as_str),
                    ) {
                        return PullOutcome::Verdict {
                            request_id: request_id.to_owned(),
                            behavior: behavior.to_owned(),
                        };
                    }
                }
                Err(error) => {
                    if token.is_aborted() {
                        return PullOutcome::Abandoned;
                    }
                    if failures >= max_failures {
                        return PullOutcome::GaveUp;
                    }
                    let delay = daemon::next_reconnect_delay_ms(failures);
                    failures += 1;
                    eprintln!(
                        "cockpit-channel: permission-pull failed ({error}); retrying in {delay}ms"
                    );
                    coords = ensure().await;
                    sleep(delay, token).await;
                }
            }
        }
    };
    tokio::select! {
        biased;
        _ = token.cancelled() => PullOutcome::Abandoned,
        _ = tokio::time::sleep_until(deadline) => PullOutcome::Abandoned,
        outcome = operation => outcome,
    }
}

enum Work {
    Request(Value, AbortToken),
    Resolved(Value),
}

fn enqueue(
    tx: &mpsc::UnboundedSender<Work>,
    current: &mut Option<AbortToken>,
    method: &str,
    params: Option<Value>,
) {
    let params = params.unwrap_or(Value::Null);
    if method == REQUEST {
        if let Some(prior) = current.take() {
            prior.abort();
        }
        let token = AbortToken::default();
        *current = Some(token.clone());
        let _ = tx.send(Work::Request(params, token));
    } else if method.starts_with(PREFIX) && method != VERDICT {
        if !matches!(
            method,
            "notifications/claude/channel/permission_cancel"
                | "notifications/claude/channel/permission_resolved"
                | "notifications/claude/channel/permission_cancelled"
        ) {
            eprintln!(
                "cockpit-channel: observed undocumented permission notification \"{method}\" — forwarding as resolved"
            );
        }
        let _ = tx.send(Work::Resolved(params));
    }
}

pub(super) fn register(
    server: &mut ChannelServer,
    session: String,
    client: reqwest::Client,
    mut peer: watch::Receiver<Option<ChannelPeer>>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let current = Arc::new(Mutex::new(None));
    server.on_notification(move |method, params| {
        enqueue(
            &tx,
            &mut current.lock().expect("relay mutex is not poisoned"),
            &method,
            params,
        );
    });
    tokio::spawn(async move {
        while let Some(work) = rx.recv().await {
            let result: anyhow::Result<()> = async {
                match work {
                    Work::Resolved(params) => post(&client, &session, &params, false).await?,
                    Work::Request(params, token) => {
                        // Dropping the POST future also unblocks a superseded queued prompt.
                        tokio::select! {
                            biased;
                            _ = token.cancelled() => return Ok(()),
                            result = post(&client, &session, &params, true) => result?,
                        }
                        if let PullOutcome::Verdict { request_id, behavior } = pull_verdict(&client, &session, &token).await {
                            let connected = loop {
                                let connected = peer.borrow_and_update().clone();
                                if let Some(connected) = connected { break connected; }
                                tokio::select! {
                                    _ = token.cancelled() => return Ok(()),
                                    result = peer.changed() => if result.is_err() { return Ok(()); },
                                }
                            };
                            tokio::select! {
                                biased;
                                _ = token.cancelled() => return Ok(()),
                                result = connected.notify(VERDICT, json!({"request_id": request_id, "behavior": behavior})) => result?,
                            }
                        }
                    }
                }
                Ok(())
            }.await;
            if let Err(error) = result {
                eprintln!("cockpit-channel: permission relay failed ({error})");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coords() -> Option<daemon::DaemonCoords> {
        Some(daemon::DaemonCoords {
            port: 1,
            token: "t".into(),
        })
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn payload_coerces_only_non_strings() {
        assert_eq!(
            request_payload(
                "s",
                "t",
                &json!({"request_id": " id \n", "tool_name": 1, "description": false, "input_preview": null})
            ),
            json!({"session":"s","token":"t","request_id":" id \n","tool_name":"","description":"","input_preview":""})
        );
        assert_eq!(
            request_payload("s", "t", &Value::Null),
            json!({"session":"s","token":"t","request_id":"","tool_name":"","description":"","input_preview":""})
        );
        assert_eq!(
            resolved_payload("s", "t", &json!({"request_id": []})),
            json!({"session":"s","token":"t","request_id":""})
        );
    }

    #[test]
    fn verdict_and_abandonment_shapes() {
        runtime().block_on(async {
            for (body, expected) in [
                (
                    json!({"request_id":" id \n","behavior":"allow"}),
                    PullOutcome::Verdict {
                        request_id: " id \n".into(),
                        behavior: "allow".into(),
                    },
                ),
                (
                    json!({"request_id":"x","behavior":"deny"}),
                    PullOutcome::Verdict {
                        request_id: "x".into(),
                        behavior: "deny".into(),
                    },
                ),
                (json!({"abandoned":true}), PullOutcome::Abandoned),
            ] {
                let got = pull_with(
                    coords(),
                    &AbortToken::default(),
                    Duration::from_secs(1),
                    0,
                    6,
                    || async { coords() },
                    |_| std::future::ready(Ok(body.clone())),
                )
                .await;
                assert_eq!(got, expected);
            }
        });
    }

    #[test]
    fn pre_abort_budget_and_midflight_abort_return_abandoned() {
        runtime().block_on(async {
            let token = AbortToken::default();
            token.abort();
            assert_eq!(
                pull_with(
                    coords(),
                    &token,
                    Duration::from_secs(1),
                    0,
                    6,
                    || async { panic!("ensure must not run") },
                    |_| async { panic!("fetch must not run") }
                )
                .await,
                PullOutcome::Abandoned
            );
            let token = AbortToken::default();
            assert_eq!(
                pull_with(
                    coords(),
                    &token,
                    Duration::ZERO,
                    0,
                    6,
                    || async { coords() },
                    |_| std::future::pending()
                )
                .await,
                PullOutcome::Abandoned
            );
            assert_eq!(
                pull_with(
                    coords(),
                    &token,
                    Duration::from_millis(5),
                    0,
                    6,
                    || async { coords() },
                    |_| std::future::pending()
                )
                .await,
                PullOutcome::Abandoned
            );
            let abort = token.clone();
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                abort.abort();
            });
            assert_eq!(
                pull_with(
                    coords(),
                    &token,
                    Duration::from_secs(1),
                    0,
                    6,
                    || async { coords() },
                    |_| std::future::pending()
                )
                .await,
                PullOutcome::Abandoned
            );
        });
    }

    #[test]
    fn invalid_shapes_and_timeout_repoll_without_bogus_verdict() {
        runtime().block_on(async {
            let mut bodies = std::collections::VecDeque::from([
                json!({"request_id": 1, "behavior": "allow"}),
                json!({"request_id":"x","behavior":"invalid"}),
                json!({"timeout":true}),
                json!({"request_id":"final","behavior":"deny"}),
            ]);
            let outcome = pull_with(
                coords(),
                &AbortToken::default(),
                Duration::from_secs(1),
                0,
                6,
                || async { coords() },
                |_| std::future::ready(Ok(bodies.pop_front().unwrap())),
            )
            .await;
            assert_eq!(
                outcome,
                PullOutcome::Verdict {
                    request_id: "final".into(),
                    behavior: "deny".into()
                }
            );
            assert!(bodies.is_empty());
        });
    }

    #[test]
    fn unavailable_and_http_error_give_up_at_retry_limit() {
        runtime().block_on(async {
            assert_eq!(
                pull_with(
                    None,
                    &AbortToken::default(),
                    Duration::from_secs(1),
                    0,
                    0,
                    || async { None },
                    |_| async { panic!("must not fetch") }
                )
                .await,
                PullOutcome::GaveUp
            );
            assert_eq!(
                pull_with(
                    coords(),
                    &AbortToken::default(),
                    Duration::from_secs(1),
                    0,
                    0,
                    || async { None },
                    |_| async { Err(anyhow::anyhow!("bad HTTP")) }
                )
                .await,
                PullOutcome::GaveUp
            );
        });
    }

    #[test]
    fn supersede_drops_parked_pull_before_processing_next_request() {
        runtime().block_on(async {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let mut current = None;
            enqueue(&tx, &mut current, REQUEST, None);
            let Work::Request(_, first) = rx.recv().await.unwrap() else {
                panic!("request expected")
            };
            let (parked_tx, parked_rx) = tokio::sync::oneshot::channel();
            let mut parked_tx = Some(parked_tx);
            let pulling = pull_with(
                coords(),
                &first,
                Duration::from_secs(1),
                0,
                6,
                || async { coords() },
                |_| {
                    parked_tx.take().unwrap().send(()).unwrap();
                    std::future::pending()
                },
            );
            let supersede = async {
                parked_rx.await.unwrap();
                enqueue(
                    &tx,
                    &mut current,
                    REQUEST,
                    Some(json!({"request_id":"next"})),
                );
            };
            let (outcome, ()) = tokio::join!(pulling, supersede);
            assert_eq!(outcome, PullOutcome::Abandoned);
            let Work::Request(params, next) = rx.recv().await.unwrap() else {
                panic!("request expected")
            };
            assert_eq!(params["request_id"], "next");
            assert!(!next.is_aborted());
        });
    }

    #[test]
    fn new_request_aborts_previous_and_queue_preserves_cancel_order() {
        runtime().block_on(async {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let mut current = None;
            enqueue(
                &tx,
                &mut current,
                REQUEST,
                Some(json!({"request_id":"first"})),
            );
            let Work::Request(_, first) = rx.recv().await.unwrap() else {
                panic!("request expected")
            };
            enqueue(
                &tx,
                &mut current,
                REQUEST,
                Some(json!({"request_id":"second"})),
            );
            assert!(first.is_aborted());
            assert_eq!(
                pull_with(
                    coords(),
                    &first,
                    Duration::from_secs(1),
                    0,
                    6,
                    || async { coords() },
                    |_| async { panic!("abandoned request sends no verdict") }
                )
                .await,
                PullOutcome::Abandoned
            );
            enqueue(
                &tx,
                &mut current,
                "notifications/claude/channel/permission_cancel",
                Some(json!({"request_id":"second"})),
            );
            let Work::Request(params, second) = rx.recv().await.unwrap() else {
                panic!("request expected")
            };
            assert_eq!(params["request_id"], "second");
            assert!(!second.is_aborted());
            assert!(matches!(rx.recv().await, Some(Work::Resolved(_))));
            enqueue(&tx, &mut current, VERDICT, None);
            enqueue(&tx, &mut current, "notifications/other", None);
            assert!(rx.try_recv().is_err());
        });
    }
}
