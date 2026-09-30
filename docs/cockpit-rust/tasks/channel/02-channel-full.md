# CHANNEL-02: Full channel

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: channel/01, core/03, server/01
> **Status**: done
> **Models**: dev=opus/high

## Goal

`cockpit channel` does everything the Bun `cockpit-channel.ts` does: it resolves the Claude session id, finds or spawns the daemon, long-polls the inbox into channel notifications, and relays permission prompts both ways. The channel's idle RSS stays at or below 10 MB.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/channel.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/channel/mod.rs` (modify) — `run()`: resolve the session, ensure the daemon, register the permission relay, start the inbox loop, and exit on EOF/SIGTERM. Keep the transport decision line on line 1 unchanged.
- `packages/monitor/cockpit-rs/src/channel/daemon.rs` (new) — daemon coordinates, `ensure_server`, `should_supersede_daemon`, `version_from_root`, `compare_versions`, backoff and poll-floor math.
- `packages/monitor/cockpit-rs/src/channel/inbox.rs` (new) — the inbox long-poll loop and the serial notifier.
- `packages/monitor/cockpit-rs/src/channel/permission.rs` (new) — the permission relay: payload mapping, `pull_verdict`, supersede-abort, and cancel forwarding.
- `packages/monitor/cockpit-rs/src/channel/session.rs` (new) — the session-id resolution chain.
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add an HTTP client only if one is not already present (see "HTTP client" below).

## Implementation notes

The outbound and inbound MCP plumbing already exists in `src/channel/mod.rs` as `notify(method, params)` and `on_notification(handler(method, params))`. Build only on those two functions. Line 1 of that file records which transport (rmcp or hand-rolled) won; do not change it.

Reuse the core modules for the cockpit home and daemon record path (`$COCKPIT_HOME/daemon.json`), `COCKPIT_CLAUDE_SESSIONS_DIR` / `COCKPIT_CLAUDE_PROJECTS_DIR` resolution, and process liveness (`kill(pid, 0)`). Do not re-derive them.

### HTTP client

The channel talks plain HTTP/1.1 to `127.0.0.1:<port>` only. Prefer `hyper-util`'s legacy client or `hyper` directly, which axum already pulls in, over adding `reqwest`, since reqwest brings TLS and a larger footprint. Whatever you choose, justify it in `Cargo.toml` in one line. Every request must be cancellable, by dropping the future, when its abort token fires.

### Daemon coordinates (`daemon.rs`)

```rust
pub struct DaemonCoords { pub port: u16, pub token: String }
pub struct ProcessInfo { pub pid: i32, pub port: u16, pub root: Option<String> }

/// Fresh read every call. Missing/corrupt, or a non-number port or non-string token → None.
pub fn read_daemon_coords() -> Option<DaemonCoords>;
/// Needs numeric pid + port; `root` only when it is a string.
pub fn read_process_info(path: &Path) -> Option<ProcessInfo>;
/// Regex `[/\\]monitor[/\\](\d+\.\d+\.\d+)[/\\]` → capture 1.
pub fn version_from_root(root: &str) -> Option<String>;
/// Numeric per-part compare of the first 3 dot parts; a missing part counts as 0.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering;
pub fn should_supersede_daemon(daemon_root: Option<&str>, my_root: &str) -> bool;
/// Returns true when it spawned.
pub fn ensure_server(info_path: &Path, my_root: &str) -> bool;
/// min(1000 * 2^clamp(failures, 0, 5), 30_000) ms.
pub fn next_reconnect_delay_ms(failures: u32) -> u64;
/// POLL_FLOOR_MS = 1000, jitter 0..250.
/// remaining = floor - elapsed; <= 0 → 0; else remaining + floor(rand * 250).
pub fn poll_floor_delay_ms(elapsed_ms: u64, floor_ms: u64, rand: f64) -> u64;
```

`should_supersede_daemon` is the exact TS rule:

1. `daemon_root` is absent, or equals `my_root` → `false`.
2. Either root has no parseable version → `false`. Reuse rather than fight.
3. Otherwise → `true` only when `compare_versions(mine, theirs)` is `Greater`.

The rule is a total order, so two live channels on different versions converge on the newer daemon instead of respawning each other's daemon forever.
`my_root` is `<plugin root>/skills/cockpit/scripts`, where the plugin root is `COCKPIT_PLUGIN_ROOT`, or the `current_exe` walk-up fallback in contracts §1. It is the same string the Rust server writes into `daemon.json.root`.

`ensure_server` does nothing (returns `false`) when the info file names a live pid and `should_supersede_daemon` is `false`. Otherwise it spawns `std::env::current_exe()` with args `["server", "--no-open"]`:

- detached into its own session (`setsid` via `pre_exec`, or `process_group(0)` plus no controlling tty)
- stdin/stdout/stderr all `Stdio::null()`
- the full environment inherited, so `COCKPIT_PLUGIN_ROOT`, `COCKPIT_HOME` and `COCKPIT_SERVER_PORT` reach the server (the server reads `COCKPIT_SERVER_PORT` as its default port when `--port` is absent; the `channel: spawn` contract group sets it to a free port so the test never touches 5858)
- not waited on

It then returns `true`.

`ensure_cockpit_daemon()` calls `ensure_server`, then polls every 100 ms for up to 3 s. On each poll, "up" means the info pid is alive AND `read_daemon_coords()` is `Some`. After the deadline it checks once more, then returns `Option<DaemonCoords>`.

### Session-id resolution (`session.rs`)

`UUID_RE = ^[0-9a-f-]{36}$`. Resolve in this order, taking the first hit:

1. `CLAUDE_CODE_SESSION_ID`, trimmed, if it matches `UUID_RE`.
2. **Session file.** Walk ancestor pids starting at the parent pid: at most 8 hops, and stop at pid ≤ 1. Each pid's parent comes from `ps -o ppid= -p <pid>`; stop when the parent does not parse or equals the pid. For each pid, read `$COCKPIT_CLAUDE_SESSIONS_DIR/<pid>.json`, and accept it only when `pid == <that pid>` and `sessionId` is a string matching `UUID_RE`.
3. **Ancestor argv.** Walk the same chain and read `ps -o command= -p <pid>`. Tokenize with regex `(?:[^\s"']+|["'][^"']*["'])+` and strip one leading/trailing quote from each token. Accept `--session-id <uuid>` (the next token), or `--session-id=<uuid>` in one token. The value must match `UUID_RE`.
4. **find-session fallback.** Call the crate's shared `find_session::find_session(Provider::Claude, project)`, where project is `CLAUDE_PROJECT_DIR` or else cwd. Retry every 100 ms until 3 s have elapsed, then make one final call.

The shared module already exists; import it and do not create, copy, or extend it:

```rust
// src/find_session.rs (owned by the core bucket)
pub enum Provider { Claude, Codex, Opencode }
/// Claude: env CLAUDE_CODE_SESSION_ID (trimmed, UUID_RE) wins, else the stem of the
/// newest `*.jsonl` under `<claude projects dir>/<project with '/' and '.' → '-'>/`.
/// On None it has already printed the TS diagnostic to stderr.
pub fn find_session(provider: Provider, project: &Path) -> Option<String>;
```

When no session id resolves, print `cockpit-channel: could not resolve a Claude session id; channel will stay idle` to stderr. Keep serving MCP (handshake and `tools/list`), but register no relay and run no inbox loop.

### Startup order in `run()`

1. Resolve the session id.
2. `ensure_cockpit_daemon()`. On `None`, print `cockpit-channel: cockpit daemon unavailable; retrying in loop` and continue.
3. If there is a session: register the permission relay **before** the MCP transport starts reading, so an early `permission_request` is not dropped.
4. Start the MCP transport.
5. Install exit on stdin EOF/close, SIGTERM, and SIGINT. Exit the process with status 0 immediately; there is nothing to flush.
6. If there is a session, run the inbox loop until shutdown.

### Inbox loop (`inbox.rs`)

Mirror `pullInboxLoop` exactly:

- `coords` starts as `read_daemon_coords()`, and `failures` starts at 0.
- Loop until shutdown:
  - `coords` is `None` → `coords = ensure_cockpit_daemon()`. If it is still `None`: `delay = next_reconnect_delay_ms(failures++)`, print `cockpit-channel: cockpit daemon unavailable; retrying in {delay}ms`, sleep `delay` (abortable), continue.
  - `GET http://127.0.0.1:{port}/api/inbox?session={id}&token={token}` (cancellable).
  - Non-2xx is treated as an error. On 2xx, set `failures = 0`, then parse `{ message?, timeout? }`.
  - `message` is a non-empty string → hand it to the **serial notifier**. Never await delivery inline.
  - `timeout == true` → sleep `poll_floor_delay_ms(elapsed_since_request_start, 1000, rand)` (abortable).
  - On error: if shutdown fired, return. Otherwise `delay = next_reconnect_delay_ms(failures++)`, print `cockpit-channel: inbox poll failed ({err}); reconnecting in {delay}ms`, set `coords = ensure_cockpit_daemon()`, and sleep `delay` (abortable).

**Serial notifier.** Delivering a channel notification is coupled to the session's turn, and can block for the whole time the agent is working. The TS client keeps its notification await outside the loop. The daemon's `hasChannel` only sees a parked poll, so if the loop awaited delivery, the poll would stop re-parking and the UI send box would disable mid-turn.

Use an unbounded `tokio::sync::mpsc` channel drained by one spawned task. That task calls `notify("notifications/claude/channel", {"content": text, "meta": {"source": "cockpit"}})` for each message, in arrival order. It logs `cockpit-channel: notification failed ({err})` and carries on after a failure.

### Permission relay (`permission.rs`)

**Inbound `notifications/claude/channel/permission_request`.**

1. Abort the previous in-flight relay's token. Claude serializes tool prompts, so a new request proves the previous one resolved elsewhere.
2. Create a fresh token.
3. Enqueue `handle_request(params, token)` on a serialized relay queue: one spawned task drains an mpsc, so relays run strictly in order and never block the inbox loop.

`handle_request`:

1. `POST /api/permission-request` with JSON body `{ session, token, request_id, tool_name, description, input_preview }`. Each of the four param fields is taken as-is when it is a string, and coerced to `""` otherwise. The coords come from `read_daemon_coords()`, falling back to `ensure_cockpit_daemon()`. If neither yields coords, fail with `cockpit daemon unavailable`. Non-2xx → error `/api/permission-request failed: {status}`.
2. `pull_verdict`:
   - Budget 5 min, `max_failures = 6`, floor 1000 ms.
   - Loop:
     - If the token is aborted or the deadline has passed → **Abandoned**.
     - `coords` is `None` → `ensure`. If still `None`: when `failures >= 6` return **GaveUp**; otherwise sleep the backoff (abortable) and continue.
     - `GET /api/permission-pull?session={id}&token={token}`, cancellable by the token.
     - On 2xx, set `failures = 0`. Then, by response body:
       - `abandoned == true` → **Abandoned**.
       - `timeout == true` → sleep the floor (abortable), continue.
       - string `request_id` with `behavior` of `allow` or `deny` → **Verdict**.
       - any other shape → re-poll.
     - On error: if aborted → **Abandoned**. If `failures >= 6` → **GaveUp**. Otherwise print `cockpit-channel: permission-pull failed ({err}); retrying in {delay}ms`, set `coords = ensure`, and sleep the backoff (abortable).
3. Only on **Verdict**, `notify("notifications/claude/channel/permission", {"request_id": <verbatim>, "behavior": ...})`. Abandoned or GaveUp sends nothing.

Any relay error prints `cockpit-channel: permission relay failed ({err})`.

**Cancel forwarding.** The method names are undocumented, so the handler is defensive. For any inbound method in this list, enqueue `POST /api/permission-resolved` with `{ session, token, request_id }` on the same serialized queue. `request_id` is coerced to `""` when it is not a string. The list:

- `notifications/claude/channel/permission_cancel`
- `notifications/claude/channel/permission_resolved`
- `notifications/claude/channel/permission_cancelled`
- any other method that starts with `notifications/claude/channel/permission`, other than the request and verdict methods. For these, also print `cockpit-channel: observed undocumented permission notification "{method}" — forwarding as resolved`.

Any other unknown notification is ignored.

**Abortable sleep.** It returns immediately if the token is already aborted, and wakes early on abort (`tokio::select!` over sleep and `token.cancelled()`). A superseded pull must not wait out a 30 s backoff while the next request waits behind it.

### Cargo tests to port

Port these cases from `cockpit-channel.test.ts` that the black box cannot reach cheaply. Inject time, rand, liveness, spawn, and HTTP where needed.

- `version_from_root` on `/x/monitor/3.19.0/skills/cockpit/scripts` returns `3.19.0`; on a repo path it returns `None`. `compare_versions("3.10.0", "3.9.0")` is `Greater`, which checks numeric rather than lexical ordering.
- `should_supersede_daemon`:
  - same root → reuse
  - older daemon → supersede
  - newer daemon → stand down
  - unversioned root → reuse
  - no live daemon → spawn
  - two channels on different versions converge
- `next_reconnect_delay_ms` gives 1000, 2000, 4000, …, capped at 30000.
- `poll_floor_delay_ms`: floor already elapsed → 0; a fast poll is padded to the floor plus jitter.
- The session chain: env wins, then the session file, then ancestor argv, then find-session. Also `session_id_from_command` with both `--session-id x` and `--session-id=x`.
- The inbox loop stays bounded when the daemon answers `{timeout:true}` instantly, and re-parks immediately after a real message.
- The serial notifier returns without awaiting, delivers in order when sends resolve out of order, and survives a failing send.
- Payload mapping coerces missing or non-string fields to `""`, and the verdict echoes `request_id` verbatim.
- `pull_verdict` → Abandoned on `{abandoned:true}`, on the budget elapsing, when pre-aborted, and when aborted mid-flight. It returns Verdict on the happy path.
- A new request aborts the prior pull, and the abandoned pull sends no verdict.

### RSS measurement against a stub daemon

Measure against a Bun stub that parks `/api/inbox` forever, so the number isolates the channel from any real server's behavior. The stub's `root` carries no version, so `ensure_server` reuses the stub instead of spawning.

```bash
H=$(mktemp -d); S=$H/stub.ts
cat > "$S" <<'EOF'
const s = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/api/inbox" || p === "/api/permission-pull") return new Promise(() => {});
    return Response.json({ ok: true });
  } });
await Bun.write(`${process.env.COCKPIT_HOME}/daemon.json`,
  JSON.stringify({ pid: process.pid, port: s.port, token: "t", root: "/stub/scripts" }));
EOF
COCKPIT_HOME=$H bun "$S" & STUB=$!; sleep 1
BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit COCKPIT_HOME=$H \
CLAUDE_CODE_SESSION_ID=00000000-0000-0000-0000-000000000000 bun -e '
const p = Bun.spawn([process.env.BIN, "channel"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
await Bun.sleep(4000);
const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(p.pid)]);
console.log((await new Response(ps.stdout).text()).trim());
p.kill(); await p.exited;'
kill "$STUB"
```

Hold stdin open with `Bun.spawn` and read the real channel pid from the subprocess. Never use `$!` of a backgrounded pipeline: in bash that is a subshell's pid, so `ps` would measure the shell and `kill` would leave the channel running. `$STUB` is safe because it is a single command, not a pipeline.

The printed number is KB, and must be ≤ 10240.

## Acceptance criteria

- [x] The `channel: inbox`, `channel: permission`, `channel: lifecycle` and `channel: spawn` contract groups pass against the Rust binary, and still pass against TS. `channel: spawn` runs the real Rust server that the channel spawns on the free port in `COCKPIT_SERVER_PORT`.
- [x] `should_supersede_daemon` implements the exact TS rule, and cargo tests cover all six supersede cases listed above.
- [x] `ensure_server` spawns `<current_exe> server --no-open` detached with null stdio and `COCKPIT_PLUGIN_ROOT` passed through, and only when the rule says so.
- [x] The session-id chain resolves in the order env → session file → ancestor argv → find-session (3 s retry), covered by cargo tests.
- [x] The inbox loop never awaits notification delivery inline, applies the 1000 ms floor plus jitter only to `{timeout:true}` hops, and backs off `min(1000·2^n, 30000)` ms on failure. It re-reads `daemon.json` or re-ensures the daemon after every failure.
- [x] The permission relay forwards requests, pulls verdicts within a 5 min budget, aborts a superseded pull, sends a verdict notification only for a real verdict, and forwards cancel-shaped notifications to `/api/permission-resolved`.
- [x] `cockpit channel` RSS is ≤ 10240 KB (macOS arm64, `ps -o rss=`) while idle with one inbox long-poll parked against the stub daemon above.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/channel.contract.test.ts -t "channel: "`
- [x] `bun test packages/monitor/skills/cockpit/contract/channel.contract.test.ts -t "channel: "` (TS still green)
- [x] Run the RSS snippet under "RSS measurement against a stub daemon" and confirm the printed value is ≤ 10240.
- [x] `head -1 packages/monitor/cockpit-rs/src/channel/mod.rs | grep -E '^// MCP transport: '` (the transport decision line is intact)

## Eval rubric

> Scale 0–5 per `../_context/rubric.md`. Pass when the weighted average is > 4.0; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Messages or verdicts are not delivered, the inbox poll stops re-parking during delivery, or channels fight over the daemon | Happy paths work, but a sentinel, the abort-on-supersede, the backoff cap, or the session-chain order drifts from TS | Every loop, sentinel, backoff, supersede rule and error string matches TS; EOF/SIGTERM exits 0; RSS ≤ 10 MB |
| Test coverage | ×2 | Only the contract groups run | Pure helpers tested; loops and relay untested | Cargo tests cover every case listed under "Cargo tests to port", including abort, budget, out-of-order delivery and convergence |
| Interface & readability | ×1 | Transport types leak into the loops; `unwrap` on HTTP or JSON | Modules exist but the loop logic is tangled with I/O | Pure helpers take injected time, rand and liveness; the loops depend only on `notify` / `on_notification` and a small HTTP seam |
| Assumptions & docs | ×1 | New HTTP dependency unjustified; magic numbers unexplained | Constants present without a why | Each constant (1000 ms floor, 250 jitter, 30 s cap, 6 failures, 5 min budget, 3 s waits) carries a one-line why; the HTTP client choice is justified in `Cargo.toml` |

## Out of scope

- `src/find_session.rs` itself. Deferred: the core bucket owns it; this task only calls it.
- Anything on the daemon side of `/api/inbox` or `/api/permission-*`. Deferred: the server port owns it, and this task only needs its HTTP contract.
- Rewiring `plugin.json` to launch the Rust channel. Deferred to the shipping bucket.
