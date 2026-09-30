# SERVER-06: Codex control and send

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01
> **Status**: todo

## Goal

The dashboard can check and message a running Codex session through the Rust daemon: `/api/codex-control/status` and `/api/send-codex-message` drive Codex's app-server JSON-RPC over the managed remote-control Unix socket, falling back to a direct `codex app-server --listen stdio://` child, with the same report shape as `codex-control-probe.ts` / `codex-send.ts`.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/codex.rs` (modify — currently an empty stub router and an empty `CodexState`) — the two routes and `run_probe`; declares `mod transport;`.
- `packages/monitor/cockpit-rs/src/server/codex/transport.rs` (new) — the two JSON-RPC transports (Unix-socket WebSocket, stdio child) behind one trait.

Only these two files change. Do not edit `server/mod.rs`, `AppState`, `presence.rs`, `sources.rs`, or `Cargo.toml` — they belong to the server foundation; every crate this needs is already in `Cargo.toml`.

## Implementation notes

### Routes (port of `codex-send.ts`)

- Session: `^[0-9a-f-]{36}$`. Token from `daemon.json`, fresh per request.
- `GET /api/codex-control/status?session&token`: token mismatch → `401` `{"error":"unauthorized"}` (checked first); bad session → `400` `{"error":"invalid session"}`. Run the probe with `thread_id = session`, no text. Respond `{"ready": ok && resumeOk == true, "controlMode", "warnings", "errors"}` (`controlMode` omitted when unset).
- `POST /api/send-codex-message {session, token, text}`: bad JSON → 400 `invalid json`; token 401; session 400; `text` = trimmed string (non-string → `""`), empty → `400` `{"error":"empty text"}`. Run the probe with `thread_id` and `send_text`. When `!ok || (!turnStartOk && !turnSteerOk)` → `502` `{"error": errors.join("; ") or "Codex send failed", "warnings"}`. Else `{"delivered": true, "controlMode", "turnId", "turnStatus", "warnings"}` (optional fields omitted when unset).

### Report

```rust
#[derive(Serialize, Default)] #[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")] codex_cli_version: Option<String>,
    daemon_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")] control_mode: Option<&'static str>, // "remote-control" | "direct-app-server"
    rpc_ready: bool,
    thread_id: Option<String>, thread_resolved: bool,
    resume_ok: Option<bool>, turn_id: Option<String>, turn_start_ok: Option<bool>,
    turn_steer_ok: Option<bool>, turn_completed_ok: Option<bool>, turn_status: Option<String>,
    warnings: Vec<String>, errors: Vec<String>,
}
```

### `run_probe` (port of `runProbe` + `executeProbeRequests`)

1. `codex --version` (trimmed stdout) → `codex_cli_version`; failure → error `codex --version failed: <msg>` (continue).
2. `codex remote-control start --json` → success: `daemon_ready = true`, mode `remote-control`, transport = socket. Failure → warning `remote-control start failed: <msg>`, mode `direct-app-server`, transport = stdio.
3. Execute on the chosen transport:
   - `initialize` with `{"clientInfo":{"name":"cockpit-codex-control-probe","title":"Cockpit Codex Control Probe","version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false,"optOutNotificationMethods":[]}}` → `rpc_ready = true`.
   - No thread → `thread/loaded/list {"limit":10}`, `ok = true`, done.
   - `thread/resume {"threadId"}` → `thread_resolved = resume_ok = true`.
   - With text: active turn = `result.thread.status.type == "active"` and the last `thread.turns[i]` with `status == "inProgress"` → its `id`. Active → `turn/steer {"threadId","input":[{"type":"text","text","text_elements":[]}],"expectedTurnId"}`, `turn_id = result.turnId || active`, `turn_steer_ok`. Else `turn/start {"threadId","input":[…]}`, `turn_id = result.turn.id`, `turn_start_ok`.
   - With a turn id and a notification-capable transport: keep the transport alive in a detached task that waits (≤ 30 min) for `turn/completed` whose `params.threadId` and `params.turn.id` match, or `error` whose `params.turnId` matches, then closes it; the HTTP response does not wait. `ok = true`.
4. On error in step 3: if a turn was already submitted (`turn_id`, `turn_start_ok`, or `turn_steer_ok` set) → `ok = false`, error `<mode or "Codex control"> failed after Codex turn was submitted: <msg>`, return (never resend). If the mode was already `direct-app-server` → error `direct app-server failed: <msg>`, return. Else warning `remote-control proxy failed: <msg>`, then retry step 3 once on the stdio transport with mode `direct-app-server` after resetting `rpc_ready`, `thread_resolved`, and every turn field; a failure there → error `direct app-server failed: <msg>`.

### Transports (`transport.rs`)

```rust
// enum dispatch instead of a trait object, so no async-trait crate is needed
pub enum Transport { Socket(..), Stdio(..) }
impl Transport {
    pub async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value>; // 10 s timeout: "<method> timed out"
    pub async fn wait_for_notification(&mut self, pred: impl Fn(&Value) -> bool, timeout: Duration) -> anyhow::Result<Value>;
    pub fn close(self);
}
```

- **Socket**: `<codex dir>/app-server-control/app-server-control.sock` (codex dir = `COCKPIT_CODEX_DIR` or `~/.codex`, via `crate::server::sources::codex_dir`). Missing → error `remote-control socket not found at <path>`. Connect with `tokio::net::UnixStream`, then `tokio_tungstenite::client_async("ws://localhost/", stream)` (handshake `GET /`, `Host: localhost`, 10 s timeout → `remote-control websocket handshake timed out`; non-101 → `remote-control websocket upgrade failed`). Requests are text frames `{"id","method","params"}` — **no `jsonrpc` field** on this transport. Close/error rejects pending requests with `Codex remote-control socket closed`.
- **Stdio**: spawn `codex app-server --listen stdio://` with piped stdio, stderr drained. Requests are one line each: `{"jsonrpc":"2.0","id","method","params"}\n`. Child exit rejects pending requests with `codex app-server proxy closed (<code or "signal">)`. `close()` kills the child.
- Both: a message with an `id` resolves that pending request (`error.message` or `JSON-RPC error` → Err); a message without `id` is a notification offered to waiters. Invalid JSON is ignored. Ids start at 1.
- OS error texts (e.g. spawn failure of a missing `codex`) differ between Node and Rust; keep every prefix above exact and let the OS message follow.

## Acceptance criteria

- [ ] Every `server: codex` contract test passes against the Rust binary and still passes against TS.
- [ ] With no `codex` on `PATH`, status answers `{"ready": false, …}` with `errors` starting `codex --version failed:` and `direct app-server failed:`, and send answers 502 — never a hang or 500.
- [ ] Against a fake app-server (a `cargo test` stdio child script or an in-test Unix-socket WebSocket server), a send to an idle thread issues `turn/start`, a send to a thread with an in-progress turn issues `turn/steer` with `expectedTurnId`, and a failure after submission never retries on the fallback transport.
- [ ] Token and session validation return the same status codes and bodies as TS.
- [ ] (human) Send a message from the dashboard to a running interactive codex TUI and see it arrive.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: codex"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: codex"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Duplicate turns sent, or requests hang without timeout | Happy path works; fallback ordering, steer/start choice, or report fields drift | Fallback, no-resend-after-submit, steer/start, timeouts, and report shape match TS |
| Test coverage | ×2 | Contract group not run on Rust | Group passes; transports untested | Group passes on both; `cargo test` drives both transports against fakes, including the post-submit failure path |
| Interface & readability | ×1 | Two copies of the request/notification bookkeeping | Shared, but transport details leak into `run_probe` | One transport type, `run_probe` reads like the TS sequence |
| Assumptions & docs | ×1 | Protocol differences between transports undocumented | Present but unexplained | The missing `jsonrpc` field on the socket and the detached completion wait carry one-line whys |

## Out of scope

- The standalone probe CLI (`bun codex-control-probe.ts --thread … --send …`) — Deferred. Reason: it is a debugging entry point, not part of the `cockpit` subcommand list; it is removed with the rest of the TS.
- `waitForCompletion` blocking mode — only the CLI used it.
