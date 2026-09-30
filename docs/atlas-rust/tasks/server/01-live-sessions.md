# SERVER-01: Live sessions module and the live subcommand

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/engine-api.md`
>
> **Depends on**: engine/01, contract/04
> **Blocks**: server/02
> **Status**: todo

## Goal

`packages/monitor/cockpit-rs/src/atlas/live.rs` reproduces `live.ts` + `live-sessions.ts` exactly: `live_sessions(ctx)`, `cockpit_daemon_port()`, and `cockpit atlas live`, proven equal to the TS output on the fixture home.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/atlas/live.rs` (modify — replace the scaffold stub) — the whole port plus `#[cfg(test)] mod tests`.
- `packages/monitor/skills/usage-dashboard/contract/live-fixture.ts` (new) — `extendLiveFixture(home: string): Promise<void>`, shared with the later golden recording.
- `packages/monitor/skills/usage-dashboard/contract/live.contract.test.ts` (new) — differential test: TS `live.ts` output vs Rust `atlas live` output.

Nothing else. `session_files.rs` (the `session-files.ts` port, `read_session_files() -> Vec<ClaudeSessionFile>`, with `ClaudeSessionFile` defined in `session_files.rs`), `paths.rs`, `model.rs` (`now_ms()`, `Ctx`), `crate::paths::{cockpit_home, opencode_db}`, and `crate::process_alive::is_alive` already exist; use them, do not edit them.

## Implementation notes

The TS files `packages/monitor/skills/usage-dashboard/scripts/live.ts` and `live-sessions.ts` are the authoritative behavior; read both before writing code. Their tests, `live-sessions.test.ts` (30 `test`/`describe` entries, ~21 cases), are the case list to port.

### Signatures (frozen in engine-api.md)

```rust
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub provider: String,            // "claude" | "codex" | "opencode"
    pub id: String,
    pub project_name: String,
    pub cwd: String,
    pub status: String,              // "busy" | "idle" | "waiting" | "active-inferred" | "recent" | other
    pub status_source: String,       // "claude-session-file" | "codex-sqlite-rollout" | "opencode-sqlite-session"
    pub updated_at: String,          // ISO string, as TS `new Date(ms).toISOString()`
    pub age_ms: i64,
    pub is_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")] pub transcript_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub cockpit: Option<bool>,
}
pub fn live_sessions(ctx: &Ctx) -> Vec<LiveSession>;
pub fn cockpit_daemon_port() -> Option<serde_json::Number>; // any JSON number TS accepts, echoed unchanged
pub fn run_cli(args: &[String]) -> std::process::ExitCode;   // `atlas live`
```

Field order must match the TS object literals in `buildClaudeLiveSessions` / `buildCodexLiveSessions` / `buildOpenCodeLiveSessions`; check which optional fields each builder sets and when (e.g. every builder emits `cockpit` as a boolean — `cockpitKeys.has(...)` — so an unregistered session carries `cockpit: false`, never an omitted field).

### Constants and pure helpers (`live-sessions.ts`)

- `STALE_CUTOFF_MS = 600_000`, `BUSY_CUTOFF_MS = 60_000`.
- `project_name_for(cwd)` — last path segment as TS computes it.
- `status_rank`: `busy`/`active-inferred` → 0, `waiting` → 1, `recent` → 2, `idle` → 3, anything else sinks below.
- `codex_updated_at_ms(row)` = `updated_at_ms || updated_at*1000 || created_at_ms || created_at*1000` with JS falsy semantics (0 and NULL both fall through).
- `parse_cockpit_keys(raw)` — `{sessions: [...]}`; keep entries whose `sessionId` is a string; key `"<provider>:<sessionId>"` where provider is `codex`/`opencode` when it says so, else `claude`; missing/corrupt → empty set.
- Claude builder: status is the session file's own `status`, source `claude-session-file`, `isStale = ageMs > STALE_CUTOFF_MS`, `transcriptPath` from the transcript index by session id. Port its filters exactly.
- Codex builder: `status = ageMs <= BUSY_CUTOFF_MS ? "active-inferred" : "recent"`, source `codex-sqlite-rollout`, drops rows older than the stale cutoff, checks the rollout path exists (TS passes `existsSync`).
- OpenCode builder: same status rule, source `opencode-sqlite-session`, timestamps from `time_created`/`time_updated`.
- `sort_live_sessions`: status rank first, then the TS tiebreak (read it — most recent first).

### I/O (`live.ts`)

- Codex rows: open `~/.codex/state_5.sqlite` read-only (`OpenFlags::SQLITE_OPEN_READ_ONLY`), missing file or any error → empty. Query verbatim:
  ```sql
  select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, model
  from threads
  where archived = 0 and rollout_path != ''
    and coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) >= ?1
  order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
  limit ?2
  ```
  with `?1 = now_ms() - STALE_CUTOFF_MS`, `?2 = 24`.
- OpenCode rows: `crate::paths::opencode_db()`, read-only, `select id, directory, time_created, time_updated from session order by time_updated desc limit 24`; missing/error → empty.
- Claude sessions: `session_files::read_session_files()`.
- The Codex state DB path comes from `atlas::paths` (HOME-derived, as `paths.ts`), never cockpit's `COCKPIT_CODEX_*` helpers.

### Process-level caches

`atlas serve` polls `/api/live` every 3 s, so port the three 5 s TTL caches as process-level `static` state (`std::sync::Mutex<Option<(i64, T)>>` or `OnceLock<Mutex<…>>`), keyed on `now_ms()`:

- Transcript index: one walk of the Claude projects dir (`TOKEN_ATLAS_PROJECTS_DIR` or `~/.claude/projects`) for `**/*.jsonl`, map filename stem → absolute path, first hit wins (TS `if (!index.has(stem))`). Walk order must give the same "first" as Bun's `Glob.scanSync` for the fixture; if they can differ, sort and note it.
- Registry keys: `$COCKPIT_HOME/registry.json` through `parse_cockpit_keys`.
- Daemon port: `$COCKPIT_HOME/daemon.json`; `pid` a number and `is_alive(pid)` → `port` when it is a number, else `5858`; otherwise `None`. Missing/corrupt → `None`. The cached value (including `None`) is reused for 5 s.

Every "now" goes through `model::now_ms()` so `TOKEN_ATLAS_NOW_MS` pins ages and statuses.

### `atlas live`

`run_cli` prints `{"sessions": [...], "cockpitUp": bool, "cockpitPort": number|null}` — `cockpitUp = cockpitPort.is_some()` — pretty-printed with 2-space indent (`serde_json::to_string_pretty`), **no trailing newline**, exit 0. Key order: `sessions`, `cockpitUp`, `cockpitPort`.

### Differential contract test

`live.contract.test.ts`, whole file guarded with `test.skipIf(!isRust())` and a one-line comment: it runs both implementations side by side, so it only means something when `COCKPIT_BIN` is set.

- Build the fixture with `makeFixtureHome(): Promise<{home, env, stub, cleanup}>`; extend the home through one exported helper, `extendLiveFixture(home)` in `contract/live-fixture.ts` (new), so the same extended home can later be recorded as a golden file; it makes every status appear relative to the pinned `TOKEN_ATLAS_NOW_MS`: Claude session files with `busy`, `idle`, `waiting`, and one older than 10 min (stale); Codex `threads` rows at <60 s (active-inferred), 60 s–10 min (recent), >10 min (dropped), one `archived = 1`, one with `rollout_path` pointing to a missing file; OpenCode `session` rows at both ages; a `registry.json` naming one session per provider (→ `cockpit: true`; every other session → `cockpit: false`); a `daemon.json` whose pid is the test runner's (`process.pid`).
- Run `["bun", "packages/monitor/skills/usage-dashboard/scripts/live.ts"]` and `atlasCommand("live")` with the same env; `JSON.parse` both; `expect(rust).toEqual(ts)`. Also assert the Rust stdout does not end with `\n`.

## Acceptance criteria

- [ ] Every `live-sessions.test.ts` case is ported as a cargo test in `live.rs` (builders, `status_rank`, `codex_updated_at_ms` falsy fallbacks, `parse_cockpit_keys` on corrupt/missing input, sort order) and passes.
- [ ] Cargo tests cover the 5 s cache: a daemon.json change inside the TTL is not observed, one after it is (drive time through `TOKEN_ATLAS_NOW_MS` or an injected clock).
- [ ] `cockpit_daemon_port()` returns `Some(port)` unchanged for an alive pid (cargo tests include `70000` and `5999.5`, echoed as-is like the TS), `Some(5858)` when `port` is not a number, `None` for a dead pid, missing file, or corrupt JSON.
- [ ] `live.contract.test.ts` exists, is skipped without `COCKPIT_BIN`, and with it the Rust `atlas live` output deep-equals TS `live.ts` output on the extended fixture, covering every status value and the `cockpit: true` tag.
- [ ] The `atlas live` test in `cli.contract.test.ts` passes against Rust.
- [ ] `live.rs` never reads transcript contents and never uses cockpit's `COCKPIT_CODEX_*` / `COCKPIT_CLAUDE_*` path helpers.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml atlas::live`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check` and `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/live.contract.test.ts`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/usage-dashboard/contract/cli.contract.test.ts -t "live"`
- [ ] `bun test packages/monitor/skills/usage-dashboard/contract/live.contract.test.ts` (no `COCKPIT_BIN`) reports the test as skipped, not failed.
- [ ] `bunx --bun tsc --noEmit | grep usage-dashboard/contract/live` prints nothing.

## Eval rubric

> Scale 0–5 (see ../_context/rubric.md). Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Differential test fails, or a status/sort/field differs from TS | Differential test passes on the happy fixture, but an edge drifts: falsy-zero timestamp fallback, `cockpit` omitted instead of `false` for an unregistered session, 5858 fallback, trailing newline, cache not honoring the TTL | Rust output deep-equals TS across every status, provider, and registry tag; `cockpitPort` rules and output bytes match exactly |
| Test coverage | ×2 | No cargo tests or no differential test | Some `live-sessions.test.ts` cases ported; cache and daemon-port failure paths untested | All TS cases ported; cache TTL, dead pid, corrupt registry/daemon.json, missing DBs, archived and missing-rollout rows all exercised |
| Interface & readability | ×1 | `unwrap` on file/DB reads; signatures differ from engine-api.md | Works but builders and I/O tangled, or caches duplicated ad hoc | Pure builders separate from I/O as in TS; one small cache pattern reused for the three caches; clippy clean |
| Assumptions & docs | ×1 | Deviations from TS unexplained | Walk-order or ISO-format choices made silently | Any deliberate difference (e.g. walk sort for stable "first stem") has a one-line why comment |

## Out of scope

- The `/api/live` HTTP route and its headers — Deferred. Reason: the `atlas serve` shell wires the route to `live_sessions` / `cockpit_daemon_port`.
- A Codex app-server status source (`codex-app-server` appears in the TS type but no builder emits it) — Deferred. Reason: port what the TS does, which is SQLite-only.
