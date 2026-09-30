# HOOKS-02: Stop hook

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: hooks/01, core/03
> **Status**: todo

## Goal

`cockpit hook stop` reproduces `scribe-nudge.ts`, so the `hook: stop` contract group passes against Rust. It covers the throttle, the three-scope opt-out, the git code-signature gate, the headless Claude scribe launch, and the Claude and Codex reminder JSON.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/hook.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group only; green against TS first.
- `packages/monitor/cockpit-rs/src/hook/stop.rs` (new) — the entry point plus the pure `assess_complexity`, `decide_nudge`, `build_reminder`, `build_headless_scribe`, `build_hook_output`.
- `packages/monitor/cockpit-rs/src/hook/mod.rs` (modify) — route `hook stop` to it.
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add `sha1_smol` with the justification comment `# sha1 of the git state: the signature stored in scribe-nudge.json must stay stable across releases`.

Reuse from the crate, without re-implementing any of them:

```rust
// hook/reminder.rs
pub fn should_skip(env: &Env, input: &HookInput, now_ms: i64) -> bool;
pub fn is_claude_code(env: &Env, input: &HookInput) -> bool;
pub fn resolve_parent_session(env: &Env, input: &HookInput) -> Option<String>;
// nudge_toggle.rs
pub fn nudge_enabled_for(session_id: Option<&str>, cwd: &Path, now_ms: i64) -> bool; // session → project(git root of cwd) → user → default on
```

The core bucket owns `nudge_toggle.rs`, which already implements session → project (git root of cwd) → user → default on, with only `off` disabling. Import it and never create, copy, or extend it.

## Implementation notes

### Tunables and paths

- `THROTTLE_MS` = `COCKPIT_NUDGE_THROTTLE_MS` parsed as a number when it is a finite non-zero value, else `480000` (8 min). This mirrors `Number(x) || 8*60_000`: `0` and garbage fall back.
- `MARKER_TTL_MS` = 24 h.
- `STRUCTURAL_FILES` = 3, `STRUCTURAL_LINES` = 80.
- The marker file is `$COCKPIT_HOME/scribe-nudge.json`, shaped `{ "<key>": { "lastNudgeMs": ms, "lastSig": "<hex>" } }`. A missing or corrupt file counts as `{}`.
- On write, drop entries with `now - lastNudgeMs > MARKER_TTL_MS`, `mkdir -p` the cockpit home, and write compact JSON. Swallow errors.

### Pure functions (each with a `cargo test`)

```rust
pub struct Complexity { pub files: u32, pub lines: u64, pub structural: bool }
pub fn assess_complexity(numstat: &str, porcelain: &str) -> Complexity;
pub fn decide_nudge(now: i64, current_sig: &str, last_sig: Option<&str>, last_nudge_ms: Option<i64>, throttle_ms: i64) -> bool;
pub fn build_reminder(c: &Complexity, session_id: Option<&str>, is_codex: bool) -> String;
pub fn build_headless_scribe(claude: &str, skill_dir: &str, resume_id: &str, scribe_session: &str) -> Vec<String>;
pub fn build_hook_output(reminder: &str, is_codex: bool) -> serde_json::Value;
```

- **`assess_complexity`**:
  - Each non-blank trimmed numstat line counts as one file. Split it on whitespace into `added deleted`. A `-` (binary) or an unparseable value counts as 0 lines.
  - Each porcelain line starting with `??` adds one file.
  - `structural` = files ≥ 3 or lines ≥ 80.
- **`decide_nudge`** returns false in each of these cases, and true otherwise:
  - `current_sig` is empty.
  - `current_sig == last_sig`.
  - `last_nudge_ms` is set and `now - last < throttle`.
- **`build_reminder`**, verbatim:
  - `cmd` = `/cockpit scribe --session <id>`, or `/cockpit scribe` with no id.
  - Codex `spawn` = `spawn a background sub-agent (fork_context: true, no agent_type) with the prompt "You are running under Codex. Run <cmd> --provider codex"`.
  - Otherwise `spawn` = `spawn a fork (subagent_type:"fork") to run <cmd>`.
  - Structural text: ``📐 Sizable change (<files> files, ~<lines> lines). If it hid a real decision/learning/caveat, <spawn> — draw it with a Mermaid `--diagram` first (flow / sequence / state / fan-out), prose only for what a picture can't carry.``
  - Otherwise: ``💭 If that change hid a real decision/learning/caveat, <spawn> — prefer a Mermaid `--diagram` if it has any shape, else a terse note. Otherwise skip.``
- **`build_hook_output`**:
  - Codex → `{"systemMessage": reminder}`.
  - Otherwise → `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext": reminder}}`, keys in that order.
- **`build_headless_scribe`** is the one intended change from TS. The TS CLI `bun <skillDir>/scripts/cockpit.ts` no longer exists, so the scribe CLI becomes the shim `<skill_dir>/bin/cockpit`, where `skill_dir` = `<plugin root>/skills/cockpit`. With `cli = <skill_dir>/bin/cockpit` and `refs = <skill_dir>/references`, the prompt is:

  ```text
  Scribe this session's decision log. In one turn, read <refs>/scribe.md and run `<cli> scribe --prep --session <S>`. Then follow scribe.md: the CLI is <cli>, and every call passes --session <S>. Spell each call as `<cli> scribe …`, never through a shell variable. When done, reply with one line.
  ```

  The argv is `[claude, "-p", prompt, "--resume", resume_id, "--fork-session", "--no-session-persistence", "--effort", "low", "--output-format", "json", "--allowedTools", "Bash(<cli> scribe:*)", "Read(/<refs>/**)"]`. `--allowedTools` must stay last because it is variadic. Add a one-line comment naming this change.

### Entry point (port of `scribe-nudge.ts main`)

1. Read stdin. A missing stdin or invalid JSON exits 0 silently. This differs from session-start.
2. If `should_skip(env, input, now)`, exit 0.
3. `cwd` = `input.cwd`, else the process cwd. `key` = `input.session_id`, else `cwd`.
4. Throttle first, before git or config: if `marker[key].lastNudgeMs` exists and `now - it < THROTTLE_MS`, exit 0.
5. If `!nudge_enabled_for(input.session_id, cwd, now)`, exit 0.
6. Compute the code signature:
   1. Run `git -C <cwd> rev-parse HEAD`. A non-zero exit means return with no nudge.
   2. Run `git -C <cwd> diff HEAD --numstat` and `git -C <cwd> status --porcelain`. A non-zero exit counts as `""`.
   3. `sig` = lowercase-hex sha1 of `head + " " + numstat + " " + porcelain`, with the raw stdout strings concatenated byte for byte.
7. If `!decide_nudge(now, sig, prev.lastSig, prev.lastNudgeMs, THROTTLE_MS)`, exit 0.
8. Set `is_codex` = `PLUGIN_ROOT` is set, and `scribe_session` = `resolve_parent_session(env, input)`. Write `marker[key] = {lastNudgeMs: now, lastSig: sig}`.
9. If `is_claude_code` and `input.session_id` and `scribe_session` are both set and `claude` is on `PATH` (same PATH search as the session-start hook), launch the headless scribe and exit 0 with no stdout:
   - Detach it: new session, stdin null.
   - Send stdout and stderr to `/tmp/q-lab/monitor/cockpit/scribe-<now ms>.json` (`mkdir -p`).
   - Set cwd = `cwd` and env = the current env plus `RELAY_DELEGATED=1`.
10. Otherwise write `build_hook_output(build_reminder(assess_complexity(numstat, porcelain), scribe_session, is_codex), is_codex)` as compact JSON with no trailing newline (the TS uses `process.stdout.write(JSON.stringify(..))`), and exit 0.
11. Any internal error exits 0 silently.

Git is the only blocking subprocess. The hook has a 10 s timeout, and a throttled turn must spawn no git at all.

## Acceptance criteria

- [ ] Against Rust, `hook: stop` passes: the reminder JSON shape for Claude (no `claude` on PATH) and for Codex, both the structural and light texts, throttle suppression, the unchanged-signature suppression, the nudge-off scopes, the skips for `RELAY_DELEGATED`, `stop_hook_active`, and `agent_id`, and a non-git cwd producing no output.
- [ ] With a fake `claude` executable first on `PATH`, a Claude-shaped input spawns it detached with the argv above (`--allowedTools` last) and prints nothing. The CLI path in the prompt and in `--allowedTools` is the one deliberate argv difference: the contract case picks its expectation by the launcher's `underTest` — `bun <scripts>/cockpit.ts` for TS, `<skill_dir>/bin/cockpit` for Rust — and asserts every other argv element identically for both.
- [ ] A throttled invocation runs no `git` process (checked in a cargo or contract test by pointing `PATH` at a `git` stub that records calls).
- [ ] `scribe-nudge.json` entries older than 24 h are pruned on write.
- [ ] `cargo test` covers `assess_complexity` (binary `-`, untracked `??`, both thresholds), `decide_nudge` (all four branches), both `build_reminder` variants × with/without id, and `build_hook_output`.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/hook.contract.test.ts -t "hook: stop"`
- [ ] `bun test packages/monitor/skills/cockpit/contract/hook.contract.test.ts -t "hook: stop"` (against TS) still passes.

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong output JSON shape, or it nudges when throttled or opted out | Main paths match, but the signature input, the throttle ordering, or the headless argv drifts | Contract group green against Rust and TS; the headless argv matches with only the documented CLI-path change |
| Test coverage | ×2 | No cargo tests | Reminder strings only | Every pure function's branches, plus a no-git-when-throttled check |
| Interface & readability | ×1 | Skip or nudge-scope logic re-implemented locally | Works, but side effects are mixed into the pure builders | Pure builders separate from I/O; reuses the shared reminder and nudge-toggle functions |
| Assumptions & docs | ×1 | The sha1 crate or the CLI-path change is unexplained | One of the two is explained | Both are justified in one line each; the throttle-first ordering keeps its why comment |

## Out of scope

- Updating `references/scribe.md` to call the shim — Deferred. Reason: the wiring step rewrites every doc caller at once.
- Changing the throttle window, the structural thresholds, or the reminder wording — Deferred. Reason: parity first.
