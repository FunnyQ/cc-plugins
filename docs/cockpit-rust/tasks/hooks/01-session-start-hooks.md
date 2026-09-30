# HOOKS-01: Session-start hook

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/03, contract/04
> **Blocks**: hooks/02
> **Status**: todo

## Goal

`cockpit hook session-start` reproduces `decision-log-start.ts` byte for byte: the delegation checks, the Claude-with-`claude`-on-PATH silence, and the guidance line. This makes the `hook: session-start` contract group pass against Rust in well under 5 s with no network access.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/hook.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group only; green against TS first.
- `packages/monitor/cockpit-rs/src/hook/mod.rs` (new) — `HookInput`, stdin parsing, and the `hook` subcommand dispatch (`session-start`, `stop`).
- `packages/monitor/cockpit-rs/src/hook/reminder.rs` (new) — port of `decision-log-reminder.ts`: `should_skip`, `is_claude_code`, `resolve_parent_session`. The Stop hook reuses all three.
- `packages/monitor/cockpit-rs/src/hook/delegation_marker.rs` (new) — port of the marker reader: the pure `classify_markers` plus I/O.
- `packages/monitor/cockpit-rs/src/hook/session_start.rs` (new) — `build_guidance` and the entry point.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — route `hook session-start`, and route `hook stop` to a stub that exits 0 silently.

Reuse the crate's shared `find_session::find_session(provider: Provider, project: &Path) -> Option<String>`. It writes its diagnostics to stderr, as the TS does. The core bucket owns `src/find_session.rs`: import it, never create, copy, or extend it.

## Implementation notes

### Input

```rust
#[derive(Deserialize, Default)]
pub struct HookInput {
    pub agent_id: Option<String>,
    pub hook_event_name: Option<String>,
    pub stop_hook_active: Option<bool>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub provider: Option<String>, // "opencode" only, stamped by opencode/plugin.ts
}
```

session-start: a missing stdin or invalid JSON becomes `HookInput::default()` and the hook still runs. (The Stop hook does the opposite and returns silently. Keep the parse helper returning `Option` so each caller picks.)

### `should_skip(env, input, now_ms) -> bool` (port of `shouldSkipDecisionLogReminder`)

1. Return true if any of these hold:
   - `RELAY_DELEGATED == "1"`
   - `CLAUDE_CODE_ENTRYPOINT` starts with `sdk`
   - `hook_event_name == "Stop"` and `stop_hook_active == Some(true)`
   - `agent_id` is a non-empty string
2. If `PLUGIN_ROOT` is unset or empty, return false. The marker store is Codex-only.
3. Otherwise return `is_delegated_session(env, input.cwd, input.session_id, now_ms)`. Any error inside that path yields false.

### Delegation marker (port of `delegation-marker.ts`)

- The directory is `Q_DELEGATION_HOME` when set, else `~/.local/share/q-lab/delegation`.
- The shape is shared with relay; it is a path and a shape, never code:

```json
{ "cwd": "/abs", "backend": "codex", "startedAt": 0, "armUntil": 0, "expiresAt": 0, "sessionIds": [] }
```

- Read every `*.json` in the directory. Skip a file that is unreadable, or whose `cwd` is not a string, `expiresAt` or `armUntil` is not a number, or `sessionIds` is not an array. A missing directory means no markers.
- Pure core (with a `cargo test` per branch):

```rust
pub struct Classification { pub delegated: bool, pub bind_to: Option<String>, pub expired: Vec<String> }
pub fn classify_markers(files: &[(String, Marker)], cwd: Option<&str>, session_id: Option<&str>, now_ms: i64) -> Classification;
```

  1. Split the files into expired (`expiresAt <= now`) and live.
  2. If `session_id` is `Some` and any live marker's `sessionIds` contains it, return `delegated: true` with no binding.
  3. If `cwd` is `None`, return `delegated: false`.
  4. Armed markers are the live ones with `cwd == input cwd` and `now <= armUntil`. If there are none, return `delegated: false`.
  5. Otherwise `delegated: true`. The target is the first armed marker with empty `sessionIds`, else the first armed marker. `bind_to` is that target's name only when `session_id` is `Some`.
- I/O after classifying:
  - Delete every expired file, ignoring errors.
  - When `bind_to` is set, push the session id onto that marker's `sessionIds` and rewrite the file as compact JSON (`JSON.stringify`, no indent), ignoring errors.
  - Keep the unknown fields that are written back (`backend`, `startedAt`) in their original order: `cwd, backend, startedAt, armUntil, expiresAt, sessionIds`.

### `is_claude_code(env, input) -> bool`

True iff `PLUGIN_ROOT` is unset and `input.provider != Some("opencode")`.

### `resolve_parent_session(env, input) -> Option<String>`

1. If `provider == "opencode"`, return `session_id`, where an empty string counts as `None`.
2. Otherwise the provider is `codex` when `PLUGIN_ROOT` is set, else `claude`.
3. Return `find_session(provider, cwd or process cwd)`, falling back to `session_id`, then `None`.

### Entry point (port of `decision-log-start.ts main`)

1. Parse stdin (default on failure).
2. If `should_skip`, exit 0 with no output.
3. If `is_claude_code` and `claude` is found on `PATH`, exit 0 with no output. Implement the PATH search as `Bun.which` does: the first `PATH` entry holding an executable regular file named `claude`. The Stop hook launches the scribe itself in this case.
4. Otherwise write `build_guidance(resolve_parent_session(..), PLUGIN_ROOT is set)` followed by `\n` to stdout, and exit 0.
5. Any internal error exits 0 silently, never non-zero. The TS wraps `main` in `.catch(() => {})`.

### `build_guidance(session_id: Option<&str>, is_codex: bool) -> String` (text verbatim)

```text
WHEN    = "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: "
POLICY  = " One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine."
FORK_NAME = " Use \"fork\" exactly (omitting it starts a fresh, context-less agent that cannot see the work)."
SILENCE = " Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output."
```

- `spawn(scribe)` builds the spawn line:
  - Codex: `a background sub-agent with fork_context: true and no agent_type, prompt: "You are running under Codex. Run <scribe> --provider codex"`
  - Otherwise: `Agent(subagent_type: "fork", prompt: "Run <scribe>")`
- `how` = `POLICY + SILENCE` for Codex, else `POLICY + FORK_NAME + SILENCE`.
- With an id: `WHEN + spawn("/cockpit scribe --session <id>") + "." + how`.
- Without an id: `WHEN + spawn("/cockpit scribe --session <parent-session-id>") + ", substituting this main session's id, which you resolve first." + how`.

Unit-test all four combinations against these exact strings.

### Performance

Spawn no subprocess. `find_session` for Codex reads sqlite locally. Make no HTTP calls and do not contact the daemon. Target < 100 ms on a warm cache.

## Acceptance criteria

- [ ] Against Rust, `hook: session-start` passes: Claude-with-`claude`-on-PATH silence, guidance text for Claude without `claude` on PATH, the Codex (`PLUGIN_ROOT`) variant, the OpenCode (`provider: "opencode"`) variant, and the skips for `RELAY_DELEGATED=1`, the `sdk` entrypoint, and `agent_id`.
- [ ] A Codex run whose cwd matches an armed marker prints nothing, and its `session_id` is appended to that marker file. A later run with the same `session_id` after `armUntil` is still silenced.
- [ ] Without `PLUGIN_ROOT`, a matching marker is ignored and the guidance still prints.
- [ ] With every suppression cleared (no `RELAY_DELEGATED`, no `sdk` entrypoint, no `claude` on `PATH`, no matching marker), garbage or empty stdin still produces guidance (default input). Under each env/PATH suppression (`RELAY_DELEGATED=1`, an `sdk` entrypoint, `claude` on `PATH` under Claude Code), the same malformed stdin gives empty stdout. `agent_id` and matching-marker suppression need fields a malformed payload cannot carry, so they are tested only with valid JSON payloads. The process exits 0 in every case.
- [ ] `cargo test` covers every `classify_markers` branch, and `build_guidance` for Codex/Claude × with/without an id.
- [ ] `time cockpit hook session-start` on a fixture input finishes under 1 s.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/hook.contract.test.ts -t "hook: session-start"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/hook.contract.test.ts -t "hook: session-start"` (against TS) still passes.

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Guidance text differs, or a delegated or subagent session is not silenced | Main paths match, but the marker binding, the PLUGIN_ROOT gate, or the `claude`-on-PATH silence drifts | Contract group green against Rust and TS; the marker two-phase match is exact |
| Test coverage | ×2 | No cargo tests | Guidance strings only | Every `classify_markers` branch and all guidance variants are unit-tested |
| Interface & readability | ×1 | Marker logic inlined in the entry point; `unwrap` on marker JSON | Works, but skip logic is duplicated where the Stop hook will need it | `reminder.rs` exposes `should_skip`, `is_claude_code`, and `resolve_parent_session` for reuse; the classifier is pure |
| Assumptions & docs | ×1 | The marker shape is changed silently | The shared-with-relay contract is not noted | A one-line comment names relay's writer as the other side of the marker contract |

## Out of scope

- The Stop hook's nudge logic — Deferred to a follow-up task in the same bucket.
- Changing `plugin.json`, Codex `hooks.json`, or `opencode/plugin.ts` to call the binary — Deferred. Reason: the wiring step switches every caller at once.
- Writing delegation markers — Deferred. Reason: relay owns the writer.
