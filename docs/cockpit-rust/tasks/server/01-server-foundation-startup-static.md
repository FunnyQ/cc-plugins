# SERVER-01: Server foundation, startup, static

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/02, core/03, contract/02
> **Blocks**: server/02, server/04, server/06, server/07, server/08
> **Status**: todo

## Goal

`cockpit server` starts, applies the reuse/supersede startup rule, binds `127.0.0.1`, writes `daemon.json`, answers `/api/token`, and serves the SPA from disk byte-compatibly with the Bun daemon. It also lays down the router, `AppState`, the shared presence registry, and one stub module per route group, so every later route group fills in only its own file and state struct.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add every dependency the whole server needs, once (list below), so no later server work touches this file.
- `packages/monitor/cockpit-rs/Cargo.lock` (modify) — regenerated.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — dispatch `cockpit server [--port N] [--no-open]` to `server::run`.
- `packages/monitor/cockpit-rs/src/server/mod.rs` (new) — `AppState`, startup guard, bind, `daemon.json` write, browser open, `/api/token`, router merging every route-group module.
- `packages/monitor/cockpit-rs/src/server/static_files.rs` (new) — port of `shared/scripts/static-server.ts` + `path-inside.ts`.
- `packages/monitor/cockpit-rs/src/server/presence.rs` (new) — shared in-memory presence registry (channel liveness + permission-stream subscribers).
- `packages/monitor/cockpit-rs/src/server/sources.rs` (new) — provider path/DB helpers every route group reuses (`codex-db.ts`, `shared/scripts/opencode.ts`, transcript path resolution, bounded tail/line reading).
- `packages/monitor/cockpit-rs/src/server/{views,log_stream,transcript,broker,inbox,permission,codex,opencode}.rs` (new, stubs) — each exports `pub fn router() -> Router<AppState>` returning `Router::new()` and `#[derive(Default)] pub struct <Group>State {}`.

## Implementation notes

### Dependencies added here (and only here)

Check each crate's current API with context7 before use. Add a one-line justification comment beside every crate not already listed in `_context/shared.md`.

- `axum` (with `tokio` `net`, `time`, `sync`, `fs`, `process`, `signal`, `macros`, `rt`, `io-util` features) — HTTP + SSE.
- `rusqlite` feature `bundled` — already present (added with the shared find-session module); do not re-add or change its version.
- `notify` — file watching for SSE tails and the permission transcript guard.
- `tokio-tungstenite` — Codex app-server WebSocket over a Unix socket.
- `serde_json` with feature **`preserve_order`** — payloads echo YAML/JSON maps whose key order is observable. Without it `serde_json::Map` sorts keys.
- A maintained serde YAML crate (e.g. `serde_norway`; `serde_yaml` is archived) — the views group parses DESIGN.md frontmatter (`Bun.YAML.parse` in TS). Deserialize into `serde_json::Value` so order is kept.
- `regex` — plain patterns (colour/lightness matching, `ps` line parsing). No `fancy-regex`: the one lookahead regex in TS (`extractRules`) is rewritten as a hand scan by the views group.
- `flate2` — gzip level 6 for static files.
- An HTTP client for the OpenCode bridge (`reqwest` with `default-features = false`, feature `json`; no TLS — every target is `http://127.0.0.1`).
- A date crate (`jiff` or `time`) — `Date.parse` of RFC 3339 heartbeats and `toISOString()` output (`2026-09-30T12:00:00.000Z`, always millisecond precision, `Z`).

### State and router layout (the contract every later route group relies on)

```rust
#[derive(Clone)]
pub struct AppState {
    pub presence:   Arc<presence::Presence>,
    pub views:      Arc<views::ViewsState>,
    pub log_stream: Arc<log_stream::LogStreamState>,
    pub transcript: Arc<transcript::TranscriptState>,
    pub broker:     Arc<broker::BrokerState>,
    pub inbox:      Arc<inbox::InboxState>,
    pub permission: Arc<permission::PermissionState>,
    pub codex:      Arc<codex::CodexState>,
    pub opencode:   Arc<opencode::OpencodeState>,
    pub token:      Arc<str>,
    pub plugin_root: Arc<Path>,
}
```

- `AppState` is built once in `run` with `Default::default()` for every group state (so each `<Group>State` must stay `Default`; a group that needs env-derived config reads it lazily or in its own `Default` impl).
- Router: `Router::new().route("/api/token", any(token)).merge(views::router()).merge(log_stream::router()).merge(transcript::router()).merge(broker::router()).merge(inbox::router()).merge(permission::router()).merge(codex::router()).merge(opencode::router()).fallback(static_files::serve).with_state(state)`.
- The stub modules ship `Router::new()` and an empty `#[derive(Default)] pub struct <Group>State {}` so this compiles today. Each later route group replaces only its own module body and adds fields to only its own state struct (using interior mutability, e.g. `std::sync::Mutex`); it never edits `mod.rs`, `AppState`, or `Cargo.toml`. A group that needs more files puts them under `src/server/<group>/` and declares them with `mod` items inside its own module file (e.g. `views.rs` declares `mod subagents;` → `src/server/views/subagents.rs`).
- Group state names: `ViewsState`, `LogStreamState`, `TranscriptState`, `BrokerState`, `InboxState`, `PermissionState`, `CodexState`, `OpencodeState`.

### Startup (port of `cockpit-server.ts` top level)

- Port: `--port N` (accepted only when `0 < N < 65536`), else `COCKPIT_SERVER_PORT` (same validity rule), else `5858`.
- Read `$COCKPIT_HOME/daemon.json` (valid only when `pid` and `port` are numbers). Decide with the daemon-lifecycle rule from the core crate (`start` / `reuse` / `supersede`) using `my_root = <plugin root>/skills/cockpit/scripts`.
  - `reuse` → print `cockpit daemon already running → http://localhost:<port> (pid <pid>)`, open the browser (unless `--no-open`), exit 0.
  - `supersede` → print `superseding stale cockpit daemon (pid <pid>, root <root or "unknown">) — this install is <my_root>`, SIGTERM, poll every 50 ms up to 1500 ms, SIGKILL if still alive and poll up to 1000 ms, sleep 100 ms, then bind.
- Bind `127.0.0.1:<port>`. `EADDRINUSE` → stderr `cockpit: port <port> is in use by another process — stop it or pass --port <n>.`, exit 1. Never kill a process you did not supersede.
- Write `daemon.json` = `{"pid","port","token","root"}` in that key order, `JSON.stringify(_, null, 2) + "\n"`, `mkdir -p $COCKPIT_HOME` first. `token` = 16 random bytes as 32 lowercase hex chars (read `/dev/urandom`; no crate).
- Print `cockpit → http://localhost:<port>` then open the browser: `open <url>` on macOS, `xdg-open <url>` elsewhere, detached, errors ignored.
- Do not install any server-side request timeout shorter than 255 s: long-polls park for 240 s and SSE pings every 25 s. axum has no idle timeout by default — keep it that way.
- Runtime: `Builder::new_current_thread()` inside the synchronous `server::run`; `main` is never `#[tokio::main]`. Never hold a `std::sync::Mutex` guard across `.await`.
- Routing matches on path only, any method (TS ignores method except for `/api/answer-here`). Register each API path with `axum::routing::any`; the fallback serves static files.

### `/api/token`

`{"token": "<daemon.json token>"}` read fresh from `daemon.json`; missing → `503` `{"error":"daemon token unavailable"}`.

### Shared presence registry (`presence.rs`)

Defined here so the inbox, broker, permission, and views modules use it without editing each other's files:

```rust
pub struct Presence { /* Mutex<HashMap<String, Instant>> seen; Mutex<HashSet<String>> parked; Mutex<HashMap<String, Vec<UnboundedSender<String>>>> subscribers */ }
impl Presence {
    /// Inbox marks a poll; `parked` true while a long-poll is waiting.
    pub fn mark_channel_seen(&self, session: &str);
    pub fn set_channel_parked(&self, session: &str, parked: bool);
    /// parked || (seen within COCKPIT_CHANNEL_TTL_MS, default 5000 ms)
    pub fn has_channel(&self, session: &str) -> bool;
    /// Permission-stream subscribers; each sender is one open SSE connection.
    pub fn add_subscriber(&self, session: &str, tx: UnboundedSender<String>);
    pub fn broadcast(&self, session: &str, chunk: &str); // drops closed senders
    /// Probe: drop every closed sender (tx.is_closed()), true when any remain.
    pub fn has_visible_subscriber(&self, session: &str) -> bool;
}
```

Implement every method fully here (behavior as commented), with `cargo test` for the TTL and closed-sender pruning, and `impl Default`. Later route groups only call these methods; they never edit `presence.rs`. Because nothing calls them yet, put one `#![allow(dead_code)] // callers are the inbox, permission and views routes` at the top of `presence.rs`, and the same attribute with the same kind of why on `AppState` and each stub state struct; clippy must stay clean with `-D warnings`.

### Static files (port of `static-server.ts` + `path-inside.ts`)

- Root: `<plugin root>/skills/cockpit/dashboard/dist`.
- `/` → `/index.html`. Resolve `root + "." + path`; refuse (`404`, body `Not found`) when the result is not strictly inside root (`isPathInside`: relative path non-empty, not starting with `..`, not absolute), missing, or not a regular file. There is **no SPA index fallback**: every other unknown path is 404.
- MIME: `.html` `text/html; charset=utf-8`, `.js`/`.mjs` `application/javascript; charset=utf-8`, `.css` `text/css; charset=utf-8`, `.json` `application/json; charset=utf-8`, `.svg` `image/svg+xml`, `.png` `image/png`, `.jpg` `image/jpeg`, `.woff2` `font/woff2`, `.ico` `image/x-icon`, else `application/octet-stream`. Extension compared lowercase.
- Gzip only when the extension is in `{.html,.js,.mjs,.css,.json,.svg}` and `Accept-Encoding` contains `gzip`; then add `Content-Encoding: gzip`, `Vary: Accept-Encoding`, level 6.
- Headers always: `Content-Type`, `Cache-Control: no-cache`, `ETag: W/"<mtime>-<size>[-gz]"` where `<size>` is base-36 and `<mtime>` is the mtime in whole milliseconds, base-36. TS formats a fractional `mtimeMs` in base 36; clients only compare ETags for equality, so integer ms is a deliberate deviation — leave a one-line comment saying so. `If-None-Match` equal to the ETag → `304` with the same headers and no body.

### Provider helpers (`sources.rs`, reused by later route groups)

- `resolve_claude_transcript_path(id: &str) -> Option<PathBuf>`: first `**/<id>.jsonl` under `COCKPIT_CLAUDE_PROJECTS_DIR`; a std recursive walk is enough (Bun's glob order is unspecified; first hit wins).
- `resolve_codex_rollout_path(id: &str) -> Option<PathBuf>`: `select rollout_path from threads where id = ? and archived = 0 and rollout_path != '' limit 1`, relative paths resolved against the Codex dir.
- `codex_dir()`, `codex_state_db()`, `codex_sessions_dir()`, `opencode_db()`, `opencode_timestamp_ms(v: i64) -> i64` (`<1e12` → ×1000; non-positive → 0) with the env overrides in `_context/contracts.md`. Open SQLite read-only; any SQLite error → empty result.
- `read_tail_bytes(path, 64 * 1024) -> Vec<u8>` and a chunked JSONL line reader (split on `0x0a` before UTF-8 decoding, strip trailing `\r`).

## Acceptance criteria

- [ ] `cockpit server --port <p> --no-open` binds, writes `daemon.json` with `root = <plugin root>/skills/cockpit/scripts`, and a second identical launch prints the reuse line and exits 0.
- [ ] With no `--port`, `COCKPIT_SERVER_PORT=<p>` makes the server bind `<p>`.
- [ ] A launch whose root differs from a live recorded daemon supersedes it (old pid gone, new `daemon.json`).
- [ ] Every `server: startup`, `server: meta`, and `server: static` contract test passes against the Rust binary and still passes against TS.
- [ ] Static serving returns 404 for traversal and unknown paths, 304 on a matching `If-None-Match`, and gzip only for the compressible set.
- [ ] `AppState` carries the presence registry and all eight group state fields named above; each stub module compiles to an empty router, so the later groups need no edit to `mod.rs` or `Cargo.toml`.
- [ ] `Cargo.toml` carries every server dependency listed above with justification comments.
- [ ] `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` are clean.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (startup|meta|static)"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: (startup|meta|static)"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Startup double-binds or kills a foreign process; `daemon.json` shape differs | Happy path works; port precedence, supersede timing, or ETag/304 drift | Startup rule, port precedence, `daemon.json`, `/api/token` and static serving match TS on every fixture |
| Test coverage | ×2 | Contract groups not run against Rust | Groups pass; no `cargo test` for pure helpers | Groups pass on both; `cargo test` covers port precedence, ETag, path confinement, presence TTL |
| Interface & readability | ×1 | Later route groups must edit `mod.rs`/`AppState`/`Cargo.toml` | Router works but group state is not isolated per module | `AppState` and stubs let each group touch only its own file; no lock held across `.await` |
| Assumptions & docs | ×1 | Silent deviations | Deviations exist without comments | ETag integer-ms deviation and every added crate carry a one-line why |

## Out of scope

- `/api/projects`, `/api/sessions`, `/api/project-info`, `/api/design-system`, the subagent and session-title modules — Deferred to a later task in this bucket that fills the views module.
- The log-stream, transcript, broker, inbox, permission, Codex and OpenCode route bodies — Deferred to later tasks in this bucket; this task ships their empty stub modules only.
- `/api/answer-here` — Deferred. Reason: it lives with the broker in TS (`broker.ts`) and is covered by the broker contract group.
- Embedding the SPA in the binary — rejected in the plan; always serve from disk.
