# SERVER-07: OpenCode send

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01
> **Status**: done

## Goal

The dashboard can check and message a running opencode 1.x TUI through the Rust daemon: `/api/opencode-control/status` and `/api/send-opencode-message` discover the TUI's HTTP server, verify the session, and deliver text via `/tui/append-prompt` then `/tui/submit-prompt`, with the same JSON and status codes as `opencode-send.ts`.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/opencode.rs` (modify — currently an empty stub router and an empty `OpencodeState`) — both routes, server discovery, session check, prompt delivery.

Only this file changes. Use the HTTP client crate already in `Cargo.toml` (added with the server foundation); do not add another. Do not edit `server/mod.rs`, `AppState`, `presence.rs`, `sources.rs`, or `Cargo.toml` — they belong to the server foundation; every crate this needs is already in `Cargo.toml`.

## Implementation notes

### Session id and auth

- Session must match `^ses_[A-Za-z0-9_-]{8,160}$`.
- Daemon token from `daemon.json`, fresh per request. Mismatch → `401` `{"error":"unauthorized"}` (checked first), bad session → `400` `{"error":"invalid session"}`.
- Outgoing requests carry `authorization: Basic base64(<user>:<password>)` only when `OPENCODE_SERVER_PASSWORD` is set; user = `OPENCODE_SERVER_USERNAME` or `opencode`. Base64 by hand or via a crate already present — do not add one just for this.

### Discovery (port of `discoverOpenCodeServer`)

1. Candidates: `OPENCODE_TUI_SERVER_URL` else `OPENCODE_SERVER_URL` (trailing `/`s stripped), then every URL from a `ps -axo command` scan.
2. `ps` scan: trim each line; keep lines matching `(^|[/\s])opencode(\s|$)`; drop lines matching `\bopencode\s+(serve|web|attach)\b`; port from `--port(?:=|\s+)(\d{1,5})` or `-p\s+(\d{1,5})` (lines without a port dropped); host from `--hostname(?:=|\s+)(\S+)` or `127.0.0.1`; URL `http://<host>:<port>`. `ps` failure → no candidates.
3. First candidate whose `GET <url>/global/health` answers 2xx with JSON `{"healthy": true}` within **1 s** wins. None → not ready.

### Session check (port of `checkOpenCodeSession`)

- No server → report `{ok:false, ready:false, sessionFound:false, delivered:false, warnings:[], errors:["OpenCode TUI server unavailable. Start the visible TUI with opencode --port <n>, or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n> before starting cockpit."]}` (exact text).
- `GET <server>/session/<urlencoded id>` with a **2 s** timeout: `404` → error `OpenCode session not found`; other non-2xx → error `OpenCode session check failed: <status>`; network/timeout error → its message. 2xx → ready, `sessionDirectory` = string `directory` of the JSON body or `""` (unparseable body → `""`).

### Delivery (port of `sendOpenCodePrompt`)

- Not ready → return the check report.
- `POST <server>/tui/append-prompt[?directory=<sessionDirectory>]`, header `content-type: application/json`, body `{"text": "<text>"}`, **5 s** timeout. Success requires 2xx **and** a JSON body equal to `true`; otherwise error = `body.data.message || body.message || body.error || "OpenCode TUI append failed: <status>"`.
- Then `POST <server>/tui/submit-prompt[?directory=…]`, no body, 5 s timeout, same success rule, fallback message `OpenCode TUI submit failed: <status>`.
- The `directory` query param is added only when `sessionDirectory` is non-empty.
- Success → `delivered: true`, `delivery: "tui"`.

### Routes

- `GET /api/opencode-control/status?session&token` → `{"ready": ok && ready, "serverUrl", "warnings", "errors"}` (`serverUrl` omitted when unknown).
- `POST /api/send-opencode-message {session, token, text}`: bad JSON → 400 `invalid json`; token 401; session 400; trimmed text empty → `400` `{"error":"empty text"}`. Not delivered → `502` `{"error": errors.join("; ") or "OpenCode send failed", "warnings"}`. Delivered → `{"delivered": true, "delivery": "tui", "serverUrl", "warnings"}`.

## Acceptance criteria

- [x] Every `server: opencode` contract test passes against the Rust binary and still passes against TS.
- [x] With exactly one unreachable candidate (`OPENCODE_TUI_SERVER_URL` pointing at a closed port, no other `OPENCODE_*` env, a `ps` stub that lists no opencode), status answers `ready: false` with the exact unavailable message and send answers 502 within ~2 s. A separate case with two unreachable candidates and a third reachable stub probes them in TS order and delivers through the third; discovery order and per-candidate timeouts stay as in TS.
- [x] Against a fake OpenCode HTTP server named by `OPENCODE_TUI_SERVER_URL` (a `cargo test` using an in-process axum server), a send performs health → session → append (with `directory`) → submit in that order and answers `delivered: true`; a non-`true` append body surfaces its `data.message` as the error.
- [x] Basic auth is sent only when `OPENCODE_SERVER_PASSWORD` is set.
- [x] The `ps` line parser accepts `opencode --port 4096` and `/usr/local/bin/opencode -p 4096 --hostname 0.0.0.0`, and rejects `opencode serve --port 4096` (`cargo test`).
- [x] (human) Send a message from the dashboard to a running opencode 1.x TUI and see it arrive.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: opencode"`
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: opencode"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong server targeted (e.g. an `opencode serve`), or delivery reported without both steps succeeding | Main path works; timeouts, `directory` param, or error-message fallbacks drift | Discovery, health, session check, two-step delivery, auth, and every message match TS |
| Test coverage | ×2 | Contract group not run on Rust | Group passes; no fake-server test | Group passes on both; `cargo test` covers the `ps` parser and a fake bridge including failure bodies |
| Interface & readability | ×1 | Discovery, check, and delivery interleaved | Separated but duplicated request setup | Three small functions mirroring TS; one request helper applies auth and timeouts |
| Assumptions & docs | ×1 | Timeouts are magic numbers | Named, unexplained | Timeouts named with their TS source; the `true`-body success rule commented |

## Out of scope

- OpenCode 2.x — the bridge is 1.x-only by design.
- Transcript streaming for OpenCode — handled by the transcript route group.
