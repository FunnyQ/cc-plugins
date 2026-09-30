# SERVER-08: Views, sessions, design system

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/01, server/04
> **Blocks**: server/03
> **Status**: todo
> **Models**: dev=opus/high

## Goal

`/api/projects`, `/api/sessions`, `/api/project-info`, and `/api/design-system` answer byte-compatibly with the Bun daemon on the Rust server, including the live-session overlay for all three providers, subagent counts, historical titles, and DESIGN.md token parsing.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/views.rs` (modify — currently an empty stub router and an empty `ViewsState`) — the four routes; declares the child modules below.
- `packages/monitor/cockpit-rs/src/server/views/sessions.rs` (new) — port of the view half of `registry.ts` (`buildSessions`, `buildProjects`) plus `live-sessions.ts`.
- `packages/monitor/cockpit-rs/src/server/views/subagents.rs` (new) — port of `subagents.ts` (active subagent counts).
- `packages/monitor/cockpit-rs/src/server/views/session_title.rs` (new) — port of `session-title.ts` (historical title resolution).
- `packages/monitor/cockpit-rs/src/server/views/design.rs` (new) — port of `design-system.ts` and the token half of `project-info.ts`.

Do not edit `server/mod.rs`, `AppState`, `presence.rs`, `sources.rs`, or `Cargo.toml` — they belong to the server foundation, which already added the YAML crate, `regex`, the date crate, and `serde_json` with `preserve_order`. Use `state.presence` and the provider helpers in `crate::server::sources` (`resolve_claude_transcript_path`, `resolve_codex_rollout_path`, `codex_state_db`, `opencode_db`, `opencode_timestamp_ms`, `read_tail_bytes`).

## Implementation notes

### Module signatures other code reuses

```rust
// views/subagents.rs
pub fn claude_active_subagents(transcript: &Path, now_ms: i64) -> u32;
pub fn codex_active_subagents(db: &Path, parent_thread_id: &str, now_ms: i64) -> u32;

// views/session_title.rs
pub fn resolve_historical_session_title(provider: Provider, session_id: &str) -> Option<String>;
```

Declare both modules `pub(crate)` so other server modules can call them; nothing outside `views` re-implements them.

### Routes

- `/api/sessions` → `{"sessions": [SessionView…]}`; `/api/projects` → `{"projects": [ProjectView…]}`. Any error → `500` `{"error": msg}`.
- `SessionView` key order: `provider, project, sessionId, title, logPath, status, liveStatus, subagents, channel, lastHeartbeat, tracked`. `ProjectView`: `project, name, activeCount, sessionCount, lastHeartbeat`.
- `/api/project-info?project=` → `{claudeMd, agentsMd, tokens}`; unknown project (not resolved onto a registry project by the log-root module's `resolve_known_project`) → `400` `{"error":"unknown project"}`; other error → `500`. Root markdown read only when `realpath(file) == realpath(project)/<name>`. Tokens: port `parseDesignTokens` (frontmatter regex `^---\n([\s\S]*?)\n---`, colour slot heuristics, `defined()` drops empty values, all-empty → `null`).
- `/api/design-system?project=` → `CockpitDesignSystem`; no param → `404` `{"error":"project required"}`; unknown → `404` `{"error":"unknown project"}`; error message containing `not found` → `404`, else `500`. Candidates `DESIGN.md` then `design.md`, symlink-confined. Port `tokenList`/`typographyList`/`componentList` (Option fields skipped when absent) and `extractRules` (`**The … Rule.**` blocks). The TS `extractRules` regex uses a lookahead, which the `regex` crate cannot express: rewrite it as a hand scan and cover it with `cargo test` cases copied from the TS test.
- YAML frontmatter: deserialize into `serde_json::Value` so key order survives.

### Build rules (port `buildSessions` / `buildProjects` exactly)

- Registry read via the core crate's registry module; entries without a string `sessionId` dropped; `provider` other than `codex`/`opencode` → `claude`.
- Live sessions (`live-sessions.ts`): Claude files `$COCKPIT_CLAUDE_SESSIONS_DIR/*.json` needing string `sessionId`, string `cwd`, numeric `startedAt`; `updatedAt ?? startedAt`; skip when older than 10 min; `status` default `idle`; title = trimmed `name`. Codex: `threads` rows `archived = 0 and rollout_path != ''`, excluding spawned children when table `thread_spawn_edges` exists, ordered by `coalesce(updated_at_ms, updated_at*1000) desc limit 24`, busy when touched ≤ 60 s ago. OpenCode: `session` rows `time_archived is null order by time_updated desc limit 24`, timestamps normalised by `opencode_timestamp_ms`.
- A registry entry is kept when live, active (heartbeat or log mtime within 10 min), or its `logPath` exists.
- Title: live title wins and is persisted; else stored title; else `resolve_historical_session_title` (Codex `threads.title`, OpenCode `session.title`, Claude first user message text in `**/<id>.jsonl`, whitespace collapsed). Persist title updates by read-modify-write of `registry.json` through the core registry module (setting `titleResolved: true`), written as `JSON.stringify({sessions}, null, 2)` with **no** trailing newline.
- `liveStatus`: not active → `ended`; open `needs_your_call` in the log (core call-log rule) → `your-call`; harness `busy`→`working`, `waiting`, `shell`, else `idle`.
- `subagents`: 0 when not active or provider `opencode`; Claude counts `agent-*.jsonl` under `<transcript without .jsonl>/subagents/` modified within 10 min whose 64 KiB tail is not done (`sidechainIsDone`); Codex counts `thread_spawn_edges` children not `closed`, touched within 10 min, rollout exists, tail lacks `event_msg`/`task_complete`.
- `channel`: `state.presence.has_channel(sessionId)`.
- Untracked live sessions append with `logPath: ""`, `tracked: false`, `lastHeartbeat` = ISO of `updatedAtMs`.
- Sort: active first, then newer `lastHeartbeat` first (unparseable compares as equal — mirrors a JS `NaN` comparator). Projects group by `project`, `name` = basename, same sort on `activeCount > 0`.

## Acceptance criteria

- [ ] Every `server: views` contract test passes against the Rust binary and still passes against TS.
- [ ] `/api/sessions` and `/api/projects` match the TS payload field-for-field on the contract fixtures, including untracked live sessions, `your-call`, the `channel` flag (true while the test holds an `/api/inbox` poll parked for that session; false after the poll closes and `COCKPIT_CHANNEL_TTL_MS`, shrunk in the test, expires), and title persistence without a trailing newline in `registry.json`.
- [ ] `/api/project-info` and `/api/design-system` return the TS status codes for missing, unknown, and not-found projects, and identical token/rule payloads for the fixture DESIGN.md.
- [ ] Subagent counts are correct for the Claude and Codex fixtures and 0 for OpenCode and ended sessions.
- [ ] Only `views.rs` and files under `src/server/views/` change in `packages/monitor/cockpit-rs/src/`.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: views"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: views"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Payload shapes or key order differ; sessions missing | Happy-path payloads match; title persistence, untracked sessions, subagent counts, or design parsing drift | Sessions, projects, project-info and design-system match TS on every fixture |
| Test coverage | ×2 | Contract group not run against Rust | Group passes; no `cargo test` for pure helpers | Group passes on both; `cargo test` covers live-status mapping, sort, colour heuristics, the hand-scanned `extractRules` |
| Interface & readability | ×1 | Edits outside the views module, or subagent/title logic duplicated elsewhere | Works but subagent/title helpers not reusable | One file per ported TS module; `subagents` and `session_title` exposed with the signatures above |
| Assumptions & docs | ×1 | Silent deviations | Deviations exist without comments | The `extractRules` rewrite and JS `NaN`-sort parity carry a one-line why |

## Out of scope

- The transcript stream and history routes — Deferred to a later task in this bucket; they do not use these modules.
- Adding crates — the server foundation already added every crate this needs.
