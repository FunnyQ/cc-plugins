# CORE-01: Crate scaffold, paths, config

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: core/02, channel/01, ship/01
> **Status**: todo

## Goal

A buildable `cockpit` Rust crate exists at `packages/monitor/cockpit-rs/` with every subcommand stubbed behind clap, and with the path, config, and tunable resolution every later port shares, byte-compatible with the TS modules they replace.

## Files to create / modify

- `packages/monitor/cockpit-rs/Cargo.toml` (new) — package `cockpit`, binary `cockpit`, deps, release profile
- `packages/monitor/cockpit-rs/Cargo.lock` (new) — committed lockfile
- `packages/monitor/cockpit-rs/src/main.rs` (new) — clap dispatch, stubs, `--version`
- `packages/monitor/cockpit-rs/src/paths.rs` (new) — cockpit home, Claude/Codex/OpenCode paths, config path, plugin root
- `packages/monitor/cockpit-rs/src/config.rs` (new) — `config.json` read/write
- `packages/monitor/cockpit-rs/src/tunables.rs` (new) — `env_int` and the long-poll budgets
- `.gitignore` (modify) — add `packages/monitor/cockpit-rs/target/`

## Implementation notes

### Cargo.toml

- `[package] name = "cockpit"`, `edition = "2024"`, `version` = the `"version"` in `packages/monitor/.claude-plugin/plugin.json` (currently `5.2.3`; read the file, do not trust this number). The release config later bumps both together.
- `[[bin]] name = "cockpit"`, `path = "src/main.rs"`.
- Declare only what this task uses: `clap` (derive), `serde` (derive), `serde_json` (feature `preserve_order`), `tokio` (feature `rt` — current_thread only; no `macros`, since `main` is never `#[tokio::main]`), and `tempfile` under `[dev-dependencies]` for the tests below. Later ports add their own crates. Pin exact minor versions; check each API with context7 (`bunx ctx7 library clap "derive subcommands"` then `bunx ctx7 docs <id> "<question>"`).
- Release profile:
  ```toml
  [profile.release]
  opt-level = 3
  lto = "fat"
  codegen-units = 1
  strip = "symbols"
  panic = "abort"
  ```

### main.rs

- A plain synchronous `fn main` — never `#[tokio::main]`. Each subcommand module exposes a synchronous `pub fn run(args) -> ExitCode`; one that needs async builds its own current_thread runtime inside `run`, so runtimes never nest.
- Subcommands: `server`, `channel`, `log`, `scribe`, `prep`, `config`, `wait`, `send`, `restart`, `nudge`, `find-session`, and `hook` with nested `session-start` / `stop`.
- Each subcommand must accept arbitrary trailing args for now (`#[arg(trailing_var_arg = true, allow_hyphen_values = true)] args: Vec<String>`), so later ports can take over parsing without clap rejecting TS-compatible argv.
- Every subcommand is a stub: print `cockpit: <sub> not implemented yet` to stderr and exit `2`. For `hook`, `<sub>` is `hook session-start` / `hook stop`.
- `cockpit --version` prints `cockpit <version>` from `env!("CARGO_PKG_VERSION")` and exits 0 (clap's default `--version` format is exactly this).
- Declare `mod paths; mod config; mod tunables;`. Mark currently-unused items `#[allow(dead_code)]` at module level with a one-line why ("consumed by later subcommand ports") so clippy `-D warnings` stays clean.

### paths.rs — port these exactly

```rust
pub fn cockpit_home() -> PathBuf;            // cockpit-home.ts cockpitHome()
pub fn daemon_info_path() -> PathBuf;        // cockpit_home()/daemon.json
pub fn registry_path() -> PathBuf;           // cockpit_home()/registry.json
pub fn config_path() -> PathBuf;             // config.ts configPath()
pub fn claude_projects_dir() -> PathBuf;     // claude-paths.ts
pub fn claude_sessions_dir() -> PathBuf;     // claude-paths.ts
pub fn codex_dir() -> PathBuf;               // codex-db.ts codexDir()
pub fn codex_state_db() -> PathBuf;          // codex-db.ts codexStateDb()
pub fn resolve_codex_path(p: &str) -> PathBuf; // absolute as-is, else codex_dir().join(p)
pub fn opencode_db() -> PathBuf;             // shared/scripts/opencode.ts openCodeDb()
pub fn plugin_root() -> Result<PathBuf, String>;
```

Rules (TS is authoritative; these are its behavior):

- `cockpit_home`: `COCKPIT_HOME` non-empty → it, **no migration**. Else `$XDG_DATA_HOME/q-lab/cockpit` (`XDG_DATA_HOME` empty/unset → `~/.local/share`), and before returning, once per process: if that dir does not exist and `~/.cockpit` exists, `create_dir_all(parent)` then `rename(~/.cockpit, new)`; ignore every error.
- `config_path`: `$XDG_CONFIG_HOME/q-lab/cockpit/config.json`, fallback `~/.config`. It does NOT follow `COCKPIT_HOME`.
- `claude_projects_dir`: `COCKPIT_CLAUDE_PROJECTS_DIR` or `~/.claude/projects`. `claude_sessions_dir`: `COCKPIT_CLAUDE_SESSIONS_DIR` or `~/.claude/sessions`.
- `codex_dir`: `COCKPIT_CODEX_DIR` or `~/.codex`. `codex_state_db`: `COCKPIT_CODEX_STATE_DB` or `codex_dir()/state_5.sqlite`.
- `opencode_db`: `COCKPIT_OPENCODE_DB`, else `(OPENCODE_DATA_DIR or ~/.local/share/opencode)/opencode.db`.
- Empty-string env values count as unset (TS uses `||`).
- Home dir: `$HOME` via `std::env::home_dir()`.
- `plugin_root`: `COCKPIT_PLUGIN_ROOT` set → that path. Else walk up from `std::env::current_exe()` (canonicalized) to the first ancestor containing `.claude-plugin/plugin.json`. None → `Err("cockpit: cannot locate plugin root; set COCKPIT_PLUGIN_ROOT")`; the caller prints it and exits 2.
- `COCKPIT_CODEX_SESSIONS_DIR` belongs to the transcript port; do not add it here.

### config.rs — port config.ts

TS reads the file as a raw object and checks each field's type only where it is used, so one wrong-typed field never hides the others and a rewrite keeps every key as it was. Port that shape, not a typed struct:

```rust
pub type CockpitConfig = serde_json::Map<String, serde_json::Value>;
pub fn read_config() -> CockpitConfig;   // missing / non-object / invalid JSON → empty map
// Each accessor inspects only its own key; a wrong type there means "absent" for that key alone.
// Each setter reads the current map, replaces one key, and writes the whole map back (other keys untouched, even wrong-typed ones).
pub fn get_language() -> String;         // non-string or blank-after-trim → "English", else trimmed
pub fn set_language(lang: &str);
pub fn get_answer_here() -> bool;        // true only for literal `true`
pub fn set_answer_here(on: bool);
pub fn get_user_nudge() -> Option<NudgeState>;
pub fn set_user_nudge(s: Option<NudgeState>);       // None deletes `nudges.user`
pub fn get_project_nudge(project: &str) -> Option<NudgeState>;
pub fn set_project_nudge(project: &str, s: Option<NudgeState>); // None deletes; empty `projects` map is removed
```

- `NudgeState` is `on|off`; any other stored value reads as `None` — so deserialize `nudges` values leniently (store `Value`, convert on read), never fail the whole file.
- Write: `create_dir_all(parent)`, then `serde_json::to_string_pretty` + `"\n"` (TS: `JSON.stringify(cfg, null, 2) + "\n"`). Keys must come out in the order TS writes them: TS spreads the existing object and then sets the key, so an existing key keeps its position and a new key is appended. Use `serde_json` with the `preserve_order` feature and operate on a `serde_json::Map` read from disk to get this for free; the typed struct above is for reads.

### tunables.rs — port tunables.ts

```rust
pub fn env_int(name: &str, fallback: u64) -> u64; // parseInt semantics: leading-integer parse; >0 → value, else fallback
pub fn wait_timeout_ms() -> u64;  // COCKPIT_WAIT_TIMEOUT_MS, 240_000
pub fn stash_ttl_ms() -> u64;     // COCKPIT_STASH_TTL_MS, 60_000
```

`parseInt("250abc")` is `250` and `parseInt("abc")` is NaN: parse the leading optional sign + digits, ignore the rest. `"0"`, `"-5"`, `""`, unset → fallback.

### Tests to mirror

Mirror the cases in `packages/monitor/skills/cockpit/scripts/cockpit-home.test.ts` and `config.test.ts` as `#[cfg(test)]` units. Env-mutating tests must be serialized (a module-level `static LOCK: Mutex<()>`) because `cargo test` runs tests in parallel threads and env is process-global; point `HOME`/`XDG_*` at `tempfile` dirs.

## Acceptance criteria

- [ ] A cargo test with `{"log_language":123,"answer_here":true}` shows `get_language()` = `English`, `get_answer_here()` = `true`, and `set_language("zh-TW")` rewrites the file keeping `answer_here`.

- [ ] `cargo build --release` produces `packages/monitor/cockpit-rs/target/release/cockpit`; `cockpit --version` prints `cockpit <version>` equal to `packages/monitor/.claude-plugin/plugin.json`'s version.
- [ ] Every subcommand listed above is accepted by clap and, stubbed, exits 2 with `cockpit: <sub> not implemented yet` on stderr; unknown subcommands exit non-zero.
- [ ] `paths.rs` honors every env override and fallback listed above, including empty-string-as-unset, and the one-time `~/.cockpit` migration only when `COCKPIT_HOME` is unset.
- [ ] `config.rs` reads a missing/corrupt/array file as default, preserves unknown keys and key order on rewrite, writes 2-space JSON plus a trailing newline, and removes an empty `nudges.projects`.
- [ ] `env_int` matches `parseInt` leading-digit semantics with the positive-only rule.
- [ ] `.gitignore` ignores `packages/monitor/cockpit-rs/target/`; `Cargo.lock` is present.
- [ ] fmt and clippy (`-D warnings`) are clean.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `test "$(packages/monitor/cockpit-rs/target/release/cockpit --version)" = "cockpit $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' packages/monitor/.claude-plugin/plugin.json)"`
- [ ] `packages/monitor/cockpit-rs/target/release/cockpit log; test $? -eq 2`
- [ ] `git check-ignore -q packages/monitor/cockpit-rs/target/release/cockpit`

## Eval rubric

> Scale 0–5 per `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | crate does not build, or a path resolves differently from TS | happy-path paths right, but empty-string env, migration, or config key order drifts | every path/env/fallback and config write matches TS byte-for-byte |
| Test coverage | ×2 | no tests | env overrides tested, fallbacks or migration untested | every override, fallback, migration, config edge (corrupt, array, unknown keys) and `env_int` edge tested, env tests serialized |
| Interface & readability | ×1 | subcommands hard-wired so later ports must restructure main.rs | stubs work but trailing args rejected or modules tangled | one function per TS resolver, stubs swap out one match arm at a time |
| Assumptions & docs | ×1 | version hard-coded with no link to plugin.json | deps unpinned or unexplained | versions pinned, `allow(dead_code)` justified, any TS divergence commented |

## Out of scope

- Registry, log root, daemon.json and process liveness — Deferred to a follow-up task in the same bucket.
- Adding axum, rmcp, rusqlite, notify, tokio-tungstenite — each port adds the crate it needs.
- Adding `Cargo.toml` to the release config's version files — Deferred. Reason: owned by the CI/release work.
