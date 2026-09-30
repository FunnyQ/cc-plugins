# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

usage-dashboard ("token atlas") is the usage-analytics dashboard inside the `monitor` plugin of the `q-lab-marketplace` repo. Today its server is ~4,900 lines of Bun TypeScript under `packages/monitor/skills/usage-dashboard/scripts/` and idles at ~197 MB RSS. This plan ports the server, its data engine, the rollup ingest, the statusline collector, and push-usage into the existing Rust `cockpit` binary as `cockpit atlas <sub>` subcommands. The SPA, routes, response shapes, and every on-disk file stay the same; `_context/contracts.md` lists them. The TS stays on disk, unchanged except for the test seams, until the final deletion — **while a port is in progress the TS file is the authoritative behavior; read it and port what it does**.

## Tech stack

- **Rust**: stable, edition 2024, the existing crate `packages/monitor/cockpit-rs/` (package and binary `cockpit`). No new crate, no workspace, no second binary.
- **Crates already in `Cargo.toml`** (check each crate's current API with context7 — `bunx ctx7 docs <id> "<question>"` — before writing code against it):
  - `tokio` — `current_thread` runtime only. `fn main` is synchronous; each subcommand that needs async builds its own runtime inside its own synchronous `run(args) -> ExitCode` with `tokio::runtime::Builder::new_current_thread().enable_all().build()`. Two runtimes never nest.
  - **CPU-heavy or blocking work (building stats, ingesting transcripts, SQLite) runs in `tokio::task::spawn_blocking`** inside the server. The cockpit port learned this the hard way: a blocking build on the current_thread runtime stalls every other request.
  - `axum` — HTTP server.
  - `rusqlite` with feature `bundled` — `rollup.db` and `codex-sessions.db` read-write; Codex `state_5.sqlite` and `opencode.db` read-only (`OpenFlags::SQLITE_OPEN_READ_ONLY`).
  - `serde`, `serde_json` with `preserve_order` — every JSON shape keeps TS key order.
  - `flate2` — gzip. `jiff` — local-time math (hour buckets, `fmtDate`). `libc` — process checks. `regex`, `anyhow`.
  - `reqwest ~0.12` — today `default-features = false, features = ["json"]` (no TLS). **This plan adds rustls with bundled webpki roots** (the feature name for 0.12 is `rustls-tls-webpki-roots`; confirm with context7). The scaffold task makes that change; nobody else edits `Cargo.toml`.
  - Anything else needs a one-line justification comment in `Cargo.toml` naming the failure it prevents.
- **Reuse, do not duplicate**, these existing cockpit modules: `paths::cockpit_home()` (the `atlas.json` dir), `paths::opencode_db()` (honors `COCKPIT_OPENCODE_DB`, `OPENCODE_DATA_DIR`, same as TS `shared/scripts/opencode.ts`), `paths::plugin_root()`, `process_alive::{is_alive, terminate, detach, reap_in_background}`, `server/static_files.rs` (gzip + ETag + 304; generalized to take a root dir), `server::json_response`.
- **Do not reuse cockpit's other path helpers** (`claude_projects_dir`, `codex_dir`, `codex_state_db`): they honor `COCKPIT_CODEX_*` / `COCKPIT_CLAUDE_*` vars the TS dashboard never read. `atlas/paths.rs` mirrors `usage-dashboard/scripts/paths.ts` exactly (see `_context/contracts.md` §1).
- **Bun**: stays for the contract suite and every TS file until the final deletion.
- Release profile is already set (fat LTO, `strip`, `panic = "abort"`); leave it.

## Code style

- `cargo fmt` default style; `cargo clippy --all-targets -- -D warnings` clean.
- One Rust module per TS module being ported (layout below). Port behavior, not structure: a TS helper used once may be inlined.
- Comments say why, never what, one line. Carry over a TS comment only when it explains a non-obvious constraint (e.g. why `hour_ms` is the local hour, why `seen_tool_calls` is per session).
- No `unwrap()`/`expect()` on I/O or parse of external data; `expect` is allowed only for invariants the code itself established.
- Do not handle errors the code cannot reach. Where TS swallowed an error (`catch {}` best-effort), swallow it the same way.
- Every env var the TS reads is honored with the same name and fallback (`_context/contracts.md` §1).
- Numbers: TS `number` is f64. Token counts are integers — use `i64`. Cost math is f64 in the same operation order as TS, so rounding matches. serde prints an integer-valued f64 as `1.0` where JS prints `1`; the golden diff compares parsed values, where the two are equal, so do not special-case it.
- Bun TS in this repo: `type` over `interface`; no runtime npm deps.

## File / directory layout

```
packages/monitor/
├── cockpit-rs/src/
│   ├── main.rs                 # adds the `atlas` arm → atlas::run(args)
│   ├── atlas/
│   │   ├── mod.rs              # `cockpit atlas <sub>` dispatch
│   │   ├── paths.rs            # ← paths.ts + rollup-db.ts path consts
│   │   ├── dedup.rs            # ← dedup.ts
│   │   ├── jsonl.rs            # ← shared/scripts/jsonl-lines.ts
│   │   ├── model.rs            # ← api.ts model-usage types + helpers (ModelUsage, modelKey, addUsage…)
│   │   ├── rollup_db.rs        # ← rollup-db.ts (+ one-time pre-rust backup)
│   │   ├── rollup_update.rs    # ← rollup-update.ts
│   │   ├── pricing.rs          # ← api.ts pricing section
│   │   ├── codex.rs            # ← codex-cache.ts + api.ts Codex section + Codex usage limits
│   │   ├── opencode.rs         # ← api.ts OpenCode section
│   │   ├── claude.rs           # ← api.ts stats-cache/history/rollup readers + Claude usage limits
│   │   ├── stats.rs            # ← api.ts buildStats + fingerprint + serializers + budget + project-cost/daily-activity
│   │   ├── server.rs           # ← atlas-server.ts + atlas-lifecycle.ts
│   │   ├── live.rs             # ← live.ts + live-sessions.ts + session-files.ts
│   │   ├── statusline.rs       # ← statusline-collector.ts + rate-limits-cache.ts
│   │   └── push_usage.rs       # ← push-usage.ts
│   └── server/static_files.rs  # generalized: serve_dir(root, uri, headers)
└── skills/usage-dashboard/
    ├── contract/               # new bun black-box + golden suite
    │   ├── launcher.ts
    │   ├── fixtures.ts         # builds a fixture HOME
    │   ├── golden/             # recorded TS outputs (committed)
    │   └── *.contract.test.ts
    ├── dashboard/dist/         # SPA, unchanged, served from disk
    └── scripts/                # TS; deleted at the end
```

- Rust unit tests live next to the code (`#[cfg(test)] mod tests`). Anything that spawns the binary belongs in the bun contract suite.
- Each engine module owns its own types; `stats.rs` imports them. A type two modules need lives in `model.rs`.

## Commit & branching style

- Branch: `main` (GitHub Flow). Autopilot runs each task in its own worktree.
- Tasks do not commit. Under autopilot, a commit agent commits each wave; leave changes unstaged.
- Never write into the main tree from a worktree; write only this task's own declared files.

## Verification baseline

Run every command from the repo root.

- Build: `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- Rust tests: `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- Rust lint: `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check` and `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- Atlas contract suite against TS: `bun test packages/monitor/skills/usage-dashboard/contract/`
- Atlas contract suite against Rust: `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/`
- One file: append its path, e.g. `… bun test packages/monitor/skills/usage-dashboard/contract/golden.contract.test.ts`
- Cockpit's own suite must stay green after any edit to a shared cockpit module: `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/`
- Typecheck TS you touched: `bunx --bun tsc --noEmit | grep <path-you-touched>` must print nothing (the repo-wide run is not green; never pass file names to tsc).
- **Never touch real user data.** Every test and manual run sets `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `COCKPIT_HOME` to a `mktemp -d` dir and uses a free port — never 5938, never the real `~/.local/share/q-lab/token-atlas/rollup.db`.

## Real-data runs (human checks and measurements only)

A check that needs Q's real data never writes a real file. Build one isolated root per implementation run:

```sh
R=$(mktemp -d); mkdir -p "$R/home/.config" "$R/home/.cache/token-atlas" "$R/data" "$R/cockpit"
ln -s ~/.claude "$R/home/.claude"; ln -s ~/.codex "$R/home/.codex"   # inputs only; neither implementation writes under them
cp -R ~/.config/cc-dashboard "$R/home/.config/" 2>/dev/null
cp ~/.cache/token-atlas/rate-limits.json ~/.cache/token-atlas/codex-usage-limits.json "$R/home/.cache/token-atlas/" 2>/dev/null
sqlite3 ~/.local/share/q-lab/token-atlas/rollup.db "VACUUM INTO '$R/rollup.db'"   # a plain cp of a WAL DB can read short
cp ~/.local/share/q-lab/cockpit/daemon.json ~/.local/share/q-lab/cockpit/registry.json "$R/cockpit/" 2>/dev/null
export HOME="$R/home" XDG_DATA_HOME="$R/data" XDG_CONFIG_HOME="$R/home/.config" COCKPIT_HOME="$R/cockpit" \
  TOKEN_ATLAS_ROLLUP_DB="$R/rollup.db" COCKPIT_OPENCODE_DB=<real path of ~/.local/share/opencode/opencode.db>
```

One exception, run by Q alone and never by an executor: the live statusline migration check rewrites the real `~/.claude/settings.json`. Q copies it to `~/.claude/settings.json.pre-atlas` first; executors verify the migration only through temp-HOME tests.

Use a free port, never 5938. Every output — `atlas.json`, `codex-sessions.db`, the Codex usage cache, nudge markers, the rollup copy — lands under `$R`.

**For a TS-vs-Rust comparison**, every input must be identical and frozen for both runs, and neither run may touch the network. Snapshot once, then build both roots from the snapshot only:

1. `S=$(mktemp -d)`; `mkdir -p "$S/.codex" "$S/config"`; `cp -Rpc ~/.claude "$S/"`; `cp -Rpc ~/.codex/sessions "$S/.codex/"` (`-c` = APFS clone, instant and free; `-p` keeps mtimes); `cp -Rp ~/.config/cc-dashboard "$S/config/" 2>/dev/null`. Copy no `auth.json` and no Codex usage cache.
2. Write every SQLite input as a fresh file with `VACUUM INTO` (no `-wal`/`-shm` sidecars exist next to a new file): real `rollup.db` → `$S/rollup.db`; real `opencode.db` → `$S/opencode.db`; `~/.codex/state_5.sqlite` → `$S/.codex/state_5.sqlite`.
3. Point the snapshot's Codex rows at the snapshot: `sqlite3 "$S/.codex/state_5.sqlite" "UPDATE threads SET rollout_path = replace(rollout_path, '<real home>/.codex/', '$S/.codex/')"`. Without it the engine reads live rollouts by absolute path.
4. Build each root as in the recipe above, but symlink `.claude`/`.codex` into `$S`, copy `$S/config/cc-dashboard` instead of the real one, copy no cache files, `cp "$S/rollup.db" "$R/rollup.db"`, and set `COCKPIT_OPENCODE_DB="$S/opencode.db"`.
5. Cut the network in both runs: `TOKEN_ATLAS_OPENROUTER_URL`, `TOKEN_ATLAS_CODEX_USAGE_URL`, `TOKEN_ATLAS_CODEX_TOKEN_URL` all `http://127.0.0.1:9/` (connection refused, instantly). Give both runs the same `TOKEN_ATLAS_NOW_MS`.
6. Before comparing, delete `pricingMeta.openRouter.error` and `codexUsageLimits` in addition to the golden volatile keys: both carry runtime-specific error text here. The fixture golden suite and the Codex usage-limit check already cover them.

## Decisions frozen during interview

- **Scope: all three processes** — server + engine, statusline collector, rollup-update, plus push-usage (the collector nudges it).
- **Subcommands of the existing `cockpit` binary**: `cockpit atlas serve [--port N] [--no-open]`, `atlas stats`, `atlas live`, `atlas rollup-update [--rebuild] [--db <path>]`, `atlas statusline`, `atlas push-usage`. Same shim (`skills/cockpit/bin/cockpit`), same release assets, same version.
- **Separate process on port 5938**, never merged into the cockpit daemon.
- **Parity proof** = bun black-box contract suite + golden diff (TS vs Rust `/api/stats` JSON deep-equal minus a frozen volatile-key list; `rollup.db` row-for-row). Recorded against TS first; the suite stays permanently; TS unit tests are deleted with their modules.
- **HTTPS via reqwest + rustls** with bundled webpki roots.
- **No schema change.** `rollup.db` stays v3. Rust refuses an unknown or newer version exactly like TS.
- **One-time backup**: the first Rust open of a `rollup.db` whose `meta` lacks `writer = rust` runs `VACUUM INTO '<db>.pre-rust.bak'` (skip when that file already exists), then inserts `writer = rust`.
- **Statusline migration**: `setup.ts --session-check` rewrites an *existing* `bun …statusline-collector.ts` statusline command to the shim's `atlas statusline`. It still never fresh-wires.
- **Delete the TS** once the Rust suite is green, like cockpit.
- **Targets** (macOS arm64, `ps -o rss=`): `atlas serve` ≤ 40 MB after one `/api/stats` build with the dashboard open; `/api/stats` cold build ≤ TS on the same home; `atlas statusline` own overhead ≤ 10 ms. Misses are reported, never hidden.
- **Max parallel 3** — each worktree runs its own `cargo build`.
- **Human-only checks**: real-home golden diff over a DB copy, dashboard visual pass, live statusline after migration, Codex usage limits against real `auth.json`.
