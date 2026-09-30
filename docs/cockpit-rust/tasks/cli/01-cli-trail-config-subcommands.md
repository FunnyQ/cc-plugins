# CLI-01: Trail and config subcommands

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/03, contract/04
> **Blocks**: cli/02
> **Status**: todo

## Goal

`cockpit log`, `scribe`, `prep`, `config`, `nudge`, and `find-session` run from the Rust binary with the same argv, stdout, stderr, exit codes, and file writes as `cockpit.ts` / `find-session.ts`, so the contract groups `cli: trail`, `cli: config`, and `cli: find-session` pass against Rust.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/cli.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group only; green against TS first.
- `packages/monitor/cockpit-rs/src/cli/mod.rs` (new) — the shared argv parser, `USAGE`, provider parsing, registry upsert/heartbeat helpers used by every CLI subcommand.
- `packages/monitor/cockpit-rs/src/cli/trail.rs` (new) — `log`, `scribe` (write / `--recent` / `--prep`), `prep`, and the `--diagram` lint gate.
- `packages/monitor/cockpit-rs/src/cli/settings.rs` (new) — `config`, `nudge`, and the `find-session` subcommand's argv and output.
- `packages/monitor/cockpit-rs/src/main.rs` (modify) — dispatch the six subcommands.
- `packages/monitor/cockpit-rs/Cargo.toml` (modify) — add `uuid` (feature `v4`) and `time` (features `formatting`, `parsing`), each with a one-line justification comment, unless the core modules already provide an ISO-8601 clock and UUID.
- `packages/monitor/skills/cockpit/scripts/diagram-lint.ts` (modify) — add a stdin CLI entry.

Reuse the core modules the crate already has (`paths`, `config`, `tunables`, `registry`, `log_root`, `process_alive`, `call_log`, `find_session`, `nudge_toggle`). `find_session.rs` and `nudge_toggle.rs` are owned by the core bucket: import them, never create, copy, or extend them here. When one of the other core modules lacks a function this task needs, add it to that module rather than duplicating logic in `cli/`.

## Implementation notes

### Top-level dispatch and argv (port of `cockpit.ts main` / `parseArgs`)

- `--help` or `-h` anywhere after the subcommand, or `cockpit --help`, prints `USAGE` to stdout and exits 0. This check runs **before** the subcommand, so `log --help` never writes a record.
- `USAGE` text, verbatim:

```
usage: cockpit <log|scribe|prep|config|wait|send|restart|nudge> [args]
  cockpit log    --session <id> --decision D --reason R [--tradeoff T]
                 [--facet "LABEL: text"]... [--file p]... [--option o]...
                 [--diagram MERMAID] [--needs-call]
  cockpit scribe --type <kind> --text <body> [--title <headline>]
                 [--file <path>]... [--diagram MERMAID] [--session <id>]
  cockpit scribe --recent [N] | --prep [--provider <p>]
  cockpit prep   [--provider <p>]
  cockpit config --log-language <lang> | get-language
                 | --answer-here on|off | get-answer-here
  cockpit wait   <sessionId>
  cockpit send   <sessionId> <answer>
  cockpit restart [--port N] [--no-open]
  cockpit nudge  <on|off|toggle|clear|status> [--scope session|project|user]
```

  Keep the first line byte-identical to the TS; contract tests may compare it. Only `find-session` and `hook` are extra subcommands; neither appears in `USAGE`.
- Hand-roll the parser (clap's error text and exit codes do not match). Rules, for `log`, `scribe`, `prep`:
  - Single-value flags: `provider session log-language answer-here decision reason tradeoff call type text title diagram` — take the next token.
  - Repeated flags: `file option facet` — each occurrence appends the next token.
  - Boolean flags: `needs-call prep`.
  - `--recent` sets a flag and consumes the next token only when it matches `^\d+$`.
  - Tokens not starting with `--` are skipped.
  - Any other `--x` prints `cockpit: unknown flag "--x"` then `USAGE` to stderr, exit 1.
- `positionals(rest)`: every token not starting with `--`; a `--x` token also skips the token after it.
- Unknown subcommand: stderr `cockpit: unknown subcommand "<sub>"` then the first `USAGE` line, exit 1.
- Provider: absent or `claude` → claude; `codex`, `opencode`; else stderr `cockpit: invalid provider "<v>"`, exit 1.

### Record shape (JSON key order = TS object literal order)

```
{"id","type":"decision","kind","source","decision","reason","tradeoff","facets":[{"label","text"}],"needs_your_call","options","files","diagram"?,"timestamp"}
```

- `id`: UUID v4. `timestamp`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds, like JS `toISOString`).
- `diagram` is omitted entirely when `--diagram` is absent.
- `--facet "LABEL: text"`: split on the first `:` and trim both sides. With no colon: `{label:"", text: trimmed}`. Drop entries whose label and text are both empty.
- One line is `serde_json::to_string(&rec)` plus `\n`, appended to the file.

### Paths

- The storage root is `log_root(cwd)`. The log is `<root>/.cockpit/logs/<sessionId>.jsonl`; create `<root>/.cockpit/logs` recursively.
- Session lookup uses the raw cwd: `--session` wins, else `find_session(provider, cwd)`.

### `log`

1. If no session resolves: stderr `cockpit log: --session <id> is required (could not auto-resolve the current session)`, exit 1.
2. Run the diagram gate.
3. Build the record with `kind:"decision"`, `source:"agent"`, and `needs_your_call` = the `--needs-call` flag.
4. Append the line.
5. Read-back guard: the last non-blank line of the file must equal the line just written. Otherwise stderr `cockpit log: entry did not persist to <path>`, exit 1.
6. Refresh the heartbeat:
   - Registry entry found: set `provider`, `project`, `logPath`, and `lastHeartbeat` = now. Keep the title fields.
   - No entry: upsert a new one.
7. Print `cockpit: logged decision for <id>`. When `needs_your_call` is set, also print `  call:  <record id>`.

### `scribe`

- `--prep` without `--type` prints these blocks, then exits 0:
  1. `Decision-log language:`, then the language.
  2. A blank line, `Recent scribe entries:`, then the recent listing.
  3. A blank line, `Git change context:`, then the three git blocks below, separated by blank lines.
- Each git block is `$ <label>` followed by the command's `stdout.trimEnd()`, or `(no output)` when empty. On a spawn error or non-zero exit it is `(not available: <stderr|stdout|exit N, trimmed>)`. The three blocks, in order: `git diff`, `git diff --staged`, `git log --oneline -5`. Run each in cwd.
- `--recent [N]` without `--type` prints the recent listing, then exits 0. N defaults to 8.
- Recent listing (`printRecentScribeEntries`):
  1. No session resolved: print `(no session resolved — pass --session <id> to name one)`.
  2. Candidate logs are the cwd-derived path plus the registry entry's `logPath` when it differs.
  3. No candidate exists: print `(no decision log yet — looked in: <a>, <b>)`.
  4. More than one candidate holds scribe entries (`source ?? "agent"` == `scribe`): print `! this session's trail is SPLIT across several logs — showing all of them:`, then `!   <path> (<count>)` for each.
  5. No scribe entries across all candidates: print `(no scribe entries yet)`.
  6. Otherwise sort all scribe entries by `timestamp` and print the last N as `<kind ?? decision> · <decision || (untitled)> · <timestamp>`.
  7. Unparseable lines are skipped.
- Write mode validation, in order. Each failure prints to stderr and exits 1:
  1. `--type` missing: `cockpit scribe: --type <kind> is required (or use --recent to list recent entries)`.
  2. `--type` not in `decision, rationale, learning, caveat`: `cockpit scribe: invalid --type "<t>" — must be one of: decision, rationale, learning, caveat`.
  3. `--text` missing: `cockpit scribe: --text <body> is required`.
  4. No session resolves: the same message as `log`, with `scribe` in place of `log`.
- Then run the diagram gate and build the record:
  - `kind` = `--type`, `source:"scribe"`.
  - `decision` = `--title` or `""`, `reason` = `--text`.
  - `tradeoff` `""`, `facets` `[]`, `needs_your_call` false, `options` `[]`.
- Upsert the registry **before** the append.
- Guard: the record id must appear anywhere in the file. This is not a tail check, because concurrent scribes interleave. On failure: stderr `cockpit scribe: entry did not persist to <path>`, exit 1.
- Print `cockpit: scribed <kind> for <id>`. Do not refresh the heartbeat afterwards.

### `prep`

- No session resolves: stderr `cockpit prep: could not auto-resolve the current session`, exit 1.
- Otherwise print `Session id:`, the id, a blank line, `Decision-log language:`, then the language.

### Registry writes (CLI side)

- Read `registry.json`. A missing file, corrupt JSON, or a non-array `sessions` all yield `{sessions:[]}`. Coerce each entry's `provider` to `claude` unless it is `codex` or `opencode`.
- Upsert keys on `sessionId` and merges fields over the existing entry.
- Every write first reaps entries whose last signal is 14 days old or older. Last signal = max(parsed `lastHeartbeat`, mtime of `logPath`); an unparseable signal counts as 0.
- Write with `mkdir -p` of the cockpit home, as `JSON.stringify(reg, null, 2)` with **no trailing newline** (that is what the TS writer produces).

### Diagram gate (`log` / `scribe --diagram`)

- Skip everything when `--diagram` is absent.
- Otherwise spawn `bun <plugin root>/skills/cockpit/scripts/diagram-lint.ts`, write the source to its stdin, and parse stdout as a JSON array of strings.
- On a non-empty array: print `cockpit <log|scribe>: --diagram failed lint — fix the Mermaid source and re-run:` to stderr, then one `  - <problem>` line per problem, exit 1. Nothing is written.
- The plugin root comes from the `paths` module (`COCKPIT_PLUGIN_ROOT` or the exe walk-up).
- The TS never blocks a write over a broken parser. If `bun` cannot be spawned, treat the source as clean and add a one-line comment saying why.

### `diagram-lint.ts` stdin entry

Append to the end of the file:

```ts
// CLI entry for the Rust `cockpit log|scribe --diagram` gate: source on stdin,
// problems as a JSON array on stdout.
if (import.meta.main) {
  const problems = await lintDiagram(await Bun.stdin.text());
  process.stdout.write(JSON.stringify(problems) + "\n");
}
```

- Always exit 0.
- `lintDiagram(src: string): Promise<string[]>` is unchanged. Empty source returns `["empty diagram source"]`.

### `config` (positional/flag checks in this order)

1. `--log-language L`: write `log_language` and print `cockpit: log_language = L`.
2. First positional `get-language`: print the language. This is `log_language` trimmed; a missing, non-string, or empty value prints `English`.
3. `--answer-here on|off`: write the boolean and print `cockpit: answer_here = on|off`. Any other value: stderr `cockpit config: --answer-here takes on | off`, exit 1.
4. First positional `get-answer-here`: print `on` iff `answer_here === true`.
5. Anything else: stderr `usage: cockpit config --log-language <lang> | get-language | --answer-here on|off | get-answer-here`, exit 1.

Every config write is read-merge-write of the whole object, as `JSON.stringify(cfg, null, 2) + "\n"`, with `mkdir -p` of the parent.

### `nudge`

The scope logic is the crate's `nudge_toggle` module. This task only parses argv and prints. Signatures it calls:

```rust
pub fn read_scopes(session_id: Option<&str>, cwd: &Path, now_ms: i64) -> (Option<NudgeState>, Option<NudgeState>, Option<NudgeState>);
pub fn resolve_nudge_enabled(session: Option<NudgeState>, project: Option<NudgeState>, user: Option<NudgeState>) -> bool;
pub fn set_scope(scope: NudgeScope, action: ToggleAction, session_id: &str, cwd: &Path, now_ms: i64) -> Option<NudgeState>;
```

What those functions persist, for reference when checking output:

- **Session scope** lives in `$COCKPIT_HOME/scribe-nudge-toggle.json`:
  - Shape: `{ "<sessionId>": { "state": "on"|"off", "ts": <ms> } }`.
  - On read, drop invalid entries and entries whose age is 7 days or more.
  - Write compact JSON (no indent) with `mkdir -p`. Swallow write errors.
- **Project scope** is `config.nudges.projects[project_key]`:
  - Clearing removes the key.
  - An emptied `projects` map is removed.
- **User scope** is `config.nudges.user`.
- Command parsing:
  - Action defaults to `status`, scope defaults to `session`.
  - `--scope v` must be `session|project|user`. Otherwise stderr `cockpit nudge: invalid scope "<v>"` plus `usage: cockpit nudge <on|off|toggle|clear|status> [--scope session|project|user]`, exit 1.
  - Any other token becomes the action, lowercased. An action outside `on off toggle clear status` prints `cockpit nudge: unknown action "<a>"` plus the usage, exit 1.
- The session id comes from `find_session(claude, cwd)`. A non-status action on the session scope with no id prints `cockpit nudge: could not resolve the current session id (no CLAUDE_CODE_SESSION_ID and no transcript). Run inside a Claude session, or target --scope project|user.`, exit 1.
- Output:
  - Line 1: `scribe nudges: ON|OFF (effective)`. For a non-status action, append ` — <scope> set to <ON|OFF|default>`.
  - Line 2: `  session: X · project: Y · user: Z`, where each value is `ON`, `OFF`, or `default`.

### `find-session` subcommand

Lookup is the crate's `find_session` module: `pub fn find_session(provider: Provider, project: &Path) -> Option<String>`. It prints its own not-found and DB-error diagnostics to stderr. This task adds only the subcommand:

- **Subcommand** `cockpit find-session [--provider claude|codex|opencode] [projectPath]`:
  - The project defaults to cwd.
  - An invalid provider prints `find-session: invalid provider "<v>"`, exit 1.
  - Found: print the id, exit 0. Not found: exit 1 (the diagnostic is already on stderr).

## Acceptance criteria

- [ ] Against Rust, the `cli: trail` group passes: `log`, the `scribe` write / `--recent` / `--prep` modes, `prep`, `--help`, the unknown-flag error, and a failing `--diagram` exiting 1 with nothing written.
- [ ] Against Rust, the `cli: config` group passes: every `config` form and every `nudge` action/scope, byte-identical writes to `config.json` and `scribe-nudge-toggle.json`.
- [ ] Against Rust, the `cli: find-session` group passes for claude, codex, and opencode fixtures, including the not-found stderr lines and exit 1.
- [ ] A record written by Rust `log` parses back with the TS key order, and `registry.json` has no trailing newline.
- [ ] `bun packages/monitor/skills/cockpit/scripts/diagram-lint.ts <<< 'flowchart TD'` prints a JSON array and exits 0, and existing TS importers of `lintDiagram` are unaffected.
- [ ] `cargo test` covers the pure pieces: the facet split, the argv parser (`--recent` numeric lookahead, unknown flag), `nudge` argv parsing (invalid scope, unknown action), and the 14-day registry reap.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: trail"`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: config"`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: find-session"`
- [ ] The same three groups, run without `COCKPIT_BIN` (against TS), still pass.
- [ ] `bunx --bun tsc --noEmit | grep diagram-lint` prints nothing.

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A subcommand is missing, or it writes a malformed record or registry | Happy paths match, but an error string, exit code, key order, or trailing-newline detail drifts from TS | All three contract groups pass against Rust and TS; every stderr line and exit code matches |
| Test coverage | ×2 | No cargo tests | Tests cover the happy path only | cargo tests pin the parser edge cases, facet split, nudge argv parsing, and reap window |
| Interface & readability | ×1 | Logic duplicated from the core modules; `unwrap` on file or JSON reads | Works, but `cli/` re-implements a path or config helper | `cli/` calls the shared `nudge_toggle` and `find_session` modules and only orchestrates |
| Assumptions & docs | ×1 | New crates with no justification | Deviations from TS unexplained | Every new dependency is justified, and the "bun missing ⇒ clean" choice is commented |

## Out of scope

- `wait`, `send`, `restart` — deferred to a follow-up task in the same bucket; they need the daemon's broker routes.
- Rewriting the Mermaid lint in Rust — Deferred. Reason: it parses with mermaid's JS; the plan keeps it on Bun.
- Updating skill docs to call the shim instead of `bun cockpit.ts` — Deferred. Reason: the wiring step switches every caller at once.
