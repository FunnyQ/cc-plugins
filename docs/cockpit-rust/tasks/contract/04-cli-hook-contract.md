# CONTRACT-04: CLI and hook contract

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Status**: done

## Goal

Two black-box bun suites that pin every CLI subcommand of `cockpit` and both hook entry points. For each one they pin the argv, stdout, stderr, exit code, and the files it writes. Both suites must pass against today's TS scripts, and later the Rust binary must pass them unchanged.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/cli.contract.test.ts` (new): the `cli: *` groups.
- `packages/monitor/skills/cockpit/contract/hook.contract.test.ts` (new): the `hook: *` groups.
- `packages/monitor/skills/cockpit/contract/fixtures.ts` (modify, only if needed): add shared helpers such as `hookPayload(...)` or a delegation-marker writer. Keep the existing exports unchanged.

## Implementation notes

### Harness you build on (already exists)

`contract/launcher.ts` exports `command(proc, argv)`, `underTest`, `SCRIPTS_DIR`, `PLUGIN_ROOT`.

`contract/fixtures.ts` exports:
- `makeHomes()`, `freePort()`, `baseEnv(h, extra)`
- `makeProviderFixtures(h)` → `{projectDir, claudeSessionId, codexThreadId, opencodeSessionId, …}`, `fixtureEnv(f)`
- `startDaemon(env, {port})` → `{proc, port, token, base, info}`, `stopDaemon(d)`
- `run(proc, argv, {env, cwd, stdin})` → `{exitCode, stdout, stderr}`
- `readJsonl(path)`, `cleanup(...dirs)`

For CLI calls use `run("cli", ["log", …])`. For hooks use `run("hook", ["session-start"], {stdin: JSON.stringify(payload)})`.

### How to discover exact behavior

- Read the TS source before writing each assertion:
  - `cockpit.ts`: the `USAGE` text, `parseArgs`, each `cmd*` function, and `main`'s dispatch.
  - `find-session.ts`
  - `decision-log-start.ts`, `decision-log-reminder.ts`, `scribe-nudge.ts`, `nudge-toggle.ts`, `delegation-marker.ts`
- Pin what TS does today. Where it looks odd, keep it and add `// pins TS quirk: …`.
- Trails land at `<projectDir>/.cockpit/logs/<sid>.jsonl`. The registry lives at `$COCKPIT_HOME/registry.json`.

### cli.contract.test.ts groups

Every `describe` name starts with exactly one of the prefixes below. Each group must pass on its own with `-t`.

- **cli: trail** covers `log`, `scribe`, `prep`, and `--diagram`.
  - `log --session <sid> --decision … --reason …` from `projectDir`:
    - Exits 0.
    - Appends one record whose `type` and field names match `cmdLog`.
    - The registry gains `{provider, project, sessionId, logPath, lastHeartbeat}` for that session.
    - A second `log` updates `lastHeartbeat` and does not duplicate the entry.
  - A `needs_your_call` log gets an `id`.
  - `scribe` writes its record type. Read `cmdScribe` for the required flags.
  - `prep` prints what `cmdPrep` prints for a seeded trail. Assert the stable structure; normalize timestamps.
  - `--diagram` with valid Mermaid (`flowchart LR\n  A-->B`) exits 0, and the record carries the diagram.
  - `--diagram` with broken Mermaid (`flowchart LR\n  A-->`):
    - Exits 1 and writes nothing to the trail.
    - Its stderr starts with `cockpit log: --diagram failed lint — fix the Mermaid source and re-run:` and has at least one `  - ` line.
    - Drive this through `cockpit log --diagram`. A stdin CLI entry for `diagram-lint.ts` does not exist yet.
  - `log --help` prints `USAGE` and writes nothing.
  - An unknown subcommand exits 1 with the two stderr lines from `main`.
- **cli: config** covers `config` and `nudge`.
  - `config get-language` and `config --log-language zh-TW` round-trip through `$XDG_CONFIG_HOME/q-lab/cockpit/config.json`.
  - `config --answer-here on|off` persists `answer_here`.
  - `nudge status|on|off|toggle|clear` with `--scope session|project|user`:
    - Stdout matches the two lines `scribe nudges: ON|OFF (effective)…` and `  session: … · project: … · user: …`.
    - The effective value follows session → project → user precedence.
    - The user and project scopes persist in config.json. The session scope persists in `$COCKPIT_HOME/scribe-nudge-toggle.json`.
- **cli: find-session**
  - Run `find-session --provider claude|codex|opencode <projectDir>` with `fixtureEnv`.
  - Each run prints the fixture id and exits 0.
  - A project with no transcripts exits non-zero with the `find-session: …` stderr text.
  - An invalid provider exits non-zero with `find-session: invalid provider "x"`.
- **cli: wait** runs against a real daemon from `startDaemon`, with `COCKPIT_WAIT_TIMEOUT_MS=1500`.
  - With `answer_here` off, `wait <sid>` on a session with an open call exits **4** with the TS stderr text.
  - With `answer_here` on and a live `/api/permission-stream?session=…&token=…` subscriber that the test opens itself via fetch and keeps open, `wait` parks. A POST to `/api/respond` releases it, and it prints the answer with exit 0.
  - A newer `needs_your_call` logged while `wait` is parked makes it exit **3** (superseded) with the TS text.
  - `COCKPIT_WAIT_MAX_MS` small makes `wait` give up with the TS exit code and text.
- **cli: send** — `cmdSend` in `cockpit.ts` POSTs `/api/respond` with `{session, answer, call, token}`; it never touches `/api/inbox`. Runs against a real daemon from `startDaemon`.
  - Parked case: seed a trail with an open `needs_your_call`, set `answer_here` on, open the `/api/permission-stream` subscriber, and start `wait <sid>` in the background so it parks. Then `send <sid> <answer>`:
    - `send` exits 0 and prints exactly `delivered: true`.
    - The trail gains one `response` line whose `call` equals the open call's `id`, with the answer text.
    - The background `wait` exits 0 printing the answer.
  - Nobody parked: `send <sid> <answer>` exits 0 and prints `delivered: false` followed by `  (answer logged, but the session isn't parked/listening right now)`; the `response` line is still appended.
  - `--call <id>` overrides the auto-resolved call id in the `response` line.
  - Missing args: `send` alone exits 1 with `cockpit send: <sessionId> <answer> is required` on stderr.
  - A daemon answering non-2xx (e.g. a `daemon.json` whose `token` was changed to a wrong value) makes `send` exit 1 with `cockpit send: …` on stderr.
- **cli: restart**
  - Start a daemon.
  - `restart --no-open --port <p>` supersedes it: the old pid dies, and `daemon.json` has a new pid with `root` ending `/skills/cockpit/scripts`.
  - Stdout matches the TS text shape.
  - Stop the new daemon afterwards.

### hook.contract.test.ts groups

- **hook: session-start**
  - Payload `{session_id, cwd: projectDir, hook_event_name: "SessionStart", source: "startup"}`.
  - Put a `PATH` in `env` that has no `claude` binary. `decision-log-start.ts` prints nothing when it detects Claude Code and `claude` is on PATH; pin that branch too, with a fake `claude` script on PATH, expecting empty stdout.
  - Without `PLUGIN_ROOT`: stdout is the guidance text plus a newline, and it starts with `DECISION LOG ACTIVE`.
  - With `PLUGIN_ROOT` set (Codex): the Codex variant.
  - `RELAY_DELEGATED=1` gives empty stdout and exit 0.
  - A delegation marker written to `$HOME/.local/share/q-lab/delegation/<ts>-<rand>.json` with matching `cwd`, `armUntil` in the future, and `PLUGIN_ROOT` set:
    - Stdout is empty.
    - The marker's `sessionIds` now contains the payload's `session_id`.
    - The test's `HOME` is the fixture root.
  - Invalid JSON on stdin degrades to the env-only checks. Pin the output.
- **hook: stop**
  - Payload for a Stop event on a session with a seeded trail and recent transcript activity.
  - Without `PLUGIN_ROOT`: stdout is JSON `{hookSpecificOutput: {hookEventName, additionalContext}}`.
  - With `PLUGIN_ROOT`: stdout is `{systemMessage}`.
  - Nudges set `off` through the nudge toggle give empty stdout.
  - `RELAY_DELEGATED=1` gives empty stdout.
  - `COCKPIT_NUDGE_THROTTLE_MS` throttling: a second immediate Stop is suppressed, matching TS.
  - Read `scribe-nudge.ts` for the conditions that decide whether a nudge fires, and set up the fixture so the positive case fires.
  - Where the TS spawns a background `claude -p` scribe (Claude Code with `claude` on PATH), use a PATH without `claude` so no process is spawned. Pin the no-`claude` branch only, and note it as a `// pins TS quirk:` comment.

### Rules

- Every test gets fresh homes via `makeHomes()`. `HOME` is always the fixture root.
- Every wait or park has a deadline of 5 s or less.
- No daemon or child process outlives its group.

## Acceptance criteria

- [x] `cli.contract.test.ts` has the 6 `cli: *` groups and `hook.contract.test.ts` has the 2 `hook: *` groups. Every test sits inside one.
- [x] All 9 CLI subcommands are exercised: `log`, `scribe`, `prep`, `config`, `nudge`, `find-session`, `wait`, `send`, `restart`. So are `--help` and the unknown-subcommand path.
- [x] `wait` exit 3 on superseded and exit 4 on `not_watching`, the diagram-lint failure (exit 1 + exact stderr prefix + no trail write), and restart supersede are asserted.
- [x] `cli: send` asserts the `/api/respond` path: `delivered: true` waking a parked `wait`, `delivered: false` with nobody parked, the `response` trail line with the right `call`, and no request to `/api/inbox`.
- [x] Both hooks are asserted for the Claude and Codex (`PLUGIN_ROOT`) output shapes, `RELAY_DELEGATED=1` suppression, and the delegation-marker write-back. Nudge-off suppression is asserted for `hook: stop` only; `hook: session-start` asserts that guidance still prints with nudges off, because `decision-log-start.ts` never reads the nudge toggle.
- [x] Both suites pass against TS. Each group passes alone with `-t`. No daemon survives the run.
- [x] No test touches the real home, the real XDG dirs, or port 5858.
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts` passes (`COCKPIT_BIN` unset).
- [x] `bun test packages/monitor/skills/cockpit/contract/hook.contract.test.ts` passes (`COCKPIT_BIN` unset).
- [x] `bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: wait"` passes on its own.
- [x] `bun test packages/monitor/skills/cockpit/contract/cli.contract.test.ts -t "cli: send"` passes on its own.
- [x] `pgrep -f 'cockpit-server.ts --no-open --port' ; test $? -eq 1` after the run.
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Eval rubric

> Scale 0–5 (see `../_context/rubric.md`); weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Fails against TS, or asserts output TS does not produce | Green, but stdout/exit codes only loosely checked (e.g. "exit != 0") | Green against TS; exact exit codes, stderr prefixes, stdout JSON shapes and file writes pinned |
| Test coverage | ×2 | Only `log` and one hook | Every subcommand touched, but failure branches (exit 4, lint failure, suppression) missing | Every subcommand plus every suppression, failure and provider branch covered |
| Interface & readability | ×1 | Copy-pasted spawn code per test | Helpers exist but groups share state | Groups self-contained and filterable; helpers keep each assertion readable |
| Assumptions & docs | ×1 | Branches pinned without saying which TS condition drives them | Some conditions named | Each branch names the TS function/condition it pins; quirks carry `// pins TS quirk:` |

## Out of scope

- The daemon's own route contract and the channel contract. Reason: separate suites.
- Spawning a real background `claude -p` scribe from the Stop hook. Reason: it needs a real Claude CLI and costs tokens; the no-`claude` branch is pinned instead.
- The `diagram-lint.ts` stdin entry point. Reason: it does not exist yet; the Rust CLI work adds it.
