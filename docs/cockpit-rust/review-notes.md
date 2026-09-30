# Cockpit Rust: final review notes (review/01)

**Scope.** The leg diff is `git diff --stat bf0376cdeda64db404a3f40cf0f682a121d4b310 -- packages/ opencode/ .github/ .chronicle/ CLAUDE.md .gitignore`. It covers 154 files, +19074 / −16942 through HEAD `86f24c7`. On top of that come the review fixes listed below, which are unstaged in the working tree.

**Review inputs.** Four lens files sit in `docs/cockpit-rust/.flightlog/review/attempt-1/`:

- **codex**: cross-vendor. It ran and found 3 P2 regressions.
- **reuse**: 16 findings.
- **leanness**: 29 findings.
- **efficiency**: 12 findings.

Attempt 2's lens files are in `docs/cockpit-rust/.flightlog/review/attempt-2/`. The **codex** cross-vendor lens ran and found 1 P1, the un-reaped channel daemon. **reuse** had 7 findings, **leanness** 14 and **efficiency** 11.

## 1. One launch path — pass

Every harness entry launches `skills/cockpit/bin/cockpit`:

- **Claude**: `packages/monitor/.claude-plugin/plugin.json:23` (channel mcpServer), `:51` (`hook session-start`) and `:62` (`hook stop`).
- **Codex**: `packages/monitor/.codex-plugin/hooks.json:19` and `:30`.
- **OpenCode**: `opencode/plugin.ts:15` (`COCKPIT_SHIM`).
- **Commands**: `commands/nudge.md:11` and `commands/thoughtful.md:18`.

`rg -n --glob '!*.test.ts' 'bun [^ ]*cockpit/scripts/(cockpit|cockpit-server|cockpit-channel|decision-log-start|scribe-nudge|find-session)\.ts' packages opencode CLAUDE.md` returns exactly one hit. That hit is `opencode/references/opencode-runtime.md:23`, a dated transcript from spike S7 (2026-08-15) showing that Bun follows a skill symlink. It is not a launch path. ship/04 deliberately kept it, and line 5 of that file says the deleted TS names stay "as dated spike observations". Rewriting the observed command would falsify the log, so it stays. This is a documented exemption from the "prints nothing" criterion.

## 2. Mixed-fleet safety — pass

- `daemon_info::daemon_root()` (`cockpit-rs/src/daemon_info.rs:131`) is now the single source of `<plugin root>/skills/cockpit/scripts`. The server writes it into `daemon.json.root` (`server/mod.rs:95`). The channel (`channel/daemon.rs:48`) and `cockpit restart` (`cli/restart.rs:29`) compare against the same value.
- `version_from_root` (`daemon_info.rs:83`) parses `…/monitor/<x.y.z>/skills/…`, the same shape the 5.x TS channel's regex reads. A TS channel therefore sees the Rust daemon's version and supersedes only an older one (`should_supersede_daemon`, `daemon_info.rs:120`). The tests `numeric_versions_and_supersede_convergence` and the `daemon_info` supersede tests pin it.

## 3. Outside consumers — pass

- **usage-dashboard.** `atlas-server.ts:13,19` and `live.ts:16` import `cockpit/scripts/cockpit-home` and `cockpit/scripts/http`. Both files still exist, and `bun test packages/monitor/` passes.
- **reap-stale.** `skills/install/scripts/reap-stale.ts:69-75` matches the old `.ts` process lines, the `skills/cockpit/bin/cockpit (channel|server)` shim line, and the cached binary line (now `q-lab/cockpit-bin/<v>/cockpit`). `reap-stale.test.ts` covers all three and leaves CLI calls alone.
- **chronicle trail reader.** A trail written by the release binary (`cockpit log --session … --decision … --facet … --file …`) parses with `packages/chronicle/shared/scripts/cockpit-trail.ts` `readDecisionLog`: 1 record, `decision: "Use rust"`. `logRoot` resolves the same repo root. `bun test packages/chronicle/` gives 594 pass, 0 fail.

## 4. Release wiring — pass

- `.chronicle/release.json:80-81` lists `packages/monitor/cockpit-rs/Cargo.toml` with `kind: "toml"` under monitor.
- `Cargo.toml` is at `version = "5.2.4"`, which matches `packages/monitor/.claude-plugin/plugin.json:3` and `.codex-plugin/plugin.json:3`.
- **CI assets.** `.github/workflows/cockpit-release.yml:38-47` builds `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. It uploads them as `cockpit-<target>` plus `SHA256SUMS` to tag `$TAG` (`:106`).
- **Shim downloads.** The shim fetches `$BASE/monitor-v$VERSION/cockpit-$TARGET` (`bin/cockpit:62,86`) and `SHA256SUMS` for the same four triples.
- `git diff --name-only bf0376c -- packages/monitor/cockpit-rs/Cargo.toml packages/monitor/skills/cockpit/bin/cockpit .github/workflows/cockpit-release.yml` lists all three paths.

## 5. Leanness — pass after the fixes below

Before the fixes, the crate carried:

- ten stale `#[allow(dead_code)]` module attributes
- five empty `*State` structs that nobody read
- three hand-rolled SSE body adapters
- three `daemon.json` re-parsers
- two copies of the supersede rule and of title persistence
- five session-id checks
- hand-rolled UUID and token generators beside the `uuid` crate

All of that is gone now. One crate was added, `futures-core`, and it carries a justification comment in `Cargo.toml`. It was already in `Cargo.lock` through axum.

## Memory goal (from `docs/cockpit-rust/rss.md`)

| Process | Target | Measured | Result |
| --- | --- | --- | --- |
| channel | ≤ 10 MB | 9008 KB (8.8 MiB) | **pass** |
| server | ≤ 30 MB | 11936 KB (11.7 MiB) | **pass** |

The original `rss.md` from ship/04 never landed: it stayed untracked in the task worktree. This review re-measured with the method in the ship/04 task, and the numbers match what ship/04 logged (9008 / 11616–11808 KB).

## Fixes applied in this review

**Correctness (codex lens):**

1. **Legacy `~/.cockpit` migration was skipped.** The shim created `$XDG_DATA_HOME/q-lab/cockpit/bin/…` before the binary ran, so `paths::cockpit_home()` saw the home as present and never migrated. The binary cache now lives at `$XDG_DATA_HOME/q-lab/cockpit-bin/<version>/`. The change touches `bin/cockpit`, `reap-stale.ts` and its test, `CLAUDE.md`, and `bin/cockpit.test.ts`, which now asserts the cockpit home stays absent after a download. Nothing has shipped with the old path, because monitor's last tag is 5.2.4, from before the shim.
2. **The log backlog read past its stat size.** `LogSource::read_backlog` ignored `size` and read to EOF while the tailer resumed at `size`, so an append in between was emitted twice or spliced. It now reads `take(size)`. The new test is `backlog_stops_at_the_stat_size`.
3. **Chunks over 16 MiB killed the SSE stream.** All three SSE bodies (tailer, OpenCode rows, permission) went through a tungstenite frame codec with a 16 MiB frame cap. A big OpenCode backlog errored, the stream dropped, and the reconnect looped. The fix is one shared `sse_tailer::sse_response(produce)` over an mpsc receiver and `Body::from_stream`, which deletes all three `FrameReader`/`Reader` adapters. This also settles the matching reuse and efficiency findings. The new test is `response_passes_a_chunk_over_16_mib`: a 17 MiB line passes intact.

**Quality (reuse / leanness / efficiency):**

- **Dead code removed.** That covers the stale `allow(dead_code)` attributes and the unread `AppState` fields with their empty structs. It also covers `registry::refresh_heartbeat` and its tests, and `tunables::{wait_timeout_ms, stash_ttl_ms}`.
- **Single-copy helpers.**
  - Title persistence lives in one place, `registry::persist_title_updates`, which is fallible through `try_persist`. The route calls it, and `sessions.rs`'s copy is gone.
  - The channel's `daemon.json` views are built on `daemon_info::read_daemon_info`, and the channel uses `daemon_info::should_supersede_daemon`.
  - `cockpit restart` matches on `decide_startup` in place of the renamed `classify_daemon`.
  - `process_alive::terminate` and `daemon_info::spawn_detached_server` replace duplicated kill and setsid blocks.
  - `registry::is_session_id` replaces six copies, and `log_root::absolute_lexical` replaces its copy in `log_stream.rs`.
  - `opencode::js_truthy` replaces three copies, `find_session` reuses `registry::Provider`, and the `sources::*` and `cli::now_ms` pass-throughs call `paths::*` and `registry::now_ms` directly.
  - Hooks use `registry::now_ms`.
- **Crates in place of hand-rolled code.** `uuid::Uuid::new_v4()` generates response ids and daemon tokens (`.simple()`, still 32 lowercase hex characters). `jiff` formats `iso_timestamp`. `watch::Receiver::wait_for` handles abort waits. `latest_open_call_id` takes a line iterator, so nothing is collected into a `Vec`.
- **Efficiency.**
  - `resolve_claude_transcript_path` stats `<projects>/<dir>/<id>.jsonl` for each project dir before it falls back to the full walk.
  - A tail stream resolves its source once on open, not twice.
  - Static gzip runs on the blocking pool, so the 3.3 MB mermaid bundle no longer stalls SSE on the current-thread runtime.
  - The shim uses one `uname -sm` and `sed …;q`, with no `head`.
- **Contract suite.** The dead `underTest` switch and the unreachable TS-only ECONNRESET branch are gone.
- **`setup.ts`.** The redundant `existsSync` guard before `accessSync` is gone.

## Fixes applied in attempt 2

The first round's binary gate failed on two verification commands. Both now print nothing:

- **Typecheck.** `usage-dashboard/scripts/api.ts:2662` indexed a union of activity records with a union key (TS7053); it now narrows with `"threadCount" in activity`. `atlas-server.ts:237` passed `server.port` (`number | undefined` in current Bun types) to `writeAtlasInfo`; it now passes `server.port ?? port`. Both errors predated this leg, but the gate requires the command to print nothing.
- **No-Bun-launch `rg`.** `opencode/references/opencode-runtime.md:23`, a spike log, quoted `bun …/cockpit/scripts/find-session.ts`. It now reads `bun run …` with a note that the script was deleted in the Rust port.

**Correctness (codex lens):**

- **The channel left its spawned daemon a zombie.** `channel::daemon::ensure_server` dropped the `Child` from `spawn_detached_server`. `setsid()` does not reparent, so a daemon that died while the channel lived stayed in state `Z`, `kill(pid, 0)` kept succeeding, and neither the channel's `should_spawn` nor `cockpit restart` would replace it. The Bun runtime reaped its children. The channel now hands the child to `process_alive::reap_in_background`, a 64 KiB-stack thread that calls `wait()`. The new test is `process_alive::tests::reaped_child_reads_dead_once_killed`. `cockpit restart` already `try_wait`s its own child, and the Stop hook exits right after spawning, so its child is reparented to init.

**Quality (reuse / leanness / efficiency):**

- **One JSON response pair.** `server::json_response(status, value)` and `server::json_error(status, message)` replace seven copies of the content-type + `no-store` tuple and three `error` helpers (`broker::reply`/`error`, `codex.rs`, `transcript.rs`'s reversed-argument one, `opencode.rs`, `views.rs`, the `/api/token` route and the `sse_tailer` error arm).
- **`codex.rs` validates through `broker::validate`.** It had re-implemented the token check, the session-id check and both messages.
- **`transcript.rs` uses `registry::Provider`.** Its third provider enum is gone. The four provider parsers stay, because each emits its own contract-pinned error text.
- **`registry::entry_for` and `call_log::latest_open_call_in`** replace the registry-find + log-read + scan in `broker.rs`, `cli/broker_client.rs`, `views/sessions.rs` and `cli/trail.rs`. `broker.rs`'s `open_call` is gone.
- **`process_alive::detach`** replaces the two `setsid` `pre_exec` blocks (`daemon_info::spawn_detached_server`, `hook/stop.rs`).
- **`daemon_info::DaemonCoords` + `PartialDaemonInfo::coords()`** replace the CLI's `Daemon`/`read_daemon` and the channel's own coords reader; `daemon_info::read_process_info` replaces three `pid && port` filters. The channel's startup loop now reads `daemon.json` once per iteration, and `cockpit restart` uses the `info.port` it already holds.
- **`encode_component` is gone.** `cockpit wait` builds its query with `RequestBuilder::query`, as the channel already does. That encodes a space as `+` where `encodeURIComponent` wrote `%20`, but both the Rust and the TS daemon decode the two the same way, session ids and hex tokens contain neither, and `cli.contract.test.ts:221` reads the decoded `searchParams`.
- **One `NudgeState`.** `config::NudgeState` gained the serde derives and `nudge_toggle` re-exports it, so `from_config`/`to_config` are gone. `nudge_enabled_for` resolves the scopes lazily, so a session override no longer forks `git rev-parse` for the project key.
- **`read_registry` takes ownership** of the parsed `sessions` array rather than deep-cloning every entry.
- **`/api/sessions` and `/api/projects` build on the blocking pool** (`spawn_blocking`), so a build's decision-log reads and SQLite opens no longer stall every open SSE stream and long-poll on the current-thread runtime.
- **`opencode_rows::entries` groups against `groups.last()`.** `read_rows` orders by `(message created, message id)`, so a message's rows are contiguous; a comment at the loop names that dependency.
- **CI installs `cargo-zigbuild` prebuilt** through `taiki-e/install-action@v2` (listed in its `TOOLS.md`) rather than compiling it from source in each Linux job.

## Findings rejected, and why

Attempt 2:

- **efficiency: drop the symlink-following transcript fallback and make `sources::resolve_claude_transcript_path` follow symlinks itself.** That changes what the sessions and permission callers resolve, and their contract groups pin the TS non-symlink walk. The double walk costs only while a stream waits for a transcript that does not exist yet.
- **efficiency: derive `<projects>/<encoded cwd>/<id>.jsonl` from the cwd.** Claude's cwd encoding is undocumented, so the scan would stay as the miss path anyway. One `read_dir` plus one stat per project directory, per active session, every 3 s, is microseconds.
- **efficiency: share one Codex SQLite connection per `build_sessions_at`.** This is one read-only open per active Codex session per poll, now also off the runtime thread.
- **efficiency: `persist_title_updates` re-reads the registry.** The re-read sits right before the write on purpose: hooks write `registry.json` concurrently, and writing back the request's older snapshot would drop their updates.
- **efficiency: `rust-cache` in the release workflow.** Actions caches are scoped by ref, and this workflow runs only on new `monitor-v*` tags, so a cache would never be restored.
- **efficiency: keep one OpenCode connection per stream, and memoize gzipped assets.** These are unchanged from attempt 1 (below). A per-stream connection also keeps SQLite's page cache resident for each open stream, against the RSS goal.
- **leanness: `MIGRATED_TARGETS`, `build-release.sh --sums`, `parse_timestamp`.** These are unchanged from attempt 1 (below).
- **reuse/leanness: `opencode.rs` `validate` → `broker::authorized`.** The Rust copy is TS parity. `opencode-send.ts` compared `token !== daemonToken()` with `daemonToken()` returning `null` for a record without a token, so a query without a token against such a record passed. `broker::authorized` rejects that case. Changing it needs a contract test first.

Attempt 1 (some of these were reversed in attempt 2, as noted):

- **efficiency: compare `state.token` rather than re-reading `daemon.json`.** `cli.contract.test.ts:288` pins that a rewritten `daemon.json.token` changes the daemon's own token (TS parity), and `opencode.rs` tests "reads it fresh".
- **efficiency: memoize gzipped assets.** The cache would keep about 1 MB of compressed assets resident against the 30 MB RSS goal, and ETag revalidation already turns warm loads into 304s. Moving the gzip off the runtime thread fixes the stall this finding cited.
- **efficiency: keep one OpenCode SQLite connection per stream.** A long-lived handle keeps reading a replaced DB file. Opening per 2 s poll is sub-millisecond.
- **efficiency: `groups.last()` in `opencode_rows::entries`.** There are at most 50 groups, and the change would tie correctness to the SQL `ORDER BY`. *Reversed in attempt 2, with the dependency commented at the loop.*
- **efficiency: run the Stop hook's `git diff` and `git status` in parallel.** Concurrent index refreshes race on `index.lock`, and the throttle already gates the probe.
- **leanness: drop `MIGRATED_TARGETS`.** It is TS parity: each target is migrated once per process while XDG overrides change.
- **leanness: replace `encode_component` with `reqwest::query`.** `serde_urlencoded` encodes a space as `+`, not `%20`, which is a wire change. *Reversed in attempt 2: both daemons decode `+` and `%20` the same way.*
- **leanness: drop `build-release.sh --sums`.** `bin/cockpit.test.ts:310` drives it on macOS.
- **leanness: merge the two `NudgeState` enums, drop `broker_client::Daemon`, merge `transcript.rs`'s route-local `Provider`, and add JSON response helpers.** Each is behaviour-neutral churn across CLI and route code that its contract groups already pass. `Daemon` is a typed required-field view, not a pass-through. Left for a follow-up. *Applied in attempt 2, when both the reuse and leanness lenses raised them again.*
- **leanness: hand-rolled `parse_timestamp`.** Its comment cites JS `Date` day-rollover parity, which `jiff` rejects.

## Verification (attempt 2, after fixes)

- `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`: ok.
- `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`: 166 pass, 0 fail. One test was added (the reaper) and one was removed (`encode_component`).
- `cargo clippy … --all-targets -- -D warnings`: clean.
- The contract suite against the release binary: 131 pass, 0 fail.
- `bun test packages/monitor/ opencode/`: 495 pass, 0 fail.
- `git diff --name-only bf0376c -- …Cargo.toml …bin/cockpit …cockpit-release.yml` lists all three paths.
- `bunx --bun tsc --noEmit | grep -E 'packages/monitor/skills/(cockpit|install|usage-dashboard)|opencode/'` prints nothing.
- The acceptance `rg` for Bun cockpit launches prints nothing.
- RSS was not re-measured. The `rss.md` probe starts the server before the channel, so the channel never spawns a daemon and never starts the reaper thread. When the channel does spawn one, that thread adds a 64 KiB stack.

## Verification (attempt 1, after fixes)

- `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`: ok.
- `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`: 166 pass, 0 fail.
- `cargo clippy … --all-targets -- -D warnings`: clean.
- The contract suite against the release binary: 131 pass, 0 fail.
- `bun test packages/monitor/ opencode/`: 495 pass, 0 fail. The first run failed one shim test because its `uname` stub did not answer `-sm`; the stub was updated.
- `bunx --bun tsc --noEmit | grep …`: prints two errors, `usage-dashboard/scripts/api.ts:2662` and `atlas-server.ts:237` (`server.port` typed `number | undefined`). Both files are unchanged since `bf0376c` (`git diff --stat bf0376c -- …/api.ts …/atlas-server.ts` is empty), so the errors predate this leg.

## Human checks still owed

- **(Q)** Run one real Claude Code session on the plugin's shim with `COCKPIT_BIN` pointing at the release build. Check three things: a dashboard message arrives, a permission prompt approved from the cockpit is honoured, and the dashboard panels render.
- **(Q)** After `/chronicle:release` cuts `monitor-v<next>`, confirm that the release workflow uploaded all four `cockpit-<triple>` assets plus `SHA256SUMS` before users update. Until it does, first sessions run without hooks, failing soft.
- **(Q)** On a machine that still has a legacy `~/.cockpit`, check that first run through the shim moves it to `~/.local/share/q-lab/cockpit`.
