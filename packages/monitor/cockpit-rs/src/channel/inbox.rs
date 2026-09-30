use super::{AbortToken, ChannelPeer, daemon, jitter, sleep};
use serde_json::{Value, json};
use std::{future::Future, time::Instant};
use tokio::sync::{mpsc, watch};

fn serial_notifier<F, Fut>(mut notify: F) -> mpsc::UnboundedSender<String>
where
    F: FnMut(String) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send,
{
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if let Err(error) = notify(text).await {
                eprintln!("cockpit-channel: notification failed ({error})");
            }
        }
    });
    tx
}

pub(super) async fn run(
    session: String,
    client: reqwest::Client,
    peer: watch::Receiver<Option<ChannelPeer>>,
    shutdown: AbortToken,
) {
    let notifier = serial_notifier(move |text| {
        let mut peer = peer.clone();
        async move {
            let connected = loop {
                let connected = peer.borrow_and_update().clone();
                if let Some(connected) = connected {
                    break connected;
                }
                peer.changed().await?;
            };
            connected
                .notify(
                    "notifications/claude/channel",
                    json!({"content":text,"meta":{"source":"cockpit"}}),
                )
                .await
        }
    });
    let mut coords = daemon::read_daemon_coords();
    let mut failures = 0_u32;
    while !shutdown.is_aborted() {
        if coords.is_none() {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                result = daemon::ensure_cockpit_daemon() => coords = result,
            }
        }
        let Some(current) = &coords else {
            let delay = daemon::next_reconnect_delay_ms(failures);
            failures = failures.saturating_add(1);
            eprintln!("cockpit-channel: cockpit daemon unavailable; retrying in {delay}ms");
            sleep(delay, &shutdown).await;
            continue;
        };
        let started = Instant::now();
        let request = async {
            let response = client
                .get(format!("http://127.0.0.1:{}/api/inbox", current.port))
                .query(&[
                    ("session", session.as_str()),
                    ("token", current.token.as_str()),
                ])
                .send()
                .await?;
            if !response.status().is_success() {
                anyhow::bail!("inbox failed: {}", response.status().as_u16());
            }
            failures = 0;
            Ok::<Value, anyhow::Error>(response.json().await?)
        };
        let result = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            result = request => result,
        };
        match result {
            Ok(body) => {
                if let Some(text) = body
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let _ = notifier.send(text.to_owned());
                }
                if body.get("timeout").and_then(Value::as_bool) == Some(true) {
                    sleep(
                        daemon::poll_floor_delay_ms(
                            started.elapsed().as_millis() as u64,
                            daemon::POLL_FLOOR_MS,
                            jitter(),
                        ),
                        &shutdown,
                    )
                    .await;
                }
            }
            Err(error) => {
                if shutdown.is_aborted() {
                    return;
                }
                let delay = daemon::next_reconnect_delay_ms(failures);
                failures = failures.saturating_add(1);
                eprintln!(
                    "cockpit-channel: inbox poll failed ({error}); reconnecting in {delay}ms"
                );
                tokio::select! {
                    _ = shutdown.cancelled() => return,
                    result = daemon::ensure_cockpit_daemon() => coords = result,
                }
                sleep(delay, &shutdown).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn notifier_enqueues_without_waiting_orders_sends_and_survives_failure() {
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let output = delivered.clone();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let pending = gate.clone();
        let tx = serial_notifier(move |text| {
            let output = output.clone();
            let pending = pending.clone();
            async move {
                if text == "first" {
                    pending.acquire().await.unwrap().forget();
                }
                output.lock().unwrap().push(text.clone());
                if text == "bad" {
                    anyhow::bail!("test failure");
                }
                Ok(())
            }
        });
        for text in ["first", "second", "bad", "last"] {
            tx.send(text.to_owned()).unwrap();
        }
        tokio::task::yield_now().await;
        assert!(delivered.lock().unwrap().is_empty());
        gate.add_permits(1);
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            *delivered.lock().unwrap(),
            ["first", "second", "bad", "last"]
        );
    }

    #[test]
    fn instant_timeouts_are_bounded_and_messages_repark_immediately() {
        let env = crate::paths::tests::TestEnv::new();
        crate::paths::tests::TestEnv::set("COCKPIT_HOME", env.dir.path());
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            std::fs::write(env.dir.path().join("daemon.json"), json!({"pid": std::process::id(), "port": port, "token": "t", "root": "/stub/scripts"}).to_string()).unwrap();
            let app = axum::Router::new().route("/api/inbox", axum::routing::get(move || {
                let recorded = recorded.clone();
                async move {
                    let count = {
                        let mut requests = recorded.lock().unwrap();
                        requests.push(Instant::now());
                        requests.len()
                    };
                    axum::Json(if count == 1 { json!({"message":"first"}) } else { json!({"timeout":true}) })
                }
            }));
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
            let (peer_tx, peer_rx) = watch::channel(None);
            let shutdown = AbortToken::default();
            let task = tokio::spawn(run("s".into(), reqwest::Client::builder().no_proxy().build().unwrap(), peer_rx, shutdown.clone()));
            tokio::time::sleep(std::time::Duration::from_millis(1400)).await;
            shutdown.abort();
            task.await.unwrap();
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 3, "one message must immediately repark; timeout polls must stay bounded");
            assert!(requests[1].duration_since(requests[0]) < std::time::Duration::from_millis(500));
            assert!(requests[2].duration_since(requests[1]) >= std::time::Duration::from_millis(1000));
            drop(peer_tx);
            server.abort();
        });
    }

    #[tokio::test]
    async fn abortable_sleep_handles_preabort_and_mid_sleep() {
        let token = AbortToken::default();
        token.abort();
        tokio::time::timeout(std::time::Duration::from_millis(50), sleep(30_000, &token))
            .await
            .unwrap();
        let token = AbortToken::default();
        let abort = token.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            abort.abort();
        });
        tokio::time::timeout(std::time::Duration::from_millis(50), sleep(30_000, &token))
            .await
            .unwrap();
    }
}
