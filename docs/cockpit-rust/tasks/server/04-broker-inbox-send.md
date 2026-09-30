# SERVER-04: Broker, inbox, send-message

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01
> **Blocks**: server/05, server/08
> **Status**: done
> **Models**: dev=opus/high

## Goal

The per-session control loop works on the Rust daemon: `/api/wait` parks a `cockpit wait` until `/api/respond` answers it (with stash, superseded, and presence rules), `/api/inbox` parks the channel until `/api/send-message` delivers UI text, and `/api/answer-here` reads and sets the global switch — all with the Bun daemon's JSON, status codes, and races.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/broker.rs` (modify — currently an empty stub router and an empty `BrokerState`) — routes `/api/wait`, `/api/respond`, `/api/answer-here`; `BrokerState` holds parked waits and stashed answers.
- `packages/monitor/cockpit-rs/src/server/inbox.rs` (modify — currently an empty stub router and an empty `InboxState`) — routes `/api/inbox`, `/api/send-message`; `InboxState` holds parked polls and stashed messages.

Both modules are already merged into the router and have their fields in `AppState` (`state.broker`, `state.inbox`, `state.presence`). Do not edit `server/mod.rs`, `AppState`, `presence.rs`, or `Cargo.toml` — they belong to the server foundation. Channel presence is already implemented there; this task only calls `presence.mark_channel_seen`, `presence.set_channel_parked`, and reads `presence.has_visible_subscriber`. If a small park helper is shared by wait and inbox, put it in `broker.rs` and import it from `inbox.rs`.

## Implementation notes

### Shared rules

- Session must match `^[0-9a-f-]{36}$`.
- Token = `daemon.json`'s `token`, read fresh per request through the core crate's daemon-info helper (a restart changes it). Mismatch → `401` `{"error":"unauthorized"}`. Check order is token first, then session → `400` `{"error":"invalid session"}`.
- POST bodies: unparseable JSON → `400` `{"error":"invalid json"}`. GET reads query params.
- Long-poll budget: `COCKPIT_WAIT_TIMEOUT_MS` (default 240 000). Stash TTL: `COCKPIT_STASH_TTL_MS` (default 60 000).
- A parked request whose client disconnects must drop its map entry. In axum the handler future is dropped on disconnect, so park with a `oneshot` and a drop guard that removes the entry **only if it is still this park's** (compare an id/generation, mirroring the TS `pendingWaits.get(session)?.resolve === resolver` check). Never hold a `Mutex` across `.await`.
- Replacing a park: a second wait (or inbox poll) for the same session first resolves the previous park as a timeout (`resolve(null)`).

### `GET /api/wait?session&token[&call][&require_watcher=1]` (port of `handleWait`)

In this exact order:

1. Token, session validation.
2. Stash drain: a stashed answer for the session whose `callId` matches (`call_matches(a, b)` = either is null or equal — the core crate's call-log module) is removed; if unexpired → `{"answer": "<text>"}`. A non-matching stash is left to expire.
3. Superseded: when `call` is given and the registry has a `logPath` for the session and the log's latest open call id (call-log rule) ≠ `call` → `{"answer": null, "superseded": true}`.
4. Presence gate, only when `require_watcher=1`: reason `toggle_off` when config `answer_here` is not true, else `no_tab` when `presence.has_visible_subscriber(session)` is false → `{"answer": null, "not_watching": true, "reason": "<reason>"}`.
5. Park. Resolves with `{"answer": "<text>"}` on a matching respond, or `{"answer": null, "timeout": true}` on budget expiry, replacement, or disconnect.

### `POST /api/respond {session, answer, token, call?}` (port of `handleRespond`)

- `answer` non-string → `""`; `call` non-string → null.
- `log_path` = registry entry's `logPath`; `open_call` = latest open call id in that log (null when no log or unreadable); `target_call = body.call ?? open_call`.
- When a log path exists, append one line `{"id": <uuid v4>, "type": "response", "call": <target_call or null>, "answer": <answer>, "ts": <ISO ms Z>}` + `\n` (that key order; `call: null` is written, not omitted). Append errors are ignored.
- A parked wait whose `callId` matches `target_call` (null-tolerant) → resolve it, respond `{"delivered": true}`. Otherwise, when `open_call` is not null, stash `{answer, callId: target_call, expires: now + TTL}` (replacing any prior stash), and respond `{"delivered": false}`.
- UUID v4: 16 random bytes from `/dev/urandom` with version/variant bits set, formatted `8-4-4-4-12` lowercase — no crate.

### `GET|POST /api/answer-here` (port of `handleAnswerHere`)

- POST `{token, on}`: bad JSON → 400 `invalid json`; token mismatch → 401; `on` not boolean → `400` `{"error":"invalid on"}`; else set `answer_here` in the global config through the core crate's config module (read-modify-write, other keys preserved) and respond `{"answer_here": <on>}`.
- Any other method: `?token=` check → `{"answer_here": <current, default false>}`.

### `GET /api/inbox?session&token` (port of `inbox.ts`)

- Token (401) then session (400) — same messages.
- `presence.mark_channel_seen(session)` immediately.
- A stashed message → remove it; if unexpired return `{"message": "<text>"}` (an expired one is discarded and the request parks).
- Else resolve any existing park for the session as a timeout, park (`set_channel_parked(session, true)`), wait up to the budget. On resolution: `mark_channel_seen` again, `set_channel_parked(session, false)` only if this is still the current park, and respond `{"message": "<text>"}` or `{"message": null, "timeout": true}`.
- `has_channel(session)` = parked, or last seen within `COCKPIT_CHANNEL_TTL_MS` (default 5000). `/api/sessions` already reads it.

### `POST /api/send-message {session, token, text}`

- Bad JSON 400; token 401; session not a UUID string → 400 `invalid session`; `text` non-string → `""`; `text.trim()` empty → `400` `{"error":"empty text"}` (the untrimmed text is what gets delivered).
- A parked inbox → resolve it with the text, `{"delivered": true}`. Else stash `{text, expires: now + TTL}` → `{"delivered": false}`.

## Acceptance criteria

- [x] Every `server: broker` and `server: inbox` contract test passes against the Rust binary and still passes against TS. The `server: presence` group (waits that need a live permission-stream subscriber) is not this task's gate: no subscriber exists until the permission routes land, so here the gate can only answer `no_tab`.
- [x] An answer sent before the wait parks is delivered by the next wait hop for the same call (stash), and never delivered to a wait parked on a different call.
- [x] A wait naming a call that is no longer the open one returns `superseded` without parking; with `require_watcher=1` the gate answers `toggle_off` / `no_tab` only after the stash and superseded checks.
- [x] `/api/respond` appends exactly one `response` line with `call` set to the explicit or open call, even when no wait is parked.
- [x] Two concurrent sessions never receive each other's answers or messages; a second park for one session releases the first with the timeout sentinel.
- [x] A client that disconnects mid-park leaves no entry behind, and a later park for that session is not disturbed by the dropped one's guard (`cargo test`).
- [x] `has_channel` stays true in the gap between one inbox poll resolving and the next re-parking (TTL window).

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (broker|inbox)"`
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (broker|inbox)"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Answers lost, cross-delivered, or a wait hangs past its budget | Happy path works; stash/superseded/gate ordering or disconnect cleanup drifts | Every race TS handles (cold-start stash, superseded call, replaced park, disconnect) behaves identically |
| Test coverage | ×2 | Contract groups not run on Rust | Groups pass; no Rust tests for park replacement or drop guards | Groups pass on both; `cargo test` covers stash TTL, `call_matches`, replacement, guard generation check, presence TTL |
| Interface & readability | ×1 | Lock held across `.await`, or edits outside `broker.rs`/`inbox.rs` | Works but park bookkeeping duplicated between wait and inbox | One small park helper reused by wait and inbox; state lives in `BrokerState`/`InboxState` |
| Assumptions & docs | ×1 | Env budgets hard-coded | Env honoured; ordering rationale missing | The three pre-park checks carry a one-line why for their order; deviations commented |

## Out of scope

- Permission-stream subscribers and the permission relay — Deferred to a later task in this bucket; this task only reads `has_visible_subscriber`.
- The `cockpit wait` / `cockpit send` CLI side — ported with the CLI subcommands.
