// MCP transport: rmcp 3.5.0 (experimental caps + custom notifications verified)
use rmcp::{
    Peer, RoleServer, ServerHandler, ServiceExt,
    model::{
        CustomNotification, Implementation, ServerCapabilities, ServerConfig, ServerNotification,
    },
    service::NotificationContext,
};
use serde_json::{Value, json};
use std::{
    process::ExitCode,
    sync::{Arc, Mutex},
};

mod daemon;
mod inbox;
mod permission;
mod session;

type NotificationHandler = Box<dyn Fn(String, Option<Value>) + Send>;

#[derive(Clone, Default)]
struct ChannelServer {
    handler: Arc<Mutex<Option<NotificationHandler>>>,
}

impl ChannelServer {
    fn on_notification(&mut self, f: impl Fn(String, Option<Value>) + Send + 'static) {
        *self
            .handler
            .lock()
            .expect("notification handler mutex is not poisoned") = Some(Box::new(f));
    }
}

impl ServerHandler for ChannelServer {
    fn get_info(&self) -> ServerConfig {
        let capabilities: ServerCapabilities = serde_json::from_value(json!({
            "experimental": {"claude/channel": {}, "claude/channel/permission": {}},
            "tools": {}
        }))
        .expect("static capabilities are valid");
        ServerConfig::new(capabilities)
            .with_server_info(Implementation::new("cockpit-channel", "0.0.1"))
            .with_instructions("Messages from the cockpit dashboard arrive as <channel source=\"cockpit\">...</channel>.")
    }

    async fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _: NotificationContext<RoleServer>,
    ) {
        if let Some(handler) = self
            .handler
            .lock()
            .expect("notification handler mutex is not poisoned")
            .as_ref()
        {
            handler(notification.method, notification.params);
        }
    }
}

// Keep future channel callers independent of rmcp's notification types.
#[derive(Clone)]
pub struct ChannelPeer {
    peer: Peer<RoleServer>,
}

impl ChannelPeer {
    pub async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        self.peer
            .send_notification(ServerNotification::CustomNotification(
                CustomNotification::new(method, Some(params)),
            ))
            .await?;
        Ok(())
    }
}

pub fn run() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cockpit channel: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result: anyhow::Result<()> = runtime.block_on(async {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        let serve = async {
            let session = session::resolve_session_id().await;
            if session.is_none() {
                eprintln!(
                    "cockpit-channel: could not resolve a Claude session id; channel will stay idle"
                );
            }
            if daemon::ensure_cockpit_daemon().await.is_none() {
                eprintln!("cockpit-channel: cockpit daemon unavailable; retrying in loop");
            }
            // Reuse the installed TLS-free client instead of adding another HTTP stack.
            let client = reqwest::Client::builder().no_proxy().http1_only().build()?;
            let mut server = ChannelServer::default();
            let (peer_tx, peer_rx) = tokio::sync::watch::channel(None);
            if let Some(id) = &session {
                permission::register(&mut server, id.clone(), client.clone(), peer_rx.clone());
            }
            let shutdown = AbortToken::default();
            if let Some(id) = session {
                tokio::spawn(inbox::run(id, client, peer_rx, shutdown.clone()));
            }
            let service = match server.serve(rmcp::transport::stdio()).await {
                Ok(service) => service,
                Err(
                    rmcp::service::ServerInitializeError::ConnectionClosed(_)
                    | rmcp::service::ServerInitializeError::ExpectedInitializeRequest(None),
                ) => return Ok(()),
                Err(error) => return Err(error.into()),
            };
            let peer = ChannelPeer {
                peer: service.peer().clone(),
            };
            peer_tx.send_replace(Some(peer.clone()));
            let result = service.waiting().await;
            shutdown.abort();
            result?;
            anyhow::Ok(())
        };
        tokio::select! {
            result = serve => result,
            _ = term.recv() => Ok(()),
            _ = interrupt.recv() => Ok(()),
        }
    });
    // Tokio stdin's blocking read cannot be cancelled when a signal arrives.
    runtime.shutdown_background();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cockpit channel: {error}");
            ExitCode::FAILURE
        }
    }
}

// Watch retains cancellation even when abort precedes the first waiter.
#[derive(Clone)]
pub(super) struct AbortToken(tokio::sync::watch::Sender<bool>);

impl Default for AbortToken {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
}

impl AbortToken {
    pub(super) fn abort(&self) {
        self.0.send_replace(true);
    }
    pub(super) fn is_aborted(&self) -> bool {
        *self.0.borrow()
    }
    pub(super) async fn cancelled(&self) {
        let _ = self.0.subscribe().wait_for(|aborted| *aborted).await;
    }
}

pub(super) async fn sleep(ms: u64, token: &AbortToken) {
    tokio::select! {
        biased;
        _ = token.cancelled() => {},
        _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {},
    }
}

// UUID supplies jitter without installing a second random-number dependency.
pub(super) fn jitter() -> f64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    f64::from(u16::from_le_bytes([bytes[0], bytes[1]])) / 65536.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn channel_handshake_and_custom_notifications() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let (client, transport) = tokio::io::duplex(8192);
            let (read, mut write) = tokio::io::split(client);
            let mut lines = BufReader::new(read).lines();
            let server = ChannelServer::default();
            let handler = server.handler.clone();
            let serving = tokio::spawn(async move { server.serve(transport).await.unwrap() });
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}}\n").await.unwrap();
            let response: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(response, json!({"jsonrpc":"2.0","id":1,"result":{
                "protocolVersion":"2025-06-18", "serverInfo":{"name":"cockpit-channel","version":"0.0.1"},
                "instructions":"Messages from the cockpit dashboard arrive as <channel source=\"cockpit\">...</channel>.",
                "capabilities":{"experimental":{"claude/channel":{},"claude/channel/permission":{}},"tools":{}}
            }}));
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await.unwrap();
            let service = serving.await.unwrap();
            let peer = ChannelPeer { peer: service.peer().clone() };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            ChannelServer { handler }.on_notification(move |method, params| { if method == "notifications/claude/channel/permission_request" { tx.send((method, params)).unwrap(); } });
            for (method, params) in [
                ("notifications/claude/channel", json!({"content":"text","meta":{"source":"cockpit"}})),
                ("notifications/claude/channel/permission", json!({"request_id":"id","behavior":"allow"})),
                ("notifications/claude/channel/permission", json!({"request_id":"id","behavior":"deny"})),
            ] {
                peer.notify(method, params.clone()).await.unwrap();
                let line = lines.next_line().await.unwrap().unwrap();
                assert_eq!(line, json!({"jsonrpc":"2.0","method":method,"params":params}).to_string());
            }
            let params = json!({"request_id":"id","tool_name":"Bash","description":"Run command","input_preview":"pwd"});
            write.write_all(format!("{}\n", json!({"jsonrpc":"2.0","method":"notifications/claude/channel/permission_request","params":params})).as_bytes()).await.unwrap();
            assert_eq!(rx.recv().await.unwrap(), ("notifications/claude/channel/permission_request".into(), Some(params)));
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/foo\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n").await.unwrap();
            let response: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(response, json!({"jsonrpc":"2.0","id":2,"result":{"tools":[]}}));
            assert!(rx.try_recv().is_err());
            drop(write);
            drop(lines);
            service.waiting().await.unwrap();
        });
    }
}
