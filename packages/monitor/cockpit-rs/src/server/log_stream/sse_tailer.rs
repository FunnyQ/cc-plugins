use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};

pub const HEARTBEAT_MS: u64 = 25_000;
const WATCH_DEBOUNCE_MS: u64 = 80;

pub enum Resolve {
    Ready(PathBuf),
    #[allow(dead_code)] // Transcript sources can wait before they discover a path.
    Wait,
    Fail {
        message: String,
        status: u16,
    },
}

pub struct Backlog {
    pub complete: String,
    pub partial: Vec<u8>,
    pub meta: Option<Value>,
}

pub trait TailSource: Send + Sync + 'static {
    fn resolve(&self) -> Resolve;
    fn read_backlog(&self, path: &Path, size: u64) -> io::Result<Backlog>;
    fn emit(&self, out: &mut Vec<String>, complete_text: &str);
}

// Dropping the body aborts the producer, so a closed client stops its poller and watcher.
struct SseBody {
    receiver: mpsc::Receiver<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for SseBody {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl futures_core::Stream for SseBody {
    type Item = Result<String, std::convert::Infallible>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx).map(|chunk| chunk.map(Ok))
    }
}

/// Streams the preformatted SSE chunks `produce` sends; the body ends when it returns.
pub fn sse_response<F>(produce: impl FnOnce(mpsc::Sender<String>) -> F) -> axum::response::Response
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    use axum::{body::Body, response::IntoResponse};
    let (sender, receiver) = mpsc::channel(16);
    let task = tokio::spawn(produce(sender));
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache"),
            ("connection", "keep-alive"),
        ],
        Body::from_stream(SseBody { receiver, task }),
    )
        .into_response()
}

pub fn create_tail_stream(source: impl TailSource) -> axum::response::Response {
    use axum::http::StatusCode;

    let stream = match TailStream::new(source) {
        Ok(stream) => stream,
        Err((message, status)) => {
            return crate::server::json_error(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
                &message,
            );
        }
    };
    response(stream)
}

fn response<S: TailSource>(mut stream: TailStream<S>) -> axum::response::Response {
    sse_response(|sender| async move {
        loop {
            let next = tokio::select! {
                _ = sender.closed() => break,
                next = stream.next() => next,
            };
            let Some(chunk) = next else { break };
            if sender.send(chunk).await.is_err() {
                break;
            }
        }
    })
}

pub fn split_complete_lines(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().rposition(|byte| *byte == b'\n') {
        Some(index) => (&bytes[..index], &bytes[index + 1..]),
        None => (&[], bytes),
    }
}

fn cadence(name: &str, fallback: u64) -> Duration {
    let ms = std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value != 0.0)
        .unwrap_or(fallback as f64);
    // Node clamps negative and sub-millisecond timer delays to one millisecond.
    Duration::from_millis(ms.clamp(1.0, i32::MAX as f64) as u64)
}

pub fn tail_poll_ms() -> Duration {
    cadence("COCKPIT_TAIL_POLL_MS", 2000)
}

pub struct TailStream<S> {
    source: S,
    frames: VecDeque<String>,
    path: Option<PathBuf>,
    inode: u64,
    offset: u64,
    partial: Vec<u8>,
    anchored: bool,
    watcher: Option<RecommendedWatcher>,
    events: mpsc::Receiver<()>,
    watch_sender: mpsc::Sender<()>,
    watch_lifetime: Arc<()>,
    heartbeat: Instant,
    poll: Instant,
    debounce: Option<Instant>,
    resolve_cadence: Duration,
    tail_cadence: Duration,
    closed: bool,
}

impl<S: TailSource> TailStream<S> {
    pub fn new(source: S) -> Result<Self, (String, u16)> {
        Self::with_cadences(
            source,
            cadence("COCKPIT_RESOLVE_POLL_MS", 500),
            tail_poll_ms(),
        )
    }

    fn with_cadences(
        source: S,
        resolve_cadence: Duration,
        tail_cadence: Duration,
    ) -> Result<Self, (String, u16)> {
        let first = source.resolve();
        if let Resolve::Fail { message, status } = first {
            return Err((message, status));
        }
        let (watch_sender, events) = mpsc::channel(1);
        let mut stream = Self {
            source,
            frames: VecDeque::from([": connected\n\n".to_owned()]),
            path: None,
            inode: 0,
            offset: 0,
            partial: Vec::new(),
            anchored: false,
            watcher: None,
            events,
            watch_sender,
            watch_lifetime: Arc::new(()),
            heartbeat: Instant::now() + Duration::from_millis(HEARTBEAT_MS),
            poll: Instant::now() + resolve_cadence,
            debounce: None,
            resolve_cadence,
            tail_cadence,
            closed: false,
        };
        stream.apply(first);
        Ok(stream)
    }

    fn emit(&mut self, complete: &str) {
        let mut frames = Vec::new();
        self.source.emit(&mut frames, complete);
        self.frames.extend(frames);
    }

    fn backlog(&mut self, path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
        let backlog = self.source.read_backlog(path, metadata.len())?;
        self.emit(&backlog.complete);
        self.partial = backlog.partial;
        self.offset = metadata.len();
        self.inode = metadata.ino();
        self.anchored = true;
        self.marker(backlog.meta);
        Ok(())
    }

    fn marker(&mut self, meta: Option<Value>) {
        self.frames.push_back(format!(
            "event: backlog-done\ndata: {}\n\n",
            meta.unwrap_or_else(|| serde_json::json!({}))
        ));
    }

    fn watch(&mut self, path: &Path) {
        let sender = self.watch_sender.clone();
        let lifetime = Arc::clone(&self.watch_lifetime);
        self.watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let _keep_alive = &lifetime;
            if event.is_ok() {
                let _ = sender.try_send(());
            }
        })
        .ok();
        if let Some(watcher) = &mut self.watcher {
            let _ = watcher.watch(path, RecursiveMode::NonRecursive);
            if let Some(parent) = path.parent() {
                let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
            }
        }
    }

    fn resolve(&mut self) {
        let resolution = self.source.resolve();
        self.apply(resolution);
    }

    fn apply(&mut self, resolution: Resolve) {
        match resolution {
            Resolve::Ready(path) if path.exists() => {
                if let Ok(metadata) = fs::metadata(&path) {
                    self.inode = metadata.ino();
                    if self.backlog(&path, &metadata).is_err() {
                        self.marker(None);
                    }
                } else {
                    self.marker(None);
                }
                self.watch(&path);
                self.path = Some(path);
                self.poll = Instant::now() + self.tail_cadence;
            }
            Resolve::Fail { .. } => {
                self.closed = true;
                self.watcher = None;
            }
            _ => self.poll = Instant::now() + self.resolve_cadence,
        }
    }

    fn read_tail(&mut self) -> io::Result<()> {
        let Some(path) = self.path.clone() else {
            return Ok(());
        };
        let metadata = fs::metadata(&path)?;
        if !self.anchored || metadata.ino() != self.inode || metadata.len() < self.offset {
            let changed = metadata.ino() != self.inode;
            self.backlog(&path, &metadata)?;
            if changed {
                self.watch(&path);
            }
        } else if metadata.len() > self.offset {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(self.offset))?;
            let mut bytes = vec![0; (metadata.len() - self.offset) as usize];
            file.read_exact(&mut bytes)?;
            self.offset = metadata.len();
            self.partial.extend_from_slice(&bytes);
            let (complete, partial) = split_complete_lines(&self.partial);
            // Unlike TS chunk decoding, raw partial bytes preserve split UTF-8 characters.
            let complete = String::from_utf8_lossy(complete).into_owned();
            self.partial = partial.to_vec();
            self.emit(&complete);
        }
        Ok(())
    }

    pub async fn next(&mut self) -> Option<String> {
        loop {
            if let Some(frame) = self.frames.pop_front() {
                return Some(frame);
            }
            if self.closed {
                return None;
            }
            let debounce = self.debounce.unwrap_or(self.heartbeat);
            tokio::select! {
                _ = tokio::time::sleep_until(self.heartbeat) => {
                    self.heartbeat = Instant::now() + Duration::from_millis(HEARTBEAT_MS);
                    return Some(": ping\n\n".to_owned());
                }
                _ = tokio::time::sleep_until(self.poll) => {
                    if self.path.is_some() {
                        let _ = self.read_tail();
                        self.poll = Instant::now() + self.tail_cadence;
                    } else {
                        self.resolve();
                    }
                }
                _ = tokio::time::sleep_until(debounce), if self.debounce.is_some() => {
                    self.debounce = None;
                    let _ = self.read_tail();
                }
                Some(()) = self.events.recv() => {
                    // Keep the first event's deadline so continuous writes cannot starve reads.
                    self.debounce.get_or_insert(Instant::now() + Duration::from_millis(WATCH_DEBOUNCE_MS));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Source(PathBuf);
    impl TailSource for Source {
        fn resolve(&self) -> Resolve {
            Resolve::Ready(self.0.clone())
        }
        fn read_backlog(&self, path: &Path, _size: u64) -> io::Result<Backlog> {
            let bytes = fs::read(path)?;
            let (complete, partial) = split_complete_lines(&bytes);
            Ok(Backlog {
                complete: String::from_utf8_lossy(complete).into_owned(),
                partial: partial.to_vec(),
                meta: None,
            })
        }
        fn emit(&self, out: &mut Vec<String>, complete: &str) {
            out.extend(complete.lines().map(|line| format!("data: {line}\n\n")));
        }
    }

    fn stream(path: &Path) -> TailStream<Source> {
        TailStream::with_cadences(
            Source(path.to_owned()),
            Duration::from_millis(10),
            Duration::from_millis(20),
        )
        .expect("source always resolves ready")
    }

    struct FailingSource(std::sync::atomic::AtomicUsize);

    impl TailSource for FailingSource {
        fn resolve(&self) -> Resolve {
            if self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                Resolve::Wait
            } else {
                Resolve::Fail {
                    message: "failed".into(),
                    status: 400,
                }
            }
        }
        fn read_backlog(&self, _path: &Path, _size: u64) -> io::Result<Backlog> {
            unreachable!("failing source has no file")
        }
        fn emit(&self, _out: &mut Vec<String>, _complete: &str) {
            unreachable!("failing source has no backlog")
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn errors_before_sse_and_later_failure_closes_cleanly() {
        let response = create_tail_stream(FailingSource(std::sync::atomic::AtomicUsize::new(1)));
        assert_eq!(response.status(), 400);
        assert_eq!(
            response.headers()["content-type"],
            "application/json; charset=utf-8"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(bytes, "{\"error\":\"failed\"}");
        let response = create_tail_stream(FailingSource(std::sync::atomic::AtomicUsize::new(0)));
        assert_eq!(response.status(), 200);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(bytes, ": connected\n\n");
    }

    #[test]
    fn splits_only_complete_lines() {
        assert_eq!(split_complete_lines(b""), (&b""[..], &b""[..]));
        assert_eq!(split_complete_lines(b"tail"), (&b""[..], &b"tail"[..]));
        assert_eq!(
            split_complete_lines(b"a\nb\ntail"),
            (&b"a\nb"[..], &b"tail"[..])
        );
        assert_eq!(split_complete_lines(b"a\n"), (&b"a"[..], &b""[..]));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preserves_utf8_split_across_appends() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        fs::write(&path, []).unwrap();
        let mut stream = stream(&path);
        stream.frames.clear();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&[0xe4]).unwrap();
        stream.read_tail().unwrap();
        assert!(stream.frames.is_empty());
        file.write_all(&[0xb8, 0xad, b'\n']).unwrap();
        stream.read_tail().unwrap();
        assert_eq!(stream.frames.pop_front().unwrap(), "data: 中\n\n");
        assert!(stream.partial.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resets_on_shrink_and_new_inode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        fs::write(&path, b"long original\npartial").unwrap();
        let mut stream = stream(&path);
        stream.frames.clear();
        fs::write(&path, b"short\n").unwrap();
        stream.read_tail().unwrap();
        assert_eq!(stream.frames.pop_front().unwrap(), "data: short\n\n");
        assert_eq!(
            stream.frames.pop_front().unwrap(),
            "event: backlog-done\ndata: {}\n\n"
        );
        let replacement = directory.path().join("replacement");
        fs::write(&replacement, b"new\n").unwrap();
        fs::rename(replacement, &path).unwrap();
        stream.read_tail().unwrap();
        assert_eq!(stream.frames.pop_front().unwrap(), "data: new\n\n");
        assert_eq!(
            stream.frames.pop_front().unwrap(),
            "event: backlog-done\ndata: {}\n\n"
        );
        assert!(stream.partial.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resolves_a_late_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        let mut stream = stream(&path);
        assert_eq!(stream.next().await.unwrap(), ": connected\n\n");
        fs::write(path, b"late\n").unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .unwrap();
        assert_eq!(frame.unwrap(), "data: late\n\n");
        assert_eq!(
            stream.next().await.unwrap(),
            "event: backlog-done\ndata: {}\n\n"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn response_preserves_wire_frames_and_drop_releases_watcher() {
        use axum::body::HttpBody;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        fs::write(&path, b"backlog\n").unwrap();
        let stream = stream(&path);
        let lifetime = Arc::downgrade(&stream.watch_lifetime);
        let mut response = response(stream);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert_eq!(response.headers()["connection"], "keep-alive");
        for expected in [
            ": connected\n\n",
            "data: backlog\n\n",
            "event: backlog-done\ndata: {}\n\n",
        ] {
            let frame =
                std::future::poll_fn(|cx| std::pin::Pin::new(response.body_mut()).poll_frame(cx))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(frame.into_data().unwrap(), expected);
        }
        drop(response);
        tokio::time::timeout(Duration::from_secs(1), async {
            while lifetime.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn response_passes_a_chunk_over_16_mib() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        let line = "x".repeat(17 << 20);
        fs::write(&path, format!("{line}\n")).unwrap();
        let response = response(stream(&path));
        let body = response.into_body();
        let mut collected = Vec::new();
        let mut body = std::pin::pin!(body);
        while !collected.ends_with(b"event: backlog-done\ndata: {}\n\n") {
            use axum::body::HttpBody;
            let frame = tokio::time::timeout(
                Duration::from_secs(5),
                std::future::poll_fn(|cx| body.as_mut().poll_frame(cx)),
            )
            .await
            .unwrap()
            .expect("stream ended early")
            .unwrap();
            collected.extend_from_slice(&frame.into_data().unwrap());
        }
        let expected =
            format!(": connected\n\ndata: {line}\n\nevent: backlog-done\ndata: {{}}\n\n");
        assert!(collected == expected.as_bytes());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_core_releases_watcher_handle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log");
        fs::write(&path, []).unwrap();
        let stream = stream(&path);
        assert!(stream.watcher.is_some());
        let lifetime = Arc::downgrade(&stream.watch_lifetime);
        assert!(Arc::strong_count(&stream.watch_lifetime) > 1);
        drop(stream);
        tokio::time::timeout(Duration::from_secs(1), async {
            while lifetime.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
