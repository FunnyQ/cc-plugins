# SERVER-02: The atlas serve HTTP shell and lifecycle

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: server/01, engine/08, contract/02
> **Blocks**: ship/01
> **Status**: done
> **Models**: dev=opus/high

## Goal

`cockpit atlas serve [--port N] [--no-open]` replaces `bun atlas-server.ts`: same routes, headers, caching, singleton lifecycle, and messages, with `/api/live` answering while a stats build runs.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/server.rs` (modify — replace the stub) — `pub fn run(args: &[String]) -> ExitCode`: argv, startup decision, bind, router, handlers, `atlas.json`, browser open.
- `packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts` (modify, optional) — one mixed-fleet reuse test, only if cheap (see below).

No other file. `Cargo.toml`, `main.rs`, `atlas/mod.rs`, `server/static_files.rs`, and every engine module are owned elsewhere; call them through the signatures below.

## Implementation notes

The TS sources are authoritative while they exist: `packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts` and `atlas-lifecycle.ts`. Port what they do; contracts.md §2–§3 is the summary.

### Signatures you call (already exist)

```rust
// atlas/model.rs
pub struct Ctx { pub now_ms: i64, pub plugin_root: PathBuf }
impl Ctx { pub fn from_env() -> anyhow::Result<Ctx>; }
// atlas/stats.rs
pub async fn build(ctx: &Ctx) -> anyhow::Result<serde_json::Value>;
pub fn fingerprint(ctx: &Ctx) -> String;                 // "<count>:<newestMtime>", blocking stat walk
pub fn models_in(stats: &serde_json::Value) -> Vec<String>;
// atlas/pricing.rs
pub async fn refresh_pricing_override(ctx: &Ctx, models: Vec<String>) -> anyhow::Result<PricingRefreshResult>; // Serialize
// atlas/live.rs
pub fn live_sessions(ctx: &Ctx) -> Vec<LiveSession>;    // Serialize
pub fn cockpit_daemon_port() -> Option<serde_json::Number>; // any JSON number TS accepts, echoed unchanged
// crate (cockpit)
crate::paths::cockpit_home() -> PathBuf;
crate::paths::plugin_root() -> Result<PathBuf, String>;
crate::process_alive::{is_alive(i32) -> bool, terminate(i32), detach(&mut Command), reap_in_background(Child)};
crate::server::static_files::serve_dir(root: &Path, uri: &Uri, headers: &HeaderMap) -> Response; // async
crate::server::json_response(...)                        // read its signature in server/mod.rs
```

`Ctx::now_ms` is fixed at construction; build a fresh `Ctx` per request (cheap) so `TOKEN_ATLAS_NOW_MS` unset means the real clock at request time.

### Runtime

- Synchronous `run` parses argv and runs the startup decision **before** building the runtime (it sleeps and signals; no async needed). Then `tokio::runtime::Builder::new_current_thread().enable_all().build()` and `block_on(serve)`.
- Bind `127.0.0.1:<port>` with `tokio::net::TcpListener::bind`. `AddrInUse` → stderr `atlas: port <n> is in use by another process — stop it or pass --port <n>.`, exit 1. Any other bind error → stderr the error, exit 1.
- After bind: write `atlas.json`, print `Claude Stats Dashboard → http://localhost:<port>`, open the browser, `axum::serve`.

### argv

- `--port <n>`: parse as integer; valid only when `0 < n < 65536`; otherwise (missing value, garbage, out of range) default `5938`. Mirror `parsePort()` — the first `--port` occurrence wins.
- `--no-open` anywhere suppresses both browser opens.
- Unknown args are ignored, as TS ignores them.

### Startup decision (port `decideStartup`)

```rust
enum Startup { Reuse(AtlasInfo), Supersede(AtlasInfo), Start }
fn decide_startup(info: Option<AtlasInfo>, my_root: &str, is_alive: impl Fn(i32) -> bool) -> Startup;
struct AtlasInfo { pid: serde_json::Number, port: serde_json::Number, root: String }
```

- Read `cockpit_home()/atlas.json`. Missing, unparseable, `pid` or `port` not a JSON number (any number, integer or not — `readAtlasInfo` checks only `typeof === "number"`), or `root` not a string → `None`. Parse via `serde_json::Value`, not a typed struct, so `5999.5` is kept rather than failing deserialization.
- Liveness: a `pid` that is not a positive integer fitting `i32` counts as dead (Bun's `process.kill` throws on it, and `isAlive` returns false for that error). `port` is echoed unchanged in the reuse message.
- Lifecycle cargo tests cover a fractional `port` with a live pid (→ Reuse, port echoed as written), a string `port` (→ Start), and a fractional `pid` (→ Start).
- `None` or pid dead → `Start`. Alive + `root == my_root` → `Reuse`. Alive + different root → `Supersede`.
- `my_root` = `plugin_root().join("skills/usage-dashboard/scripts")` as a string — the exact string the TS server writes, so a TS server and a Rust server from the same checkout reuse each other.
- Reuse: stdout `Claude Stats Dashboard already running → http://localhost:<port> (pid <pid>)`, open browser, exit 0.
- Supersede: stdout `superseding stale atlas server (pid <pid>, root <root>) — this install is <my_root>`; SIGTERM; poll `is_alive` every 50 ms up to 1500 ms; if still alive SIGKILL and poll up to 1000 ms; sleep 100 ms; then start. Errors from `kill` are ignored (already gone). Use `libc::kill` directly if `process_alive::terminate` does not let you pick the signal and wait on your own schedule.

### `atlas.json`

Written after a successful bind: `serde_json::to_string_pretty` of `{pid, port, root}` (key order pid, port, root; 2-space indent) + `"\n"`. `mkdir -p` the cockpit home first. Never deleted on exit.

### Routes (by pathname; method matters only for pricing refresh)

Build one `axum::Router` with a fallback handler that dispatches on `uri.path()`, so any method reaches `/api/stats` and `/api/live` as in TS.

- `/api/stats`:
  1. `fp = spawn_blocking(fingerprint)`; `etag = format!("W/\"{BOOT_ID}-{fp}\"")`. `BOOT_ID` is random per process (e.g. `uuid::Uuid::new_v4().simple()` — uuid is already a dependency; any per-process random string without `-` and `"` works; the contract regex is `^W\/"[^-"]+-\d+:\d+(\.\d+)?"$`).
  2. `If-None-Match == etag` → 304, empty body, headers `Cache-Control: no-cache`, `ETag`, `Vary: Accept-Encoding`.
  3. Else get the payload for `fp` from the in-flight cache (below), serialize, gzip level 6 on `spawn_blocking` when `Accept-Encoding` contains `gzip` (`Content-Encoding: gzip`), headers `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`, `ETag`, `Vary: Accept-Encoding` on both gzip and plain 200s.
- `/api/live`: `spawn_blocking(live_sessions)`, `cockpit_daemon_port()`; body `{"sessions": [...], "cockpitUp": port.is_some(), "cockpitPort": port}`; `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`; never gzip. It must not await the stats cache.
- `POST /api/pricing/refresh`: body parsed as JSON; `models` kept only when it is an array, non-strings dropped; missing/invalid body → derive `stats::models_in(&stats::build(&ctx).await?)`. Then `refresh_pricing_override`. 200 JSON with `Cache-Control: no-store`. A non-POST to this path falls through to static (404), as TS.
- Anything else: `serve_dir(plugin_root/skills/usage-dashboard/dashboard/dist, uri, headers)`; `/` maps to `/index.html` (do the mapping here if `serve_dir` does not).
- Any handler error → 500 `{"error": "<message>"}` with `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`. Use `err.to_string()` (the TS uses `err.message`) — the contract asserts `Override unreadable: …` passes through.

### Single in-flight stats build

TS keeps `{fingerprint, payload: Promise}` so two concurrent requests share one build, and clears it on rejection. Recommended Rust shape (justify the choice in one comment):

```rust
type Build = futures::future::Shared<BoxFuture<'static, Result<Arc<Value>, Arc<String>>>>;
static STATS: tokio::sync::Mutex<Option<(String, Build)>>;
```

Lock, reuse the entry when its fingerprint equals `fp`, else replace it with a new shared future of `stats::build`; release the lock before awaiting. On `Err`, lock again and clear the entry only if it still holds this fingerprint. If `futures` is not a dependency (check `Cargo.toml`; do not edit it), use `tokio::sync::watch` or a `Mutex<Option<(String, Arc<OnceCell<…>>)>>` with `tokio::sync::OnceCell` — `get_or_try_init` gives shared-in-flight with retry-on-error for free. Stats build itself already puts its sync work on `spawn_blocking`; do not wrap it again.

Why this matters: the cockpit port stalled when blocking work ran on the current_thread runtime; the contract's Rust-only test fires `/api/stats` and requires `/api/live` to answer in under 1 s while the build is still pending.

### Browser open

Unless `--no-open`: `open <url>` on macOS, `xdg-open <url>` elsewhere, stdio null, `process_alive::detach`, then `reap_in_background(child)`. Spawn errors ignored (URL already printed). No Windows branch (Windows is out of scope).

### Tests

- Cargo units in `server.rs`: port the 6 `atlas-lifecycle.test.ts` cases (null info, non-number pid, non-string root, dead pid, alive same root → reuse, alive different root → supersede) against `decide_startup` with an injected `is_alive`; `--port` parsing (valid, `0`, `65536`, garbage, missing value, default).
- Black box: `http.contract.test.ts` and `lifecycle.contract.test.ts` green against Rust, including the Rust-only "live answers during a stats build" test, and still green against TS.
- Optional mixed-fleet test in `lifecycle.contract.test.ts`, only if it fits in ~30 lines using the existing `startAtlas` helper: start the TS server (`bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts --port <p> --no-open` under the fixture env), then run the Rust `atlas serve` → it prints `already running` and exits 0. Guard it with `test.skipIf(!isRust())` and a one-line comment that it is optional. Skip it entirely if it needs new helpers.

## Acceptance criteria

- [x] `cockpit atlas serve` serves every route in contracts.md §2 with the exact status codes, bodies, and headers listed there, including 304 on `/api/stats` and static ETags.
- [x] Two concurrent `/api/stats` requests for one fingerprint run one `stats::build` (cargo test or a log-free counter test); a failed build is not cached and the next request retries.
- [x] `/api/live` answers in under 1 s while a `/api/stats` build is pending (the Rust-only contract test passes and does not pass vacuously).
- [x] Reuse, supersede, start, port-in-use (stderr text + exit 1), and corrupt `atlas.json` behave as contracts.md §3, and `atlas.json` is byte-identical in shape to the TS writer's (`{pid, port, root}`, 2-space, trailing newline, root ending `/skills/usage-dashboard/scripts`).
- [x] The 6 startup-decision cases and `--port` parsing have cargo tests.
- [x] `http.contract.test.ts` and `lifecycle.contract.test.ts` pass against Rust and against TS.
- [x] Cockpit's own contract suite still passes.
- [x] (human) With the TS dashboard stopped, build a root with the real-data recipe in `../_context/shared.md`, run `packages/monitor/cockpit-rs/target/release/cockpit atlas serve --port <free port>` under its env, and confirm every panel renders as under the TS server, the live panel updates every 3 s, and clicking a live row opens the running cockpit (the copied `daemon.json` lets `cockpitPort` resolve).

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/http.contract.test.ts packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts` passes with no skipped Rust-only test.
- [x] `bun test packages/monitor/skills/usage-dashboard/contract/http.contract.test.ts packages/monitor/skills/usage-dashboard/contract/lifecycle.contract.test.ts` (against TS) passes.
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/` passes.
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml` passes.
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check` and `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings` are clean.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Contract tests fail against Rust, or `/api/live` stalls behind a stats build, or supersede kills the wrong process | Contract green, but a header, message string, `atlas.json` byte, or the failed-build-not-cached rule drifts from TS | Every §2–§3 behavior matches TS exactly; one build per fingerprint; live never blocked; failed builds retried |
| Test coverage | ×2 | No cargo tests; contract suite not run against Rust | Contract suite green but startup-decision or `--port` edge cases untested | All 6 lifecycle cases, `--port` edges, in-flight sharing, and the full HTTP/lifecycle contract including the Rust-only concurrency test pass |
| Interface & readability | ×1 | Handlers duplicate header/JSON building; `unwrap` on request or file data | Works but routing or cache state is hard to follow | One dispatch point, small handlers, reused `json_response`/`serve_dir`, no one-caller abstraction, clippy clean |
| Assumptions & docs | ×1 | In-flight cache choice and runtime split unexplained | Some choices commented | One-line why-comments on the in-flight cache choice, running the startup decision before the runtime, and any deliberate TS deviation (live not blocked) |

## Out of scope

- Stats payload values — Deferred. Reason: the stats assembly module and the golden suite own them.
- Live session list contents — Deferred. Reason: the live-sessions module owns them; this task only wraps them in the `/api/live` envelope.
- Updating `SKILL.md`, install scripts, or the statusline wiring to call `atlas serve` — Deferred. Reason: the wiring step does all callers at once after every subcommand exists.
- Windows browser opening — Deferred. Reason: Windows is a non-goal of the port.
