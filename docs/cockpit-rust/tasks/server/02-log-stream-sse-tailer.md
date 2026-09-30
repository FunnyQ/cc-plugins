# SERVER-02: Log stream and SSE tailer

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01
> **Blocks**: server/03, server/05
> **Status**: todo

## Goal

`GET /api/log/stream?project=<abs>&session=<uuid>` streams a session's decision trail as Server-Sent Events exactly like the Bun daemon — backlog, `backlog-done`, then live appends — through a reusable resilient tailer that the transcript stream will also use.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/log_stream/sse_tailer.rs` (new) — port of `sse-tailer.ts`: `create_tail_stream`, `split_complete_lines`, the SSE envelope, heartbeat and poll cadences.
- `packages/monitor/cockpit-rs/src/server/log_stream.rs` (modify — currently an empty stub router) — port of `log-stream.ts`; declares `pub mod sse_tailer;` and fills `router()` with `/api/log/stream`. `LogStreamState` stays empty unless a field is needed.

The tailer is a child module of `log_stream` so `server/mod.rs`, `AppState`, and `Cargo.toml` (all owned by the server foundation) stay untouched; other route groups import it as `crate::server::log_stream::sse_tailer`.

## Implementation notes

### SSE envelope

- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Build with `axum::response::sse::Sse` over a `Stream<Item = Result<Event, Infallible>>`, or a raw `Body::from_stream` — either way the bytes on the wire must be:
  - first frame `: connected\n\n`
  - data frames `data: <compact JSON>\n\n`
  - marker `event: backlog-done\ndata: <json>\n\n` (`{}` for the log stream)
  - heartbeat `: ping\n\n` every **25 000 ms** (`HEARTBEAT_MS`, exported for the permission stream).
- Stop every timer and watcher when the client disconnects (the stream is dropped) — use a drop guard owning the watcher and task handles.

### Tailer contract (port of `createTailStream`)

```rust
pub enum Resolve { Ready(PathBuf), Wait, Fail { message: String, status: u16 } }
pub struct Backlog { pub complete: String, pub partial: Vec<u8>, pub meta: Option<serde_json::Value> } // partial = raw bytes after the last '\n'
pub trait TailSource: Send + Sync + 'static {
    fn resolve(&self) -> Resolve;                        // re-run until Ready + file exists
    fn read_backlog(&self, path: &Path, size: u64) -> std::io::Result<Backlog>;
    fn emit(&self, out: &mut Vec<String>, complete_text: &str); // push SSE frames
}
pub fn create_tail_stream(source: impl TailSource) -> axum::response::Response;
pub fn split_complete_lines(bytes: &[u8]) -> (&[u8], &[u8]); // (before last 0x0a, after it)
```

Behavior to keep, in order:

1. First `resolve()` returning `Fail` → plain JSON error response `{"error": message}` with that status (400 default) **before** any SSE bytes. `Wait` and `Ready` both open the stream — a missing file is never a 404.
2. Emit `: connected`. Start the 25 s heartbeat. If not yet ready, poll `resolve()` every `COCKPIT_RESOLVE_POLL_MS` (default 500; `Number(env) || 500`, so `0`/garbage → default) until it yields `Ready` for an existing path; a later `Fail` closes the stream silently.
3. On ready: record inode, `read_backlog(path, size)`, emit it, set `partial`, `offset = size`, `anchored = true`; emit `backlog-done` with `meta` or `{}` (a backlog read error → empty backlog, still emit `backlog-done`). Watch the file and its parent directory (`notify`); start a tail poll every `COCKPIT_TAIL_POLL_MS` (default 2000).
4. Watch events debounce **80 ms** before a read; watcher attach failures are ignored (the poll covers them).
5. Each read: if not anchored, inode changed, or size shrank below `offset` → reset: re-run `read_backlog` on the whole current file, re-bind the file watcher when the inode changed, emit backlog frames and a fresh `backlog-done`. Else if size grew → read `[offset, size)` as bytes, append them to the `partial` byte buffer, split at the last `0x0a`, decode only the complete part (lossy UTF-8) and emit it, keep the remainder as raw bytes in `partial`. Any I/O error → skip this pass.
   - **Deliberate deviation from TS** (see `_context/contracts.md` §3): TS decodes each chunk separately, so a multibyte character split across two appends becomes U+FFFD. Keeping the tail as bytes delivers it intact. Leave a one-line comment at this spot saying so.

### Log stream (port of `log-stream.ts`)

- Params: `project` (default `""`), `session` must match `^[0-9a-f-]{36}$`.
- `resolve_log_path(project, session)`:
  - Find the registry entry with that `sessionId`. It is used only when its `project` and the requested `project` are related (equal, or one strictly inside the other, segment-wise after path resolution); an entry that exists but is unrelated → reject.
  - Root = entry's `project` when the entry has a `logPath`, else the requested project. `logs_dir = <root>/.cockpit/logs`. Path = the entry's `logPath` resolved, else `<logs_dir>/<session>.jsonl`.
  - Lexically confined inside `logs_dir`; when the file exists, `realpath(file)` must be inside `realpath(logs_dir)`.
  - Rejection → `Fail { "invalid project/session", 400 }`; success → `Ready(path)` even when the file does not exist yet.
- Backlog: read the whole file as bytes (logs are small), `split_complete_lines`, decode the complete part, keep the tail bytes as `partial`.
- Emit: for each line, trim; skip blank or invalid JSON; emit `data: <re-serialised compact JSON>`. Re-serialising through `serde_json::Value` (with `preserve_order`) is the parity target; contract tests compare parsed payloads, so number formatting such as `1.0` vs `1` is acceptable.

## Acceptance criteria

- [ ] Every `server: log-stream` contract test passes against the Rust binary and still passes against TS.
- [ ] An invalid session id or an unrelated project returns HTTP 400 JSON before any SSE bytes.
- [ ] A log file created after the connection opens is picked up (resolve poll), and appended lines arrive as `data:` frames without waiting for the 2 s poll when file watching works.
- [ ] Truncating or atomically replacing the log re-emits the backlog and a new `backlog-done` frame instead of stalling or duplicating from a stale offset.
- [ ] A `cargo test` shows a multibyte UTF-8 character split across two appends is emitted intact once its line completes. This deliberate deviation is not a contract case: TS emits U+FFFD there, so no shared assertion can pass both.
- [ ] Closing the client stops the heartbeat, polls, and watchers (no leaked tasks — verified by a `cargo test` that drops the stream and asserts the watcher handle is released).

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: log-stream"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: log-stream"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Missing file 404s, or frames differ from TS | Backlog and appends work; rotation, late file, or confinement drift | Wire bytes, confinement, rotation reset, and late-file resolve all match TS |
| Test coverage | ×2 | No Rust run of the group | Contract group passes; no unit tests for split/reset logic | Contract group passes on both; `cargo test` covers `split_complete_lines`, reset on shrink/new inode, UTF-8 split, drop cleanup |
| Interface & readability | ×1 | Transcript stream would have to copy the tailer | Tailer reusable but tangled with log specifics | `TailSource` cleanly separates resolve/backlog/emit; no lock across `.await` |
| Assumptions & docs | ×1 | Cadences hard-coded without env overrides | Env honoured, deviations unexplained | Env fallbacks match TS; re-serialisation and debounce choices commented |

## Out of scope

- Transcript streaming — Deferred to a later task in this bucket; it reuses `create_tail_stream` from here.
- Changing the SSE framing or adding event ids — the SPA depends on the current frames.
