# CORE-02: Registry, log root, daemon lifecycle

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Blocks**: core/03, server/01
> **Status**: done
> **Models**: dev=opus/high

## Goal

The shared state modules every cockpit process reads — `registry.json`, the decision-trail log root, `daemon.json` with its startup and version-supersede rules, process liveness, and the open-call scan — exist in Rust with the exact TS semantics and unit tests.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/registry.rs` (new) — registry read/write/upsert/heartbeat, status
- `packages/monitor/cockpit-rs/src/log_root.rs` (new) — log root walk-up, known-project resolution
- `packages/monitor/cockpit-rs/src/daemon_info.rs` (new) — `daemon.json` read/write, startup decision, version supersede
- `packages/monitor/cockpit-rs/src/process_alive.rs` (new) — pid liveness
- `packages/monitor/cockpit-rs/src/call_log.rs` (new) — open-call scan, call matching
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — add the five `mod` lines
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add `libc` (for `kill(pid, 0)`); reuse the existing `tempfile` dev-dependency

The crate already provides `paths::{cockpit_home, registry_path, daemon_info_path}` (env/XDG resolution per `_context/contracts.md` §1). Use them; do not re-resolve.

## Implementation notes

### process_alive.rs (port of `shared/scripts/process-alive.ts`)

```rust
pub fn is_alive(pid: i32) -> bool; // kill(pid, 0): Ok → true; EPERM → true; ESRCH or anything else → false
```

Guard `pid <= 0` → false (kill(0) / kill(-1) target process groups).

### registry.rs (port of `registry.ts` read side + `cockpit.ts` write side)

```rust
// The raw JSON object is the source of truth, so a rewrite keeps every key in its original position.
#[derive(Serialize, Deserialize, Clone)]
#[serde(transparent)] // serializes as the flat entry object, never {"raw": …}
pub struct RegistryEntry { pub raw: Map<String, Value> }
// cargo test: a flat entry read from disk and written back round-trips byte-identically.
impl RegistryEntry {
    pub fn provider(&self) -> Provider;          // "codex" | "opencode" kept, anything else → Claude
    pub fn project(&self) -> &str;
    pub fn session_id(&self) -> &str;            // entries without a string sessionId are dropped on read
    pub fn title(&self) -> Option<&str>;
    pub fn title_resolved(&self) -> bool;
    pub fn log_path(&self) -> &str;
    pub fn last_heartbeat(&self) -> &str;        // ISO-8601 with millis, e.g. 2026-09-30T12:00:00.000Z
    pub fn set(&mut self, key: &str, value: Value); // replaces in place if present, appends if new (TS spread order)
    pub fn new(provider: Provider, project: &str, session_id: &str, log_path: &str, last_heartbeat: &str) -> Self; // key order provider, project, sessionId, logPath, lastHeartbeat
}
pub const STALE_MS: i64 = 10 * 60 * 1000;
pub const REGISTRY_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
pub fn read_registry() -> Vec<RegistryEntry>;
pub fn status_of(e: &RegistryEntry, now_ms: i64) -> SessionStatus; // Active | Ended
pub fn derive_live_status(active: bool, open_call: bool, harness: Option<&str>) -> LiveStatus;
pub fn write_registry(entries: Vec<RegistryEntry>, now_ms: i64);    // reaps then writes
pub fn upsert_session(entry: RegistryEntry);
pub fn refresh_heartbeat(project: &str, session_id: &str, provider: Provider, log_path: &str);
pub fn persist_title_updates(updates: &[TitleUpdate]);             // server-side writer
```

Rules:

- **Read**: missing/corrupt file or no `sessions` array → empty. Drop entries whose `sessionId` is not a string. `provider` normalizes: `"codex"` / `"opencode"` kept, anything else (missing, unknown) → `"claude"`. Deserialize each entry leniently (per-entry `Value` → struct), so one bad entry never empties the registry.
- **status_of**: last signal = max(parsed `lastHeartbeat` or 0 if unparseable, `mtime` of `logPath` in ms or 0 if unstat-able); `now - last < STALE_MS` → Active, else Ended.
- **derive_live_status** priority: not active → `ended`; open call → `your-call`; harness `busy` → `working`, `waiting` → `waiting`, `shell` → `shell`, anything else (incl. none) → `idle`. Serialize the enum as those kebab strings.
- **write_registry** (CLI's single write path): drop entries whose last signal (same max as above) is ≥ `REGISTRY_TTL_MS` old, `create_dir_all(cockpit_home())`, write `{"sessions": [...]}` with 2-space indent and **no trailing newline** (TS: `JSON.stringify(reg, null, 2)` with nothing appended — note this differs from `config.json` and `daemon.json`, which do end in `"\n"`).
- **upsert_session**: read, find by `sessionId` alone (not provider), merge fields over the existing entry (TS `{...old, ...new}` — existing unknown keys survive), else append; then `write_registry`.
- **refresh_heartbeat**: existing entry → set `provider`, `project`, `logPath`, `lastHeartbeat = now`, leave title fields untouched, `write_registry`; missing → `upsert_session` a new entry.
- **persist_title_updates** (server writer): match by provider AND sessionId; set `title` when non-empty and different; set `titleResolved = true`; write only if something changed, with the same no-trailing-newline format but **without** the TTL reap (TS server path does not reap).
- Key order on write: `provider, project, sessionId, title?, titleResolved?, logPath, lastHeartbeat`, then preserved unknown keys — matches how TS objects serialize for entries it created. Existing entries keep their original key order because updates go through `RegistryEntry::set` on the raw map (`serde_json` `preserve_order`). Add a cargo test that reads an entry with non-standard key order plus an unknown key, runs `upsert_session` and `refresh_heartbeat`, and asserts the rewritten JSON keeps that order and key.
- Two writers (CLI, server) race by read-modify-write; keep TS's behavior (no lock). Comment it as a deliberate corner-cut: `// no lock, same as TS; add a lockfile if two writers ever lose an update`.
- The view builders (`buildSessions`/`buildProjects`, which join live sessions, subagents, channel liveness, titles) are **not** in this task; they need server-side modules. Expose the pieces above so the server can assemble them.

### log_root.rs (port of `log-root.ts`)

```rust
pub fn git_root_of(cwd: &Path) -> Option<PathBuf>; // `git -C <cwd> rev-parse --show-toplevel`; non-zero, empty, or spawn error → None
pub fn log_root(cwd: &Path, git_root: impl Fn(&Path) -> Option<PathBuf>) -> PathBuf;
pub fn resolve_known_project(requested: &str, known: &[String]) -> Option<PathBuf>;
pub fn log_path_for(project: &Path, session_id: &str) -> PathBuf; // <project>/.cockpit/logs/<session>.jsonl
```

`log_root` algorithm, exactly:

1. `start` = realpath(cwd), or cwd if realpath fails (git reports realpaths; `/tmp` on macOS is a symlink).
2. `root` = git_root(start); None → return `start` (no walk-up outside a repo).
3. `top` = realpath(root) or root. If `start != top` and `start` is not inside `top` → return `top`.
4. Walk `dir` from `start` upward: if `dir/.cockpit` is a directory → return `dir`; if `dir == top` → return `top`; if parent == dir (hit `/`) → return `top`.

**The walk must never cross the git root.** `~/.cockpit` is a real leftover of the pre-XDG cockpit home; an unbounded walk would adopt it and collapse every repo under `$HOME` into one trail.

`resolve_known_project`: purely lexical (no fs). Empty requested → None. Resolve both to absolute lexically; a candidate matches when it equals the target or the target is inside it; return the longest match. It only resolves downward — an unknown ancestor never unlocks a registered project. "Inside" is `shared/scripts/path-inside.ts`: `relative(root, target)` is non-empty, does not start with `..`, and is not absolute.

`log_path_for`: `<project>/.cockpit/logs/<sessionId>.jsonl` (the CLI's `projectCockpitDir(project)` is `<project>/.cockpit`; confirm in `packages/monitor/skills/cockpit/scripts/cockpit.ts` `logPathFor`/`projectCockpitDir`).

### daemon_info.rs (port of `daemon-lifecycle.ts`, the daemon.json parts of `cockpit-server.ts`, and the version rule of `cockpit-channel.ts`)

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct DaemonInfo { pub pid: i32, pub port: u16, pub token: String, pub root: String }
pub fn read_daemon_info() -> Option<PartialDaemonInfo>; // missing/corrupt → None; fields individually optional
pub fn write_daemon_info(info: &DaemonInfo);            // create_dir_all; 2-space JSON + "\n"; key order pid, port, token, root
#[derive(Deserialize, Default, Clone)]
pub struct PartialDaemonInfo { pub pid: Option<i32>, pub port: Option<u16>, pub token: Option<String>, pub root: Option<String> }
// Carries the raw record like TS's `info as DaemonInfo`; decide_startup returns Reuse/Supersede only when `pid` is Some and alive,
// so callers may rely on `pid` and must treat every other field as possibly absent (a missing root prints as "unknown").
pub enum StartupDecision { Reuse(PartialDaemonInfo), Supersede(PartialDaemonInfo), Start }
pub fn decide_startup(info: Option<&PartialDaemonInfo>, my_root: &str, alive: impl Fn(i32) -> bool) -> StartupDecision;
pub fn version_from_root(root: &str) -> Option<String>;
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering;
pub fn should_supersede_daemon(daemon_root: Option<&str>, my_root: &str) -> bool;
pub fn new_token() -> String; // 16 random bytes, lowercase hex (32 chars) — read /dev/urandom; no rand crate
```

- `decide_startup`: no info, `pid` absent, or not alive → `Start`; alive and `root == my_root` → `Reuse`; alive and root differs or absent → `Supersede`.
- `version_from_root`: regex-equivalent of `/[/\\]monitor[/\\](\d+\.\d+\.\d+)[/\\]/` — the first `monitor/<x.y.z>/` segment, separators `/` or `\`. A repo checkout has none → None. Hand-parse; no regex crate.
- `compare_versions`: split on `.`, numeric compare of the first three parts, missing part = 0.
- `should_supersede_daemon` (the channel's spawn rule): daemon root None or equal to mine → false; either version unparseable → **false** (an unversioned root cannot be ordered, so reuse rather than fight); else mine strictly newer → true. Newest-version-wins is a total order, so two channels on different versions cannot start a respawn war.
- `root` written by Rust is `<plugin root>/skills/cockpit/scripts` — the same string the TS daemon writes — so a mixed TS/Rust fleet compares roots and versions correctly. Build it from `paths::plugin_root()`.

### call_log.rs (port of `call-log.ts`)

```rust
pub fn latest_open_call_id(lines: &[&str]) -> Option<String>;
pub fn call_matches(a: Option<&str>, b: Option<&str>) -> bool; // either None → true, else equal
```

Scan from the end, skipping blank or unparseable lines. `type == "response"`: with a string `call` → add to answered set; without → note a legacy response. First `type == "decision"` with `needs_your_call == true` met: legacy response seen → None; its `id` answered → None; else its `id` (None if not a string). No such decision → None.

### Tests to mirror

Mirror the cases in these TS tests as `#[cfg(test)]` units (read them for the exact fixtures):

- `packages/monitor/skills/cockpit/scripts/registry.test.ts` — read normalization, status, live-status priority
- `packages/monitor/skills/cockpit/scripts/log-root.test.ts` — walk-up, git-root bound, symlinked tmp, not-a-repo, resolve_known_project
- `packages/monitor/skills/cockpit/scripts/daemon-lifecycle.test.ts` — start/reuse/supersede
- `packages/monitor/skills/cockpit/scripts/call-log.test.ts` — open-call scan
- `packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` — the `versionFromRoot` / `compareVersions` / `shouldSupersedeDaemon` cases only
- `packages/monitor/skills/cockpit/scripts/cockpit.test.ts` — the registry TTL reap and heartbeat re-point cases only

Use `tempfile` dirs, a real `git init` for log-root cases (skip gracefully if git is missing), and the env-serialization lock pattern for anything touching `COCKPIT_HOME`.

## Acceptance criteria

- [x] `read_registry` normalizes provider, drops non-string `sessionId` entries, survives a corrupt file and a single malformed entry, and preserves unknown keys through a rewrite.
- [x] `write_registry` reaps entries older than 14 days by max(heartbeat, log mtime) and writes 2-space JSON with no trailing newline; `persist_title_updates` writes only on change and does not reap.
- [x] `status_of` and `derive_live_status` follow the priority and 10-minute rule above.
- [x] `log_root` never returns a directory above the git root, honors the nearest existing `.cockpit/`, returns cwd outside a repo, and normalizes symlinked paths.
- [x] `decide_startup`, `version_from_root`, `compare_versions`, and `should_supersede_daemon` return the documented result for every case in the mirrored TS tests, including unversioned roots → no supersede.
- [x] `write_daemon_info` output is byte-identical to TS for the same values (key order pid, port, token, root; trailing newline); `new_token` is 32 lowercase hex chars.
- [x] `latest_open_call_id` and `call_matches` match every case in `call-log.test.ts`.
- [x] fmt and clippy (`-D warnings`) are clean.

## Verification

- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml log_root` runs at least one test that asserts a `.cockpit` directory above the git root is ignored.

## Eval rubric

> Scale 0–5 per `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | walk-up crosses the git root, or registry rewrite drops entries/keys | main paths right, but trailing-newline, key order, TTL reap, or unversioned-root rule drifts | every rule above matches TS, file bytes identical |
| Test coverage | ×2 | no tests | happy paths only | every case from the six named TS tests mirrored, incl. corrupt files and symlinked tmp |
| Interface & readability | ×1 | modules reach into each other's files or re-resolve paths | usable but TS rule order obscured | one module per TS module, pure functions with injected `alive` / `git_root` |
| Assumptions & docs | ×1 | silent divergence from TS | divergences exist but uncommented | no-lock corner-cut and every deliberate difference carry a one-line comment |

## Out of scope

- `buildSessions` / `buildProjects` views and `/api/sessions` / `/api/projects` — Deferred. Reason: they need live-session, subagent, title, and channel modules owned by the server port.
- Spawning or superseding a daemon process — Deferred. Reason: process control belongs to the server, channel, and restart ports; this task provides the pure decision only.
- Decision-trail record writing (`log`, `scribe`) — Deferred to the CLI port.
