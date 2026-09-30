# SERVER-05: Permission relay

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/04, server/02
> **Status**: todo
> **Models**: dev=opus/high

## Goal

The permission relay runs on the Rust daemon: the channel reports a Claude permission prompt, the dashboard sees it on an SSE stream and answers allow/deny, the channel pulls the verdict — and a prompt answered in the terminal (transcript moves forward, or the channel reports it resolved) is withdrawn everywhere, byte-compatibly with `permission.ts`.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/permission.rs` (modify — currently an empty stub router and an empty `PermissionState`) — routes `/api/permission-request`, `/api/permission-stream`, `/api/permission-verdict`, `/api/permission-pull`, `/api/permission-resolved`; `PermissionState` holds pending/stash/pull maps; transcript progress guard.

The module is already merged into the router and `state.permission` / `state.presence` exist in `AppState`. Do not edit `server/mod.rs`, `AppState`, `presence.rs`, or `Cargo.toml` — they belong to the server foundation. The presence registry already implements `add_subscriber`, `broadcast`, and `has_visible_subscriber`; this task wires permission-stream subscribers into it by calling those methods, which is what turns the broker's `require_watcher` gate from `no_tab` into a real park.

## Implementation notes

### State (`PermissionState`, per session)

- `pending: HashMap<session, PendingRequest { request_id, tool_name, description, input_preview, expires, guard handle, expiry task }>` — at most one per session.
- `verdict_stash: HashMap<session, { request_id, behavior, expires }>`.
- `pulls: HashMap<session, parked oneshot>` — at most one per session.
- Subscribers live in `presence` (one `UnboundedSender<String>` per open stream).
- `take_pending(session)`: an expired entry is torn down (guard + timer) and removed → none.

### Shared validation

Same as the broker: bad JSON 400 `invalid json`; token mismatch 401 `unauthorized`; session not a UUID (`^[0-9a-f-]{36}$`) → 400 `invalid session`. `request_id` must be a non-empty string → else `400` `{"error":"invalid request_id"}`.

### `POST /api/permission-request {session, token, request_id, tool_name?, description?, input_preview?}`

1. Non-string optional fields → `""`.
2. A prior pending request with a different id → resolve it elsewhere (below).
3. Store the new pending (expires = now + `COCKPIT_STASH_TTL_MS`, default 60 000).
4. Broadcast `data: {"type":"request","request_id","tool_name","description","input_preview"}` (that key order).
5. Start the transcript guard and an expiry task that tears down and removes the entry after the TTL if it is still this entry.
6. Respond `{"ok": true}`.

### Transcript progress guard

- Resolve the Claude transcript path for the session (`crate::server::sources::resolve_claude_transcript_path`); none or unstat-able → no guard.
- Record `registered_size` and `registered_at`. Watch the file (`notify`); on each event read the size; `is_forward_progress = now - registered_at >= guard_ms && new_size > registered_size` with `guard_ms = COCKPIT_TRANSCRIPT_GUARD_MS` (default 1000, `envInt` semantics). True → resolve elsewhere. A vanished file is ignored (the TTL cleans up).
- Port `isForwardProgress` as a pure function with unit tests.

### Resolve elsewhere (`resolveElsewhere(session, request_id) -> bool`)

Only when the pending entry exists with that id: tear down its guard and timer, remove it, broadcast `data: {"type":"resolved","request_id","source":"elsewhere"}`, and resolve a parked pull with `{"abandoned": true}`. Returns whether it acted.

### `GET /api/permission-stream?session&token` (SSE)

- Token 401, session 400 as JSON before any SSE bytes.
- Headers `text/event-stream`, `no-cache`, `keep-alive` (reuse the SSE envelope from `crate::server::log_stream::sse_tailer`).
- Frames: `: connected\n\n`; then, if a live pending exists, its `request` frame; heartbeat `: ping\n\n` every 25 000 ms. Register the sender with `presence.add_subscriber`; on disconnect the receiver drops, so the sender reports `is_closed()` and the next `broadcast`/probe prunes it.
- `has_visible_subscriber` = prune closed senders, true when any remain (the TS probes by enqueueing `: probe` — the closed-sender check is the Rust equivalent; do not send probe bytes unless a closed channel cannot be detected otherwise).

### `POST /api/permission-verdict {session, token, request_id, behavior}`

- `behavior` must be `allow` or `deny` → else `400` `{"error":"invalid behavior"}`.
- `take_pending` none or id mismatch → `409` `{"error":"stale request"}`.
- Tear down + remove the pending. A parked pull → resolve with `{request_id, behavior}`; else stash the verdict (TTL). Broadcast `data: {"type":"resolved","request_id","source":"ui"}`. Respond `{"delivered": <whether a pull was parked>}`.

### `GET /api/permission-pull?session&token` (long-poll)

- Token 401, session 400.
- A stashed verdict → remove; if unexpired return `{"request_id", "behavior"}`.
- Else resolve any existing park as a timeout, park up to `COCKPIT_WAIT_TIMEOUT_MS`. Results: verdict → `{"request_id","behavior"}`; abandoned → `{"abandoned": true}`; timeout, replacement, or disconnect → `{"verdict": null, "timeout": true}`. Same drop-guard rule as the broker: only remove the park if it is still this one.

### `POST /api/permission-resolved {session, token, request_id}`

→ `{"resolved": <resolveElsewhere result>}`.

## Acceptance criteria

- [ ] Every `server: permission` contract test passes against the Rust binary and still passes against TS.
- [ ] Request → stream frame → verdict → pull returns the verdict; a verdict given before the pull parks is delivered from the stash.
- [ ] A verdict for a superseded or expired request answers 409 `stale request`.
- [ ] Growing the session's transcript after the guard window withdraws the request: subscribers get a `resolved`/`elsewhere` frame and a parked pull gets `{"abandoned": true}`; growth inside the window does not.
- [ ] A dashboard that subscribes after the request was made immediately receives the pending `request` frame.
- [ ] Every `server: presence` contract test passes against the Rust binary and still passes against TS: with `answer_here` on and a live permission stream, a `require_watcher=1` wait parks and receives the answer; closing every stream for the session makes the gate answer `no_tab`.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (permission|presence|broker)"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (permission|presence)"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Verdicts lost or delivered to the wrong request; stale prompts never withdrawn | Main flow works; guard window, stash, or abandoned path drifts | Request, verdict, pull, stash, guard, resolved-elsewhere, and presence all match TS |
| Test coverage | ×2 | Contract group not run on Rust | Group passes; guard and presence untested in Rust | Group passes on both; `cargo test` covers `is_forward_progress`, expiry teardown, pull replacement, subscriber pruning |
| Interface & readability | ×1 | Edits outside `permission.rs`, or presence API changed | Works, but watcher/timer ownership is unclear | Each pending owns its guard and timer; teardown is one function; only `permission.rs` touched |
| Assumptions & docs | ×1 | Guard window hard-coded | Env honoured; closed-sender probe choice unexplained | Env fallbacks match TS; the probe replacement and ordering carry one-line whys |

## Out of scope

- The channel's side (forwarding `permission_request`, pulling verdicts, emitting the MCP notification) — ported with the channel.
- Persisting pending prompts across a daemon restart — TS keeps them in memory only.
