# CORE-03: Shared find-session and nudge-toggle

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/02
> **Blocks**: channel/02, cli/01, hooks/01, server/01
> **Status**: todo

## Goal

The two Rust modules that the channel, the CLI, and both hooks share — session lookup for all three providers (`find_session.rs`) and three-scope scribe-nudge resolution (`nudge_toggle.rs`) — exist once, with the exact TS semantics and unit tests. Their consumers import them and never re-create or extend them.

## Files to create / modify

- `packages/monitor/cockpit-rs/src/find_session.rs` (new) — port of `packages/monitor/skills/cockpit/scripts/find-session.ts` resolution for claude, codex, and opencode.
- `packages/monitor/cockpit-rs/src/nudge_toggle.rs` (new) — port of `packages/monitor/skills/cockpit/scripts/nudge-toggle.ts`: scope resolution, the session toggle file, and the project/user config scopes.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — declare `mod find_session;` and `mod nudge_toggle;` only. No subcommand wiring here.
- `packages/monitor/cockpit-rs/Cargo.toml` + `Cargo.lock` (modify) — add `rusqlite` with feature `bundled` (Codex and OpenCode lookups are SQLite reads). This module is the first user; the server reuses it.

## Implementation notes

Use the crate's existing modules: `paths.rs` for the cockpit home, Claude projects dir, Codex state DB, and OpenCode DB paths; `config.rs` for `config.json` read/write; `log_root.rs` or its git-root helper for the project key. Do not re-resolve any path by hand.

### `find_session.rs`

```rust
pub enum Provider { Claude, Codex, Opencode }
impl std::str::FromStr for Provider { /* "claude" | "codex" | "opencode" */ }

/// Returns the session id, or None. On None, the diagnostic line has already
/// been printed to stderr, exactly as TS prints it.
pub fn find_session(provider: Provider, project: &Path) -> Option<String>;
```

Every consumer calls this one function. The channel calls `find_session(Provider::Claude, project)`, and the CLI subcommand and the hooks call it with their own provider.

- **claude**:
  1. A trimmed `CLAUDE_CODE_SESSION_ID` matching `^[0-9a-f-]{36}$` wins.
  2. Otherwise the dir is `<claude projects dir>/<project with every '/' and '.' replaced by '-'>`.
  3. If the dir is missing, print to stderr `find-session: no transcript dir for <project>\n  (looked in <dir>)`.
  4. Otherwise return the file stem of the newest `*.jsonl` by mtime.
  5. If the dir holds no `*.jsonl`, print to stderr `find-session: no .jsonl transcripts in <dir>`.
- **codex**:
  - The DB path is `COCKPIT_CODEX_STATE_DB`, else `$COCKPIT_CODEX_DIR/state_5.sqlite`, else `~/.codex/state_5.sqlite`. If the file is missing, print `find-session: no Codex state database at <path>`.
  - Otherwise open the DB read-only and run the query below. Include the bracketed clause only when `sqlite_master` has a table named `thread_spawn_edges`.

    ```sql
    select id from threads
    where cwd = ?1 and archived = 0 and rollout_path != ''
      [and not exists (select 1 from thread_spawn_edges e where e.child_thread_id = threads.id)]
    order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
    limit 1
    ```

  - If the query returns no row, print `find-session: no Codex thread for <project>`.
  - On a DB error, print `find-session: could not read Codex state (<msg>)`.
- **opencode**:
  - A trimmed `OPENCODE_SESSION_ID`, else a trimmed `OPENCODE_SESSION`, wins.
  - Otherwise the DB is `COCKPIT_OPENCODE_DB`, else `$OPENCODE_DATA_DIR/opencode.db`, else `~/.local/share/opencode/opencode.db`. If the file is missing, print `find-session: no OpenCode database at <path>`.
  - Query: `select id from session where directory = ?1 and time_archived is null order by time_updated desc limit 1`.
  - If the query returns no row, print `find-session: no OpenCode session for <project>`.
  - On a DB error, print `find-session: could not read OpenCode database (<msg>)`.

### `nudge_toggle.rs`

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NudgeState { On, Off }
pub enum NudgeScope { Session, Project, User }
pub enum ToggleAction { On, Off, Toggle, Clear }

pub fn resolve_nudge_enabled(session: Option<NudgeState>, project: Option<NudgeState>, user: Option<NudgeState>) -> bool; // first Some wins; none → true; only Off disables
pub fn apply_action(action: ToggleAction, current: Option<NudgeState>) -> Option<NudgeState>; // toggle: Off → On, anything else → Off; clear → None
pub fn project_key(cwd: &Path) -> PathBuf;  // git root of cwd, else cwd
pub fn read_scopes(session_id: Option<&str>, cwd: &Path, now_ms: i64) -> (Option<NudgeState>, Option<NudgeState>, Option<NudgeState>);
pub fn nudge_enabled_for(session_id: Option<&str>, cwd: &Path, now_ms: i64) -> bool;
pub fn set_scope(scope: NudgeScope, action: ToggleAction, session_id: &str, cwd: &Path, now_ms: i64) -> Option<NudgeState>;
```

- **Session scope** lives in `$COCKPIT_HOME/scribe-nudge-toggle.json`.
  - Shape: `{ "<sessionId>": { "state": "on"|"off", "ts": <ms> } }`.
  - On read, drop invalid entries, and drop entries whose age (`now_ms - ts`) is 7 days or more.
  - Write compact JSON: no indent, no trailing newline. Run `mkdir -p` on the parent first. Swallow write errors.
- **Project scope** is `config.nudges.projects[project_key(cwd)]`, read and written through the config module.
  - Clearing removes the key, and a `projects` map left empty is removed.
- **User scope** is `config.nudges.user`.
- Config values other than `on` / `off` count as absent.

### Tests

Mirror every case in `packages/monitor/skills/cockpit/scripts/find-session.test.ts` and `packages/monitor/skills/cockpit/scripts/nudge-toggle.test.ts` as `#[cfg(test)]` units. Build fixtures in `tempfile` dirs and point the env overrides at them. Build the Codex and OpenCode fixture DBs with rusqlite. The Codex fixtures must cover one DB with the `thread_spawn_edges` table and one without it.

## Acceptance criteria

- [ ] `find_session` returns the same id as TS for each provider on the fixtures from `find-session.test.ts`, including the env-var short-circuits.
- [ ] Every not-found and DB-error path prints the exact TS stderr line and returns `None`.
- [ ] The Codex query adds the `thread_spawn_edges` clause only when that table exists.
- [ ] `resolve_nudge_enabled`, `apply_action`, and `read_scopes` match every case in `nudge-toggle.test.ts`, including the 7-day expiry and dropping invalid entries.
- [ ] `set_scope` writes `scribe-nudge-toggle.json` as compact JSON with no trailing newline. Clearing the project scope removes the key, and removes an emptied `projects` map.
- [ ] No other Rust file re-implements the per-provider transcript/DB lookup or nudge-scope persistence. Orchestration that calls these modules (the channel's env → ancestor session file → ancestor argv → `find_session` chain, the hook's parent-session resolution) may live in its own module.
- [ ] fmt and clippy (`-D warnings`) are clean.

## Verification

- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml find_session`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml nudge_toggle`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`

## Eval rubric

> Scale 0–5 per `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A provider returns the wrong session, or scope precedence is wrong | Happy paths right, but a stderr line, the edges-table check, the 7-day expiry, or the compact-JSON write drifts | Every provider path, diagnostic, and scope rule matches TS byte for byte |
| Test coverage | ×2 | No tests | Claude and user scope only | Every case from both named TS test files mirrored, incl. DB errors and the missing-table variant |
| Interface & readability | ×1 | Paths re-resolved locally, or `unwrap` on DB or JSON reads | Works, but the signatures differ from those above | Exactly the signatures above; I/O kept apart from the pure resolution functions |
| Assumptions & docs | ×1 | Silent divergence from TS | Divergences exist but uncommented | Any deliberate difference carries a one-line comment |

## Out of scope

- The `cockpit find-session` and `cockpit nudge` subcommands' argv parsing and output. Deferred: the CLI port calls these modules.
- The channel's session-id chain (env var, session file, ancestor argv). Deferred: the channel port owns the chain and calls `find_session` as its last step.
