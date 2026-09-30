# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

Cockpit is the live-session dashboard inside the `monitor` plugin of the `q-lab-marketplace` repo (Claude Code / Codex / OpenCode plugins). Today it is ~8,800 lines of Bun TypeScript under `packages/monitor/skills/cockpit/scripts/`. This plan replaces every cockpit process — daemon, per-session channel MCP server, CLI, hooks — with one Rust binary named `cockpit`, because each Claude session spawns a Bun channel costing ~55 MB. The on-disk files, HTTP routes, MCP messages, CLI argv/stdout/exit codes and hook outputs must stay byte-compatible; `_context/contracts.md` lists them.

## Tech stack

- **Rust**: stable 1.98, edition 2024. One crate at `packages/monitor/cockpit-rs/`, one binary target `cockpit`.
- **Crates** (check each crate's current API with context7 — `bunx ctx7 docs <id> "<question>"` — before writing code against it; pin exact minor versions in `Cargo.toml`):
  - `tokio` — `current_thread` runtime only. No multi-thread runtime: it costs a thread stack per core. `fn main` is synchronous and never uses `#[tokio::main]`; each subcommand that needs async builds its own runtime inside its own synchronous `run(args) -> ExitCode` with `tokio::runtime::Builder::new_current_thread().enable_all().build()`. Two runtimes never nest.
  - `axum` — HTTP server, SSE (`axum::response::sse`), long-poll handlers.
  - `rmcp` — MCP stdio server for `cockpit channel`. Custom notifications via `CustomNotification { method, params }`.
  - `rusqlite` with feature `bundled` — read-only access to Codex `state_5.sqlite` and `opencode.db`. Open with `OpenFlags::SQLITE_OPEN_READ_ONLY`.
  - `notify` — file watching (replaces `fs.watch`).
  - `tokio-tungstenite` — WebSocket JSON-RPC to the Codex app-server control Unix socket.
  - `serde`, `serde_json` — every JSON shape. Use `#[serde(skip_serializing_if = "Option::is_none")]` where TS omits a field; key order in written files must match the TS writer.
  - `clap` (derive) — argv parsing. Error text and exit codes must match the TS CLI, so override clap's defaults where they differ.
  - `serde_json` with feature `preserve_order` — written files and responses keep TS key order.
  - A YAML parser (e.g. `serde_yaml_ng` or `serde_norway`; pick one maintained crate) — `design-system.ts` and `project-info.ts` parse YAML via `Bun.YAML`.
  - `regex` for plain patterns; where a TS regex uses lookaround, rewrite the logic by hand rather than adding `fancy-regex`.
  - Allowed small utilities: `anyhow`, `thiserror`, `tempfile` (dev). No checksum crate: the shim verifies downloads.
  - Anything else needs a one-line justification comment in `Cargo.toml` naming the failure it prevents.
- **Bun**: stays for the contract test suite, `diagram-lint.ts`, usage-dashboard, and the TS files usage-dashboard imports (`cockpit-home.ts`, `http.ts`).
- **Release profile**: `opt-level = "z"` is NOT used; use `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`.

## Code style

- `cargo fmt` default style; `cargo clippy --all-targets -- -D warnings` clean.
- One module per TS module being ported, named after it in snake_case (`sse_tailer.rs` for `sse-tailer.ts`). Port behavior, not structure: a TS helper used once may be inlined.
- Comments say why, never what, one line. Carry over a TS comment only when it explains a non-obvious constraint (e.g. "hop budget must stay under idleTimeout").
- No `unwrap()`/`expect()` on I/O or parse of external data; `expect` is allowed only for invariants the code itself established.
- Do not handle errors the code cannot reach. Where TS swallowed an error (`catch {}` best-effort), swallow it the same way.
- Every env var the TS reads is honored with the same name and fallback (list in `_context/contracts.md`).
- Bun TS in this repo: `type` over `interface`; no runtime npm deps.

## File / directory layout

```
packages/monitor/
├── cockpit-rs/                    # new crate
│   ├── Cargo.toml                 # package.version == monitor plugin.json version
│   ├── Cargo.lock                 # committed
│   └── src/
│       ├── main.rs                # clap dispatch → subcommand modules
│       ├── paths.rs               # cockpit home, claude/codex/opencode paths, config path, plugin root
│       ├── config.rs, tunables.rs, registry.rs, log_root.rs, daemon_info.rs, process_alive.rs
│       ├── server/                # `cockpit server`: mod.rs + one file per route group
│       ├── channel/               # `cockpit channel`
│       ├── cli/                   # log, scribe, prep, config, wait, send, restart, nudge, find-session
│       └── hook/                  # session-start, stop
└── skills/cockpit/
    ├── bin/cockpit                # new POSIX sh shim (mode 100755)
    ├── contract/                  # new bun black-box contract suite
    │   ├── launcher.ts
    │   └── *.contract.test.ts
    ├── dashboard/dist/            # SPA, unchanged, served from disk
    └── scripts/                   # TS; mostly deleted at the end
```

- `.gitignore` gets `packages/monitor/cockpit-rs/target/`.
- Rust unit tests live next to the code (`#[cfg(test)] mod tests`). Integration tests that spawn the binary belong in the bun contract suite, not in `cockpit-rs/tests/`.

## Commit & branching style

- Branch: `main` (GitHub Flow). Autopilot runs each task in its own worktree.
- Tasks do not commit. Under autopilot, a commit agent commits each wave; leave changes unstaged.
- Never write into the main tree from a worktree; write only this task's own declared files.

## Verification baseline

Run every command from the repo root.

- Build: `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- Rust tests: `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- Rust lint: `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check` and `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- Contract suite against TS: `bun test packages/monitor/skills/cockpit/contract/`
- Contract suite against Rust: `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/`
- A single contract file: append its path, e.g. `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts`
- Typecheck TS you touched: `bunx --bun tsc --noEmit | grep <path-you-touched>` must print nothing (the repo-wide run is not green; never pass file names to tsc).
- Never start the real daemon on port 5858 or touch the real `~/.local/share/q-lab/cockpit`; every test and manual run sets `COCKPIT_HOME=$(mktemp -d)` and a free port.

## Decisions frozen during interview

- **Scope: all of cockpit** — daemon, channel, CLI, hooks. usage-dashboard stays Bun.
- **One binary, subcommands** — `cockpit server|channel|log|scribe|prep|config|wait|send|restart|nudge|find-session|hook session-start|hook stop|--version`.
- **Big-bang release** — one monitor major release switches everything; internal tasks still land process by process behind the contract suite.
- **Parity proof = black-box contract suite** in bun, run against TS first (a process's contract groups are green before that process's port starts; the crate scaffold, shared core modules, and the shim need no contract and may land earlier) and against Rust via `COCKPIT_BIN`. It stays permanently; TS unit tests of deleted modules are deleted with them; Rust internal logic gets `cargo test`.
- **Stack**: tokio current_thread + axum + rmcp + rusqlite(bundled) + notify + tokio-tungstenite + serde + clap.
- **MCP via rmcp**. If rmcp cannot declare `experimental` capabilities or send/receive arbitrary-method notifications, fall back to hand-rolled newline-delimited JSON-RPC with serde_json. The channel spike decides once; later work follows it.
- **SPA served from disk** at `<plugin root>/skills/cockpit/dashboard/dist`, never embedded.
- **diagram-lint stays Bun**; the Rust CLI spawns it.
- **Distribution**: GitHub Releases on `FunnyQ/cc-plugins`, tag `monitor-v<version>`, assets `cockpit-<target triple>` + `SHA256SUMS`, downloaded by the sh shim on first run, fail-soft.
- **Targets**: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`. No Windows.
- **Dev override**: `COCKPIT_BIN=<path>` makes the shim exec that binary and makes the contract suite test it.
- **Memory targets** (macOS arm64, `ps -o rss=`): `cockpit channel` ≤ 10 MB idle with one inbox long-poll parked; `cockpit server` ≤ 30 MB with the dashboard loaded and one transcript SSE open.
- **Human-only checks**: real Claude Code channel e2e (message + permission approve), live Codex and OpenCode TUI sends, dashboard visual pass. Everything else must be command-verifiable.
