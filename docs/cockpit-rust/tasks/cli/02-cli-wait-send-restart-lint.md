# CLI-02: Wait, send, restart

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: cli/01, server/05
> **Status**: done

## Goal

`cockpit wait`, `cockpit send`, and `cockpit restart` run from the Rust binary and talk to the daemon exactly as `cockpit.ts` does, so the contract groups `cli: wait`, `cli: send`, and `cli: restart` pass against Rust.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/cli.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/cli/broker_client.rs` (new) — `wait` and `send`, plus the daemon-record readers and call-id resolution they share.
- `packages/monitor/cockpit-rs/src/cli/restart.rs` (new) — `restart` and the pure `classify_daemon`.
- `packages/monitor/cockpit-rs/src/cli/mod.rs` (modify) — register the two modules.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — dispatch `wait`, `send`, `restart`.
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add an HTTP client only if the crate has none yet. Prefer a raw HTTP/1.1 request over `tokio::net::TcpStream` (all targets are `127.0.0.1`); a `hyper` client (already pulled in by axum) is acceptable. Justify any new crate in a comment.

Reuse from the crate: the argv helpers `positionals(rest)` and `flag_value(rest, name)` (in `cli/mod.rs`; add `flag_value` there if missing), the registry reader, `call_log::latest_open_call_id(lines) -> Option<String>`, `process_alive::is_alive(pid) -> bool`, `tunables::env_int(name, fallback)`, and the `paths` module (cockpit home, plugin root).

## Implementation notes

The daemon's broker and permission-relay routes are both in place before this task starts. The `cli: wait` success path needs both: `/api/wait` parks only when `answer_here` is on and the session has a live `/api/permission-stream` subscriber. `send` is only a client of `/api/respond`, which wakes a parked `/api/wait`. It never touches `/api/inbox` or `/api/send-message`.

### Shared helpers (port of `cockpit.ts`)

- `positionals(rest)` returns every token not starting with `--`; a `--x` token also skips the token after it. `flag_value(rest, name)` returns the token after the first `--name`.
- `read_daemon()` reads `$COCKPIT_HOME/daemon.json` and returns `Some{pid?, port, token}` only when `port` is a number and `token` is a string. A missing or corrupt file returns `None`. Read it fresh on every call.
- `require_daemon()` checks `None`, or a numeric pid that is not alive. In either case stderr gets `cockpit daemon not running — start the dashboard first` and the process exits 1.
- `resolve_call_id(session, explicit)`:
  - An explicit `--call` wins.
  - Otherwise find the registry entry whose `sessionId` matches, read its `logPath`, split on `\n`, and return `latest_open_call_id(lines)`.
  - A missing entry, a missing file, or a read error returns `None`.
- `error_text(res)`: when the body is JSON with `error`, return `<error> (HTTP <status>)`. Otherwise return `HTTP <status>`.

### `wait <sessionId> [--call id]`

- No positional: stderr `cockpit wait: <sessionId> is required`, exit 1.
- Call `require_daemon()`, then resolve the call id.
- Max duration: `env_int("COCKPIT_WAIT_MAX_MS", 21_600_000)` (6 h). Add `COCKPIT_WAIT_MAX_MS` to the env table's meaning in a code comment; it is a TS-honored override.
- URL: `http://127.0.0.1:<port>/api/wait?session=<enc>&token=<enc>&require_watcher=1[&call=<enc>]`. Percent-encode exactly as JS `encodeURIComponent`.
- Loop until the max duration elapses:
  - **Connection error**: increment the failure count and re-read `daemon.json`. Exit 1 with stderr `cockpit wait: lost connection to daemon (<msg>)` when any of these hold: the record is gone, the pid is dead, the port changed, the token changed, or failures ≥ 3. Otherwise sleep 1 s and retry. A successful response resets the count.
  - **Non-2xx**: stderr `cockpit wait: <error_text>`, exit 1. Never retry.
  - **Body not JSON**: sleep 1 s, re-poll.
  - **`answer` is a string** (including `""`): print it to stdout with a trailing newline, exit 0.
  - **`superseded === true`**: stderr `cockpit wait: call is no longer open (superseded)`, exit 3.
  - **`not_watching === true`**: exit 4. Stderr is `cockpit wait: nobody is watching — the answer-here switch is off` when `reason === "toggle_off"`, else `cockpit wait: nobody is watching — no cockpit tab has this session open`.
  - **Anything else** (the `{answer:null, timeout:true}` sentinel): re-poll immediately.
- After the loop: stderr `cockpit wait: no answer received`, exit 1.

Exit codes are a contract: 0 answer, 1 error/dead daemon, 3 superseded, 4 not watching.

### `send <sessionId> <answer...> [--call id]`

- `sessionId` is the first positional. The answer is the remaining positionals joined with a single space (possibly `""`).
- No session: stderr `cockpit send: <sessionId> <answer> is required`, exit 1.
- Call `require_daemon()` and resolve the call id.
- `POST http://127.0.0.1:<port>/api/respond` with header `Content-Type: application/json` and body `{"session","answer","call","token"}`, in that key order. `call` is `null` when unresolved.
- Connection error: stderr `cockpit send: lost connection to daemon (<msg>)`, exit 1.
- Non-2xx: stderr `cockpit send: <error_text>`, exit 1.
- A body that is not JSON counts as `{}`.
- Output:
  - `delivered` is truthy: stdout `delivered: true`.
  - Otherwise: stdout `delivered: false`, then `  (answer logged, but the session isn't parked/listening right now)`.
- Exit 0 in both output cases.

### `restart [--port N] [--no-open]`

Pure core, with a `cargo test` for every branch:

```rust
pub enum DaemonKind { Ours, Foreign, Absent }
/// no record / non-numeric pid / dead pid → Absent; root == my_root → Ours; else Foreign
pub fn classify_daemon(pid: Option<i64>, root: Option<&str>, my_root: &str, is_alive: impl Fn(i64) -> bool) -> DaemonKind;
```

- `my_root` is `<plugin root>/skills/cockpit/scripts`. This is the same string the server writes to `daemon.json.root`, so a TS daemon from the same install classifies as `Ours` and a different version's as `Foreign`.
- `read_daemon_file()` returns `{pid?: number, root?: string}` from one read. Take one snapshot per tick and never read pid and root separately.
- `stop_pid(pid)`:
  1. Send SIGTERM. An error means the process is already gone; return.
  2. Poll `is_alive` every 50 ms, up to 30 times.
  3. If still alive, send SIGKILL and poll every 50 ms, up to 20 times.
- Flow:
  1. If the current daemon pid is alive, `stop_pid` it.
  2. For attempts 1 to 4:
     1. Spawn `<current exe> server [--port N] [--no-open]`: detached (new session / `setsid`), stdio null, `COCKPIT_PLUGIN_ROOT` passed through. Attempt 1 adds `--no-open` only if the user passed it; attempts 2 to 4 always add `--no-open`.
     2. Poll every 100 ms for up to 4 s:
        - `Ours`: re-read with `read_daemon()`. If `GET http://127.0.0.1:<port>/api/token` (800 ms timeout) returns 2xx or 503, print `cockpit: daemon restarted → http://localhost:<port> (pid <pid>)`, then `  serving: <my_root>`, and exit 0.
        - `Foreign`: `stop_pid` it, then break to the next attempt.
        - `Absent`: keep polling.
  3. After all attempts: stderr `cockpit restart: could not confirm a fresh daemon from this install — a respawn from another install may be contending for the port. Retry, or restart the Claude session so its channel uses the updated plugin.`, exit 1.
- The TS spawned `bun cockpit-server.ts`. Rust spawns its own exe. That is the only intended difference; say so in a one-line comment.

## Acceptance criteria

- [x] Against Rust, `cli: wait` passes: an answer string (including empty) exits 0 with it on stdout; superseded exits 3; `not_watching` exits 4 with the right message for each reason; a dead or missing daemon exits 1; the timeout sentinel re-polls.
- [x] Against Rust, `cli: send` passes: the `delivered: true` / `delivered: false` output, a non-2xx exiting 1 with `<error> (HTTP <status>)`, and the call id auto-resolved from the session's log.
- [x] Against Rust, `cli: restart` passes: it replaces a running daemon, confirms `daemon.json.root` equals `<plugin root>/skills/cockpit/scripts`, and prints the two success lines.
- [x] `classify_daemon` has `cargo test` cases for absent (no record, no pid, dead pid), ours, and foreign.
- [x] The query string uses `encodeURIComponent` semantics, with a `cargo test` over a session id containing `/`, space, and `&`.
- [x] The `restart` source comment names the one intended behavioral difference (spawns its own exe instead of `bun cockpit-server.ts`).

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: wait"`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: send"`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: restart"`
- [x] The same three groups, run without `COCKPIT_BIN` (against TS), still pass.

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong exit code for any of 0/1/3/4, or restart leaves two daemons | Happy paths pass, but reconnect-on-drop, a non-2xx, or the foreign-root retry drifts from TS | All three groups pass against Rust and TS; the exit-code contract and stderr text are exact |
| Test coverage | ×2 | No cargo tests | `classify_daemon` only | `classify_daemon`, URL encoding, and call-id resolution all covered, plus the contract groups |
| Interface & readability | ×1 | HTTP and polling logic tangled with parsing; `unwrap` on responses | Works, but `wait` and `send` duplicate daemon reads | One daemon reader and one call resolver, shared; `classify_daemon` is pure |
| Assumptions & docs | ×1 | Undocumented new crate | The restart spawn difference is unexplained | The spawn difference, `COCKPIT_WAIT_MAX_MS`, and any new crate are each justified in one line |

## Out of scope

- The daemon side of `/api/wait` and `/api/respond` — Deferred. Reason: the broker routes belong to the server port; this task is only the client.
- Changing `wait`'s 6 h ceiling or the connection-failure limit — Deferred. Reason: parity first; tuning is a separate change.
