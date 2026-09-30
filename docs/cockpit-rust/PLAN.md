# Cockpit Rust Rewrite

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-09-30
> **Max parallel**: 4

Slug: `cockpit-rust` (collision check: OK). Run options: **review engine Codex**, **depth Deep** (26 tasks, 8 buckets). No impeccable design phase (no UI change).

## Overview

Rewrite every cockpit process (daemon, per-session channel MCP server, CLI, hooks) as one Rust binary, `cockpit`, so running many agents stops costing ~55 MB of Bun per session. Ship it as one monitor major release, distributed as prebuilt binaries downloaded from GitHub Releases by a POSIX sh shim.

## Goals

- `cockpit channel` idle RSS ≤ 10 MB with one long-poll parked (today 55 MB).
- `cockpit server` RSS ≤ 30 MB with the dashboard open and one transcript SSE live (today 86 MB).
- Every HTTP route, MCP message, CLI subcommand, hook output, and on-disk file shape behaves as the Bun version does, proven by one black-box contract suite that passes against both.
- Users on darwin-arm64, darwin-x64, linux-x64, linux-arm64 get a working binary with no toolchain installed.

## Non-goals

- Rewriting usage-dashboard (`atlas-server.ts`, `live.ts`, rollup) — it stays Bun.
- Rewriting `diagram-lint.ts` — it stays Bun; the Rust CLI delegates to it.
- Changing the SPA (`dashboard/dist/`) or any route/response shape.
- Changing any on-disk schema: `daemon.json`, `registry.json`, `.cockpit/*.jsonl`, `config.json`.
- Windows support.
- Apple notarization / code signing beyond the linker's ad-hoc signature.
- Cutting the release itself (Q runs `/chronicle:release` for monitor, major bump, after review/01).

## Context

Measured 2026-09-30 with 7 agents open: monitor's Bun processes total ~1,030 MB. 8 × `cockpit-channel.ts` ≈ 445 MB, `cockpit-server.ts` 86 MB. Idle Bun is 12.7 MB; importing `@modelcontextprotocol/sdk` + `zod` alone reaches 49.9 MB. Q chose a full Rust rewrite of cockpit over only dropping the SDK.

Current cockpit TS, non-test: 8,769 LOC — daemon closure 5,479, channel 977, CLI 1,655, hooks 658. Tests: 9,430 LOC. Only `broker.test.ts` and `cockpit-bridge.test.ts` drive a real spawned daemon; no test drives the channel over real MCP stdio.

Verified: the plugin cache preserves `+x`; cache files carry `com.apple.provenance`, not `com.apple.quarantine`, so curl-downloaded binaries pass Gatekeeper. rmcp exposes `CustomNotification { method, params }` in both directions (context7, docs.rs/rmcp).

Coupling outside cockpit that must keep working:
- usage-dashboard `atlas-server.ts` imports `cockpit/scripts/cockpit-home.ts` and `cockpit/scripts/http.ts`; `live.ts` imports `cockpit-home.ts` and reads `daemon.json` (`port`) and `registry.json`. These two TS files stay.
- `install/scripts/reap-stale.ts` finds orphans by regex on `.../cockpit/scripts/(cockpit-channel|cockpit-server).ts`.
- `install/scripts/setup.ts` checks `cockpit-channel.ts` exists.
- chronicle's `cockpit-trail.ts` reads `.cockpit/*.jsonl` directly.
- `daemon.json.root` is the plugin root; supersede parses its version from `/monitor/X.Y.Z/` (newest wins).

## Requirements

### MVP

1. **Contract suite** — black-box bun tests that launch the implementation under test through one launcher: `COCKPIT_BIN` set → `$COCKPIT_BIN <subcommand>`, unset → the TS script.
   - Acceptance: each process port starts only after its own contract groups pass against TS (enforced by `Depends on`); the crate scaffold, shared core modules, and the shim need no contract and may land first; the whole suite is green against Rust at ship/04.
2. **Single binary** — `cockpit server | channel | log | scribe | prep | config | wait | send | restart | nudge | find-session | hook session-start | hook stop | --version`.
   - Acceptance: `cargo build --release` produces one binary; `cockpit --version` equals monitor's `plugin.json` version.
3. **Daemon parity** — every route in the route table (`_context/contracts.md`), SSE and long-poll semantics, supersede/reuse startup, SPA served from `<plugin root>/skills/cockpit/dashboard/dist` on disk.
4. **Channel parity** — MCP stdio via rmcp, capabilities `experimental: {"claude/channel":{}, "claude/channel/permission":{}}`, `tools: {}`, same notifications, session-id resolution order, `ensureServer` spawn of `cockpit server --no-open`, exit on stdin EOF/SIGTERM.
5. **CLI + hook parity** — same argv, stdout, exit codes (incl. `wait` exit 4), same hook JSON.
6. **Shim** — `packages/monitor/skills/cockpit/bin/cockpit` (POSIX sh; inside the skill dir so OpenCode's symlinked `~/.config/opencode/skills/cockpit/bin/cockpit` reaches it): `COCKPIT_BIN` override → exec; else binary at `${XDG_DATA_HOME:-~/.local/share}/q-lab/cockpit/bin/<version>/cockpit` → exec; else download `cockpit-<target>` + `SHA256SUMS` from the `monitor-v<version>` release, verify sha256, install, exec. `hook` subcommands: missing binary → start background download, exit 0 silently. `channel`: wait up to 30s, then one stderr line and exit non-zero.
7. **CI** — `.github/workflows/cockpit-release.yml` on tag `monitor-v*` builds 4 targets (darwin on macOS runner, linux musl via cargo-zigbuild), uploads binaries + `SHA256SUMS` to the tag's release.
8. **Wiring** — Claude `plugin.json` (mcpServers + hooks), Codex `hooks.json`, `opencode/plugin.ts`, `reap-stale.ts`, `setup.ts`, `monitor-up.ts`, cockpit skill references all call the shim.
9. **Cleanup** — delete ported TS and its unit tests; keep `cockpit-home.ts`, `http.ts`, `diagram-lint.ts` and whatever they import; update CLAUDE.md.
10. **Memory** — RSS targets in Goals measured with `ps -o rss=` on macOS arm64.

### Later

- Notarization — only if a user hits Gatekeeper via browser-downloaded zip.
- Porting usage-dashboard — separate plan once cockpit numbers are in.

## Tech decisions

- **Stack**: Rust stable (1.98), tokio current_thread runtime, axum (HTTP, SSE), rmcp (MCP stdio), rusqlite `bundled` (read-only Codex/OpenCode DBs), notify (file watching), tokio-tungstenite (Codex app-server WebSocket over Unix socket), serde/serde_json, clap. Executors check each crate's current API with context7 before use.
- **Crate location**: `packages/monitor/cockpit-rs/` (Cargo.toml, `src/`), `target/` gitignored.
- **Storage**: unchanged files; `COCKPIT_HOME` / XDG resolution mirrors `cockpit-home.ts` exactly.
- **Distribution**: GitHub Releases on `FunnyQ/cc-plugins`, asset `cockpit-<rust target triple>`, `SHA256SUMS`. Trust root is GitHub TLS.
- **Versioning**: `cockpit-rs/Cargo.toml` (`kind: "toml"`) and `cockpit-rs/Cargo.lock` (name-anchored pattern on the `cockpit` package block) join monitor's `versionFiles` in `.chronicle/release.json`. Shim reads the version from `../.claude-plugin/plugin.json`.
- **Plugin root**: shim resolves symlinks (`cd -P`) and exports `COCKPIT_PLUGIN_ROOT` (the `packages/monitor` dir); Rust uses it for the dist path and writes `daemon.json.root` = `<plugin root>/skills/cockpit/scripts`, the same string the TS daemon writes, so version-aware supersede keeps working across a mixed TS/Rust fleet.
- **Diagram lint**: `diagram-lint.ts` gains a stdin CLI entry (`bun diagram-lint.ts < src` → problems as JSON array on stdout); `cockpit log|scribe --diagram` spawns it. Bun stays a runtime prerequisite of monitor (usage-dashboard needs it anyway).
- **Server scaffolding once**: the server foundation task adds every server crate to `Cargo.toml`, creates one stub module per route group (each exporting `pub fn router() -> Router<AppState>` and a `#[derive(Default)] pub struct <Group>State`), declares `AppState` with one `Arc<…State>` field per group, and owns `server/presence.rs` (channel liveness + `has_visible_subscriber`). Route-group tasks fill in only their own module and state struct, never `mod.rs`, `AppState`, or `Cargo.toml`. `/api/answer-here` belongs to the broker group, as in TS.
- **Shared Rust modules have one owner**: `find_session.rs` (all three providers) and `nudge_toggle.rs` are written once in the core bucket; channel, CLI, and hooks import them.
- **Tests**: contract suite in bun (`packages/monitor/skills/cockpit/contract/`), internal logic in `cargo test`. Lint: `cargo fmt --check`, `cargo clippy -- -D warnings`.
- **Visual design**: none.
- **Conventions**: `_context/shared.md`. No task commits; autopilot lands work.

## Architecture

```
Claude Code ──stdio──▶ bin/cockpit (sh shim) ──exec──▶ cockpit channel ──HTTP long-poll──┐
hooks (Claude/Codex/OpenCode) ─▶ bin/cockpit hook … ─▶ cockpit hook                        │
skills / Q ─▶ bin/cockpit log|wait|send|restart … ─▶ cockpit <cli> ──HTTP─────────────────┤
                                                                                          ▼
                              cockpit server (axum, 127.0.0.1:5858) ── serves dashboard/dist (disk)
                                 ├─ reads ~/.claude, ~/.codex (sqlite ro), opencode.db (ro)
                                 ├─ Codex app-server control socket (WebSocket JSON-RPC)
                                 └─ OpenCode TUI HTTP bridge
cockpit log|scribe --diagram ─▶ bun diagram-lint.ts < src (stays TS)
usage-dashboard (Bun) ─▶ reads daemon.json / registry.json, imports cockpit-home.ts + http.ts
```

## Migration phases

1. **contract** — pin TS behavior as a black-box suite.
2. **core** — crate, paths, config, registry, daemon lifecycle.
3. **server / channel / cli / hooks** — parallel ports, each gated on its contract tests with `COCKPIT_BIN=target/release/cockpit`.
4. **ship** — shim, CI, wiring, delete TS, docs, RSS measurement.
5. **review** — integration gate.

## Bucketing

- **Strategy**: by process boundary, contract first.
- **Why**: each process has its own contract tests, so buckets parallelize after core and each has a mechanical gate.

### Buckets

- **`contract/`** — launcher + black-box suites, green against TS.
- **`core/`** — crate skeleton and shared modules every subcommand uses.
- **`server/`** — daemon, split by route group.
- **`channel/`** — rmcp spike, then full channel.
- **`cli/`** — CLI subcommands.
- **`hooks/`** — hook subcommands.
- **`ship/`** — shim, CI, wiring, deletion, docs.
- **`review/`** — final review only.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| contract | 01 | launcher-harness | todo | > 4.0 | — |
| contract | 02 | daemon-http-contract | todo | > 4.0 | contract/01 |
| contract | 03 | channel-mcp-contract | todo | > 4.0 | contract/01 |
| contract | 04 | cli-hook-contract | todo | > 4.0 | contract/01 |
| core | 01 | crate-scaffold-paths-config | todo | > 4.0 | — |
| core | 02 | registry-logroot-daemon-lifecycle | todo | > 4.0 | core/01 |
| core | 03 | shared-find-session-nudge-toggle | todo | > 4.0 | core/02 |
| channel | 01 | rmcp-handshake-spike | todo | > 4.0 | core/01, contract/03 |
| channel | 02 | channel-full | todo | > 4.0 | channel/01, core/03, server/01 |
| server | 01 | server-foundation-startup-static | todo | > 4.0 | core/03, contract/02 |
| server | 02 | log-stream-sse-tailer | todo | > 4.0 | server/01 |
| server | 03 | transcript-stream-history | todo | > 4.0 | server/02, server/08 |
| server | 04 | broker-inbox-send | todo | > 4.0 | server/01 |
| server | 05 | permission-relay | todo | > 4.0 | server/04, server/02 |
| server | 06 | codex-control-send | todo | > 4.0 | server/01 |
| server | 07 | opencode-send | todo | > 4.0 | server/01 |
| server | 08 | views-sessions-design | todo | > 4.0 | server/01, server/04 |
| cli | 01 | cli-trail-config-subcommands | todo | > 4.0 | core/03, contract/04 |
| cli | 02 | cli-wait-send-restart-lint | todo | > 4.0 | cli/01, server/05 |
| hooks | 01 | session-start-hooks | todo | > 4.0 | core/03, contract/04 |
| hooks | 02 | stop-hook-scribe-nudge | todo | > 4.0 | hooks/01 |
| ship | 01 | sh-shim-download | todo | > 4.0 | core/01 |
| ship | 02 | ci-release-workflow | todo | > 4.0 | ship/01 |
| ship | 03 | wire-plugins-to-shim | todo | > 4.0 | ship/01, channel/02, server/03, server/05, server/06, server/07, server/08, cli/02, hooks/02 |
| ship | 04 | delete-ts-docs-rss | todo | > 4.0 | ship/02, ship/03 |
| review | 01 | final review 🏁 | todo | > 4.0 | ship/04 |

Rubric: shared bar in `_context/rubric.md` — Correctness ×3 / Test coverage ×2 / Interface & readability ×1 / Assumptions & docs ×1, pass > 4.0, Correctness < 4 veto. review/01 adds Leanness ×1.

Human checks (tagged `(human)`): real Claude channel e2e incl. permission approve (review/01 — needs every server route); Codex + OpenCode send against live TUIs (server/06, server/07); dashboard visual pass (server/03, review/01). Clean-machine install is verified by command: shim test against a local HTTP server via `COCKPIT_RELEASE_BASE_URL`.

## Cross-bucket dependencies

```
contract/01 ─┬─ 02 ─────────────────────────┐
             ├─ 03 ──────────┐              │
             └─ 04 ──┐       │              │
core/01 → core/02 ─┬─┼───────┼──────────────┼─▶ server/01 ─┬─ 08 ─┐
   │               │ │       │              │              ├─ 02 ─┴▶ 03
   │               │ │       │              │              ├─ 04 → 05
   │               │ │       │              │              ├─ 06
   │               │ │       │              │              └─ 07
   │               └─▶ core/03 ─┬─▶ cli/01 → cli/02 (+server/05)
   │                            ├─▶ hooks/01 → hooks/02
   │                            └─▶ channel/02 (+channel/01, +server/01)
   ├─▶ channel/01 (+contract/03)
   └─▶ ship/01 → ship/02
all ports ─▶ ship/03 → ship/04 → review/01
```

## Failure modes & rollback

- **rmcp cannot declare experimental capabilities or emit custom notifications** → channel/01 falls back to hand-rolled JSON-RPC over stdio (serde_json) and records it; the spike decides, not later tasks.
- **CI assets missing when a user updates** (tag pushed, CI running) → shim fails soft; hooks silent, channel errors once; next session retries.
- **Regression after release** → users reinstall monitor 5.x; the release is one commit + one tag, revert-able.
- **Rust RSS misses a target** → ship/04 reports the measured number and the gap; it does not silently pass.

## Open questions

1. **Codex app-server socket path** varies by Codex version — server/06 reuses `codex-control-probe.ts`'s discovery exactly; no new decision.
2. **Max parallel 4** — chosen for RAM: each worktree does its own `cargo build` of tokio/axum/rusqlite. Raise it if builds prove light.

## Known gaps

- Checksums come from the same release as the binary: they catch corruption, not a compromised release.
- A first session after an update may lose its SessionStart decision-log reminder while the binary downloads.

## References

- Measurements in this conversation (2026-09-30).
- https://docs.rs/rmcp/latest/rmcp/model/struct.CustomNotification.html
