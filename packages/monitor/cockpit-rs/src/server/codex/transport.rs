use std::{
    collections::VecDeque,
    io,
    path::Path,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines, ReadBuf},
    net::UnixStream,
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};
use tokio_tungstenite::tungstenite::{self, Message, WebSocket, protocol::Role};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKET_CLOSED: &str = "Codex remote-control socket closed";

pub enum Transport {
    Socket(SocketTransport),
    Stdio(StdioTransport),
}

pub struct SocketTransport {
    websocket: WebSocket<SocketIo>,
    next_id: u64,
    notifications: VecDeque<Value>,
}

pub struct StdioTransport {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    stderr_task: JoinHandle<()>,
    next_id: u64,
    notifications: VecDeque<Value>,
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.stderr_task.abort();
    }
}

// Preserve frames received with the upgrade response when switching to the synchronous codec.
struct HandshakeStream {
    stream: UnixStream,
    bytes: Vec<u8>,
    header_end: Option<usize>,
    delivered: usize,
}

impl AsyncRead for HandshakeStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        while this.header_end.is_none() {
            let mut chunk = [0; 4096];
            let mut incoming = ReadBuf::new(&mut chunk);
            match Pin::new(&mut this.stream).poll_read(cx, &mut incoming) {
                Poll::Ready(Ok(())) => {
                    if incoming.filled().is_empty() {
                        this.header_end = Some(this.bytes.len());
                    } else {
                        this.bytes.extend_from_slice(incoming.filled());
                        this.header_end = this
                            .bytes
                            .windows(4)
                            .position(|bytes| bytes == b"\r\n\r\n")
                            .map(|index| index + 4);
                        if this.bytes.len() > 65536 {
                            return Poll::Ready(Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "remote-control websocket response header too large",
                            )));
                        }
                    }
                }
                other => return other,
            }
        }
        let end = this.header_end.expect("response header collected");
        let count = buf.remaining().min(end - this.delivered);
        buf.put_slice(&this.bytes[this.delivered..this.delivered + count]);
        this.delivered += count;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for HandshakeStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

// Bridge existing crates without adding futures-util to this task's fixed Cargo.toml.
struct SocketIo {
    stream: UnixStream,
    blocked_write: bool,
}

impl io::Read for SocketIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.blocked_write = false;
        self.stream.try_read(buf)
    }
}

impl io::Write for SocketIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.blocked_write = true;
        self.stream.try_write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SocketTransport {
    async fn ready(&self) -> Result<(), String> {
        let io = self.websocket.get_ref();
        let result = if io.blocked_write {
            io.stream.writable().await
        } else {
            io.stream.readable().await
        };
        result.map_err(|_| SOCKET_CLOSED.to_owned())
    }

    async fn flush(&mut self) -> Result<(), String> {
        loop {
            match self.websocket.flush() {
                Ok(()) => return Ok(()),
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.ready().await?
                }
                Err(_) => return Err(SOCKET_CLOSED.to_owned()),
            }
        }
    }

    async fn send(&mut self, value: Value) -> Result<(), String> {
        match self
            .websocket
            .write(Message::Text(value.to_string().into()))
        {
            Ok(()) => (),
            Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(_) => return Err(SOCKET_CLOSED.to_owned()),
        }
        self.flush().await
    }

    async fn receive(&mut self) -> Result<Value, String> {
        loop {
            match self.websocket.read() {
                Ok(Message::Text(text)) => {
                    if let Ok(value) = serde_json::from_str(&text) {
                        return Ok(value);
                    }
                }
                Ok(Message::Close(_)) => return Err(SOCKET_CLOSED.to_owned()),
                Ok(Message::Ping(_)) => self.flush().await?,
                Ok(_) => (),
                Err(tungstenite::Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.ready().await?
                }
                Err(_) => return Err(SOCKET_CLOSED.to_owned()),
            }
        }
    }
}

impl Transport {
    pub async fn socket(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!(
                "remote-control socket not found at {}",
                path.display()
            ));
        }
        let stream = UnixStream::connect(path).await.map_err(|e| e.to_string())?;
        let (websocket, _) = tokio::time::timeout(
            REQUEST_TIMEOUT,
            tokio_tungstenite::client_async(
                "ws://localhost/",
                HandshakeStream {
                    stream,
                    bytes: Vec::new(),
                    header_end: None,
                    delivered: 0,
                },
            ),
        )
        .await
        .map_err(|_| "remote-control websocket handshake timed out".to_owned())?
        .map_err(|error| match error {
            tungstenite::Error::Http(_) => "remote-control websocket upgrade failed".to_owned(),
            other => other.to_string(),
        })?;
        let handshake = websocket.into_inner();
        let remaining = handshake.bytes[handshake.delivered..].to_vec();
        let stream = handshake.stream;
        Ok(Self::Socket(SocketTransport {
            websocket: WebSocket::from_partially_read(
                SocketIo {
                    stream,
                    blocked_write: false,
                },
                remaining,
                Role::Client,
                None,
            ),
            next_id: 1,
            notifications: VecDeque::new(),
        }))
    }

    pub async fn stdio() -> Result<Self, String> {
        let mut command = Command::new("codex");
        command.args(["app-server", "--listen", "stdio://"]);
        Self::stdio_command(&mut command).await
    }

    pub(super) async fn stdio_command(command: &mut Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().expect("piped child stdin");
        let stdout = child.stdout.take().expect("piped child stdout");
        let mut stderr = child.stderr.take().expect("piped child stderr");
        let stderr_task = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
        Ok(Self::Stdio(StdioTransport {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            stderr_task,
            next_id: 1,
            notifications: VecDeque::new(),
        }))
    }

    fn notifications(&mut self) -> &mut VecDeque<Value> {
        match self {
            Self::Socket(socket) => &mut socket.notifications,
            Self::Stdio(stdio) => &mut stdio.notifications,
        }
    }

    async fn receive(&mut self) -> Result<Value, String> {
        match self {
            Self::Socket(socket) => socket.receive().await,
            Self::Stdio(stdio) => loop {
                match stdio.lines.next_line().await {
                    Ok(Some(line)) => {
                        if let Ok(value) = serde_json::from_str(&line) {
                            return Ok(value);
                        }
                    }
                    Ok(None) => {
                        let status = stdio.child.wait().await.map_err(|e| e.to_string())?;
                        let code = status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "signal".to_owned());
                        return Err(format!("codex app-server proxy closed ({code})"));
                    }
                    Err(error) => return Err(error.to_string()),
                }
            },
        }
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.request_inner(method, params))
            .await
            .map_err(|_| format!("{method} timed out"))?
    }

    async fn request_inner(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let next_id = match self {
            Self::Socket(socket) => &mut socket.next_id,
            Self::Stdio(stdio) => &mut stdio.next_id,
        };
        let id = *next_id;
        *next_id += 1;
        match self {
            // The remote-control proxy rejects the jsonrpc field accepted by the direct app-server.
            Self::Socket(socket) => {
                socket
                    .send(json!({ "id": id, "method": method, "params": params }))
                    .await?
            }
            Self::Stdio(stdio) => {
                let line = format!(
                    "{}\n",
                    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
                );
                stdio
                    .stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                stdio.stdin.flush().await.map_err(|e| e.to_string())?;
            }
        }
        loop {
            let message = self.receive().await?;
            if message.get("id").is_none() {
                self.notifications().push_back(message);
            } else if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
                    return Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|message| !message.is_empty())
                        .unwrap_or("JSON-RPC error")
                        .to_owned());
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    pub async fn wait_for_notification(
        &mut self,
        pred: impl Fn(&Value) -> bool,
        timeout: Duration,
    ) -> Result<Value, String> {
        tokio::time::timeout(timeout, async {
            while let Some(message) = self.notifications().pop_front() {
                if pred(&message) {
                    return Ok(message);
                }
            }
            loop {
                let message = self.receive().await?;
                if message.get("id").is_none() && pred(&message) {
                    return Ok(message);
                }
            }
        })
        .await
        .map_err(|_| "turn completion timed out".to_owned())?
    }

    pub fn close(self) {
        drop(self);
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ProbeReport, attempt_failed, execute_probe_requests};
    use super::*;

    const CHILD_SCRIPT: &str = r#"
import json, sys
active = sys.argv[1] == 'active'
for line in sys.stdin:
    request = json.loads(line)
    assert request['jsonrpc'] == '2.0'
    method = request['method']
    result = {}
    if method == 'thread/resume':
        result = {'thread': {'status': {'type': 'active' if active else 'idle'}, 'turns': [{'id': 'live-turn', 'status': 'inProgress'}] if active else []}}
    elif method in ('turn/start', 'turn/steer'):
        assert method == ('turn/steer' if active else 'turn/start')
        assert request['params']['input'] == [{'type': 'text', 'text': 'hello', 'text_elements': []}]
        if active: assert request['params']['expectedTurnId'] == 'live-turn'
        result = {'turnId': 'live-turn'} if active else {'turn': {'id': 'new-turn'}}
    print('invalid JSON', flush=True)
    print(json.dumps({'id': 999, 'result': {}}), flush=True)
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
    if method in ('turn/start', 'turn/steer'):
        print(json.dumps({'method': 'turn/completed', 'params': {'threadId': 'thread', 'turn': {'id': 'live-turn' if active else 'new-turn', 'status': 'completed'}}}), flush=True)
        break
"#;

    async fn assert_send(mut transport: Transport, active: bool) {
        let mut report = ProbeReport {
            control_mode: Some("remote-control"),
            ..Default::default()
        };
        execute_probe_requests(&mut transport, Some("thread"), Some("hello"), &mut report)
            .await
            .unwrap();
        assert_eq!(
            report.turn_id.as_deref(),
            Some(if active { "live-turn" } else { "new-turn" })
        );
        assert_eq!(report.turn_start_ok, if active { None } else { Some(true) });
        assert_eq!(report.turn_steer_ok, if active { Some(true) } else { None });
        let completion = transport
            .wait_for_notification(
                |message| message["method"] == "turn/completed",
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(completion["params"]["turn"]["status"], "completed");
        let error = transport
            .wait_for_notification(|_| false, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(!attempt_failed(&mut report, error));
        assert!(
            report.errors[0].starts_with("remote-control failed after Codex turn was submitted:")
        );
        assert!(report.warnings.is_empty());
        transport.close();
    }

    #[tokio::test]
    async fn stdio_idle_starts_and_active_steers() {
        for active in [false, true] {
            let mut command = Command::new("python3");
            command.args([
                "-u",
                "-c",
                CHILD_SCRIPT,
                if active { "active" } else { "idle" },
            ]);
            assert_send(
                Transport::stdio_command(&mut command).await.unwrap(),
                active,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn socket_idle_starts_and_active_steers() {
        for active in [false, true] {
            let directory = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
            let absolute_path = directory.path().join("control.sock");
            let current_dir = std::env::current_dir().unwrap();
            let path = absolute_path
                .strip_prefix(&current_dir)
                .unwrap()
                .to_path_buf();
            let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut websocket = tungstenite::accept(stream).unwrap();
                for id in 1..=3 {
                    let message = websocket.read().unwrap().into_text().unwrap();
                    let request: Value = serde_json::from_str(&message).unwrap();
                    assert!(request.get("jsonrpc").is_none());
                    assert_eq!(request["id"], id);
                    let result = match request["method"].as_str().unwrap() {
                        "initialize" => json!({}),
                        "thread/resume" => {
                            json!({"thread": {"status": {"type": if active { "active" } else { "idle" }}, "turns": if active { json!([{ "id": "live-turn", "status": "inProgress" }]) } else { json!([]) }}})
                        }
                        method => {
                            assert_eq!(method, if active { "turn/steer" } else { "turn/start" });
                            assert_eq!(
                                request["params"]["input"],
                                json!([{ "type": "text", "text": "hello", "text_elements": [] }])
                            );
                            if active {
                                assert_eq!(request["params"]["expectedTurnId"], "live-turn");
                                json!({"turnId": "live-turn"})
                            } else {
                                json!({"turn": {"id": "new-turn"}})
                            }
                        }
                    };
                    websocket
                        .send(Message::Text("invalid JSON".into()))
                        .unwrap();
                    websocket
                        .send(Message::Text(
                            json!({ "id": id, "result": result }).to_string().into(),
                        ))
                        .unwrap();
                }
                websocket.send(Message::Text(json!({"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": if active { "live-turn" } else { "new-turn" }, "status": "completed"}}}).to_string().into())).unwrap();
            });
            assert_send(Transport::socket(&path).await.unwrap(), active).await;
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn stdio_reports_exit_code_and_rpc_error() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", "import sys; sys.stdin.readline(); sys.exit(7)"]);
        let mut transport = Transport::stdio_command(&mut command).await.unwrap();
        assert_eq!(
            transport
                .request("initialize", json!({}))
                .await
                .unwrap_err(),
            "codex app-server proxy closed (7)"
        );
        transport.close();
        let mut command = Command::new("python3");
        command.args(["-u", "-c", "import sys,json; r=json.loads(sys.stdin.readline()); print(json.dumps({'id':r['id'],'error':{'message':'denied'}}),flush=True)"]);
        let mut transport = Transport::stdio_command(&mut command).await.unwrap();
        assert_eq!(
            transport
                .request("initialize", json!({}))
                .await
                .unwrap_err(),
            "denied"
        );
        transport.close();
    }
}
