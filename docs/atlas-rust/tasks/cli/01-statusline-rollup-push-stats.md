# CLI-01: Statusline and push-usage subcommands

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/03, engine/05, engine/07, contract/04
> **Blocks**: ship/01
> **Status**: done

## Goal

`cockpit atlas statusline` and `cockpit atlas push-usage` behave exactly as `statusline-collector.ts` and `push-usage.ts` do, so the `statusline`, `push-usage`, and `rollup-update` groups of the CLI contract suite (`packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts`) pass against Rust (the `stats` and `live` groups need the stats assembly and the live module, and are gated where both exist), with the statusline's own overhead measured against the ≤ 10 ms target.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/statusline.rs` (modify — replace the stub) — ports `statusline-collector.ts` and `rate-limits-cache.ts`.
- `packages/monitor/cockpit-rs/src/atlas/push_usage.rs` (modify — replace the stub) — ports `push-usage.ts`.
- `packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts` (modify) — add one test inside the `statusline` describe block, the pipe-pressure test below, as `test.skipIf(!isRust())` with a 15 s timeout (the TS `spawnSync` is not what is under test).

`atlas rollup-update` already works (the ingest port), and so do the Claude and Codex usage-limit readers push-usage calls; the full `atlas stats` may still be a stub while this task runs, which is why this task's gate filters the CLI suite to `statusline|push-usage|rollup-update`. Signatures stay as `_context/engine-api.md` fixes them: `pub fn run(args: &[String]) -> std::process::ExitCode` in each file.

## Implementation notes

Authoritative TS while it exists: `packages/monitor/skills/usage-dashboard/scripts/statusline-collector.ts`, `rate-limits-cache.ts`, `rate-limits-cache.test.ts`, `push-usage.ts`. Port what they do; the rules below pin the details that fail silently.

### `atlas statusline` — order of operations

1. Read **all** of stdin as raw bytes. Keep the bytes; the inner command gets the same bytes.
2. Cache rate limits (below). Any error is swallowed.
3. Nudge `rollup-update` (marker `~/.cache/token-atlas/.rollup-nudge`, throttle 5 min = 300 000 ms).
4. Only when `LLM_QUOTA_INGEST_URL` trimmed is non-empty: nudge `push-usage` (marker `~/.cache/token-atlas/.push-nudge`, throttle 2 min = 120 000 ms).
5. Run the inner statusline command and exit with its code.

**No tokio runtime in this subcommand.** It runs on every statusline tick; use `std::fs`, `std::process`, and `serde_json` only. Paths come from `atlas/paths.rs` (`TOKEN_ATLAS_CACHE_DIR` = `~/.cache/token-atlas`, `RATE_LIMITS_CACHE` = `…/rate-limits.json`).

### Rate-limits cache (`buildRateLimitsRecord`)

```rust
// Pure; `now_ms` injected so tests are deterministic.
fn build_rate_limits_record(payload: &[u8], now_ms: i64) -> Option<serde_json::Value>;
```

- Parse the payload as JSON. Not JSON → `None` (non-JSON stdin still flows to the inner command).
- `rate_limits` missing or **JS-falsy** → `None`. JS-falsy means `null`, `false`, `0` (incl. `-0`/`0.0`), `""`. An empty object or array is truthy and **is** cached.
- Otherwise the record, key order exactly: `{"capturedAt": <ISO>, "capturedAtEpochMs": <ms>, "rate_limits": <input value verbatim>}`. `capturedAt` is the JS `toISOString()` form: UTC, millisecond precision, `Z` suffix — `2026-05-25T00:00:00.000Z` (format with `jiff` as `%Y-%m-%dT%H:%M:%S%.3fZ` in UTC).
- Write: `mkdir -p` the cache dir, then write `serde_json::to_string_pretty(&record)` — 2-space indent, **no trailing newline** (TS `JSON.stringify(record, null, 2)`). `serde_json` with `preserve_order` keeps the input `rate_limits` key order.
- **Clock**: the TS stamps this from `new Date()`, not from the `TOKEN_ATLAS_NOW_MS` seam, and the contract asserts the stamp lies between the test's before/after real clock. Use the real clock (`SystemTime::now()`) here, not `model::now_ms()`. One-line comment saying so.

Worked example (from `rate-limits-cache.test.ts`), now = `2026-05-25T00:00:00.000Z` (1779667200000):

| payload | result |
|---|---|
| `not json` | `None` |
| `{"model":"x"}` | `None` |
| `{"rate_limits":null}` / `{"rate_limits":0}` | `None` |
| `{"rate_limits":{"primary":{"used_percent":12}}}` | `{"capturedAt":"2026-05-25T00:00:00.000Z","capturedAtEpochMs":1779667200000,"rate_limits":{"primary":{"used_percent":12}}}` |

### Nudges

```rust
// Pure throttle decision; unit-tested.
fn should_nudge(last_mtime_ms: Option<i64>, now_ms: i64, throttle_ms: i64) -> bool; // missing marker = 0
fn nudge(marker: &Path, throttle_ms: i64, sub: &str); // swallows every error
```

- `last` = marker mtime in ms, or `0` when the marker is missing/unreadable. Skip when `now - last < throttle`. `now` is the **real** clock (the TS uses `Date.now()`; the marker mtime is real time, so comparing it against a pinned seam value would never or always fire).
- Otherwise, in this order: `mkdir -p` the cache dir, write the marker as an empty file (this bumps its mtime — **touch before spawning**, so a slow or failed spawn still throttles), then spawn.
- Spawn `std::env::current_exe()` with args `["atlas", sub]` (`sub` = `rollup-update` or `push-usage`), stdin/stdout/stderr `Stdio::null()`, detached with `crate::process_alive::detach(&mut command)` (setsid). Drop the `Child` without waiting and without `reap_in_background`.
- Why no zombie remains: the statusline process exits within milliseconds of the spawn, so the child is reparented to init (launchd/PID 1), which reaps it. `reap_in_background` exists for long-lived parents only. Put this as a one-line comment at the spawn.
- The child inherits the environment, so `HOME`, `XDG_DATA_HOME`, `TOKEN_ATLAS_ROLLUP_DB`, and the `LLM_QUOTA_*` vars reach it.
- Every error (stat, mkdir, write, spawn, `current_exe`) is swallowed.

### Inner statusline command

- Command = `TOKEN_ATLAS_STATUSLINE_COMMAND` trimmed; empty or unset → `bunx -y ccstatusline@latest`.
- Run `sh -c <command>` (Node's `shell: true` is `/bin/sh -c`). stdin = a pipe fed the exact stdin bytes read in step 1, then closed; stdout = pipe; **stderr = inherited** (TS `stdio: ["pipe", "pipe", "inherit"]`).
- Write the child's stdout to our stdout unchanged. (TS decodes it as UTF-8 and re-encodes; forwarding raw bytes is identical for valid UTF-8 and is deliberate — one-line comment.)
- Exit code mapping, pinned from TS `runStatusline`:
  - child exited normally → its exit code;
  - spawn failed (`sh` not runnable) → `1`;
  - child killed by a signal (no numeric status, no spawn error) → `0`.
- Write stdin to the child from a helper thread while the main thread drains stdout (`wait_with_output()`), never write-then-wait: an inner command that prints more than a pipe buffer before reading stdin would deadlock both sides. Pin it with the pipe-pressure test in `cli.contract.test.ts`: `TOKEN_ATLAS_STATUSLINE_COMMAND` prints 1 MB, then reads its whole stdin; feed 1 MB on stdin; assert exit 0 and 1 MB of stdout within the 15 s timeout.

### `atlas push-usage`

- `LLM_QUOTA_INGEST_URL` trimmed empty or unset → return exit 0 immediately, no network, no runtime built.
- Otherwise build a tokio `current_thread` runtime (per `_context/shared.md`) and:
  - `claude = claude::read_usage_limits(&ctx)` (sync), `codex = codex::read_codex_usage_limits(&ctx).await` (it reuses its own 5-minute cache file and only calls the Codex API when stale).
  - Payload, key order exactly: `{"capturedAt": <number ms>, "claude": <UsageLimits>, "codex": <UsageLimits>}`. `capturedAt` is the real clock (TS `Date.now()`; `push-usage.ts` is not on the seam list).
  - `POST` to the URL with headers `Content-Type: application/json` and `X-Auth-Token: <LLM_QUOTA_INGEST_SECRET trimmed, or "">`, body = `serde_json::to_string(&payload)`, total timeout 8 s (reqwest with rustls, already enabled).
  - Any error — non-2xx, connection refused, timeout, a failing limits read — is swallowed. Always exit 0, and print nothing the TS does not print.
- `Ctx::from_env()` failing (plugin root not found) must not make push-usage exit non-zero when the URL is unset — check the URL first.

### Performance measurement (reported, not hidden)

With both markers fresh (touch them just before) so no spawn happens and `TOKEN_ATLAS_STATUSLINE_COMMAND=true`, measure `atlas statusline` wall time with an empty-object stdin:

- a bun script that spawns the subcommand 50 times with `Bun.spawn`, feeds the stdin, times each run with `Bun.nanoseconds()`, and reports the median; measure `sh -c true` the same way and report total, baseline, and net (the target applies to net). No `date +%s%N`: macOS `date` has no `%N`.

Subtract the cost of running `sh -c true` alone (measure it the same way) to get the collector's own overhead. Record both numbers in the task report. Target ≤ 10 ms; a miss is reported with the number, never rounded away.

### Tests (`#[cfg(test)]` in the two files)

- `build_rate_limits_record`: every row of the table above, plus `false`, `""`, `[]` (cached), `{}` (cached), and key order of the output (serialize and compare the string).
- `capturedAt` formatting for a timestamp with non-zero milliseconds (e.g. `…T12:34:56.007Z`).
- `should_nudge`: missing marker → true; `now - last` just under the throttle → false; exactly at the throttle → true.
- Exit-code mapping as a pure function over `std::process::ExitStatus` / spawn error, if factored out (signal case via `ExitStatusExt::from_raw`).

## Acceptance criteria

- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts -t "statusline|push-usage|rollup-update"` passes with no failing test.
- [x] The same suite still passes against TS (COCKPIT_BIN unset).
- [x] `rate-limits.json` written by Rust has key order `capturedAt, capturedAtEpochMs, rate_limits`, 2-space indent, no trailing newline, and `capturedAt` in `toISOString()` form; JS-falsy `rate_limits` writes nothing.
- [x] The marker is written before the spawn; a second run inside the throttle window leaves the marker mtime unchanged and spawns nothing; `.push-nudge` appears only with a non-empty `LLM_QUOTA_INGEST_URL`.
- [x] The inner command gets the exact stdin bytes; its stdout is forwarded, stderr inherited, and its exit code returned (spawn failure → 1, signal → 0).
- [x] `atlas push-usage` with no URL exits 0 without building a runtime or touching the network; with a URL it POSTs the pinned headers and `capturedAt, claude, codex` body within 8 s and exits 0 on every failure.
- [x] `statusline.rs` builds no tokio runtime (`grep -n 'tokio' packages/monitor/cockpit-rs/src/atlas/statusline.rs` prints nothing).
- [x] The task report states the measured statusline overhead (median ms, method, and the `sh -c true` baseline subtracted) against the ≤ 10 ms target.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts -t "statusline|push-usage|rollup-update"`
- [x] `bun test packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `grep -n 'tokio' packages/monitor/cockpit-rs/src/atlas/statusline.rs` prints nothing.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | CLI contract suite fails against Rust, or the statusline blocks on a nudged child, or a nudge error breaks the statusline | Suite passes but a pinned detail drifts: trailing newline on `rate-limits.json`, seam clock used for the stamp or throttle, marker touched after spawn, signal exit mapped to non-zero, empty `rate_limits` object skipped | Suite green against Rust and TS; file text, key order, falsy rule, throttle, touch-before-spawn, stdin passthrough, stderr inheritance, exit mapping, and push-usage headers/body/timeout all match the TS |
| Test coverage | ×2 | No cargo tests | Happy-path record only | Record builder covers every falsy/truthy case and ISO milliseconds; throttle boundary tested; exit-code mapping tested including the signal case |
| Interface & readability | ×1 | Tokio runtime in the statusline path, `unwrap` on stdin/JSON/fs, nudge logic duplicated per marker | Works, but pure logic tangled with I/O so it cannot be unit-tested | Pure `build_rate_limits_record` / `should_nudge` separated from I/O; one `nudge` fn for both markers; clippy clean |
| Assumptions & docs | ×1 | Deliberate differences from TS unexplained | Some explained | One-line comments on: real clock (not seam) for stamp and throttle, raw stdout forwarding, why no zombie after detach; the overhead measurement reported with method and baseline |

## Out of scope

- Rewiring `~/.claude/settings.json` or the install scripts' collector regex — Deferred. Reason: the wiring task migrates existing statusline commands to the shim once this subcommand exists.
- `atlas rollup-update` and `atlas stats` behavior — Deferred. Reason: the ingest port owns rollup-update and the stats assembly owns stats; this task relies only on rollup-update.
- Routing the rate-limits stamp or the throttle through `TOKEN_ATLAS_NOW_MS` — Deferred. Reason: the TS uses the real clock there and the contract asserts real-clock stamps.
