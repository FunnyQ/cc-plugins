# Compatibility contracts

> Every shape here is observable outside the process that produces it: another process, another plugin, the SPA, or a user's disk reads it. Rust must reproduce each one exactly. The TS source named in each section is the authoritative behavior; read it when this file is not specific enough, and port what it does.

## 1. Environment variables

Honor every one, same name, same fallback. `envInt` semantics: a positive integer parses, anything else (unset, `0`, negative, garbage) means the fallback.

| Var | Used by | Meaning / fallback |
|---|---|---|
| `COCKPIT_HOME` | all | Cockpit data dir. Fallback `$XDG_DATA_HOME/q-lab/cockpit`, `XDG_DATA_HOME` fallback `~/.local/share`. When `COCKPIT_HOME` is unset, first migrate: if the new dir does not exist and `~/.cockpit` does, `mkdir -p` its parent and rename `~/.cockpit` to it; ignore any error. |
| `XDG_CONFIG_HOME` | config | Config file is `$XDG_CONFIG_HOME/q-lab/cockpit/config.json`, fallback `~/.config/...`. |
| `XDG_DATA_HOME` | paths, shim | See `COCKPIT_HOME`; shim installs binaries under `$XDG_DATA_HOME/q-lab/cockpit/bin/<version>/`. |
| `COCKPIT_CLAUDE_PROJECTS_DIR` | server, find-session | Fallback `~/.claude/projects`. |
| `COCKPIT_CLAUDE_SESSIONS_DIR` | channel, server | Fallback `~/.claude/sessions`. |
| `COCKPIT_CODEX_DIR`, `COCKPIT_CODEX_STATE_DB`, `COCKPIT_CODEX_SESSIONS_DIR` | server, find-session | Codex home (`~/.codex`), `state_5.sqlite`, rollout dir. Source: `codex-db.ts`. |
| `COCKPIT_OPENCODE_DB`, `OPENCODE_DATA_DIR` | server, find-session | OpenCode DB path. Source: `shared/scripts/opencode.ts`. |
| `COCKPIT_SERVER_PORT` | server | **New, added to TS too.** Default port when `--port` is absent, fallback `5858`. Lets the channel-spawn contract test run on a free port. |
| `COCKPIT_WAIT_TIMEOUT_MS` | server | Long-poll hop budget, default `240000`. Must stay under the server idle timeout (255 s). |
| `COCKPIT_WAIT_MAX_MS` | CLI `wait` | Total wait across re-polled hops, default 6 h. Source: `cockpit.ts`. |
| `COCKPIT_STASH_TTL_MS` | server | How long an answer with nobody parked stays claimable, default `60000`. |
| `COCKPIT_CHANNEL_TTL_MS` | server | Channel liveness window. Source: `inbox.ts`. |
| `COCKPIT_TAIL_POLL_MS`, `COCKPIT_RESOLVE_POLL_MS` | server | SSE tailer poll cadences (defaults 2000 / 500). Source: `sse-tailer.ts`. |
| `COCKPIT_TRANSCRIPT_GUARD_MS` | server | Permission guard window. Source: `permission.ts`. |
| `COCKPIT_NUDGE_THROTTLE_MS` | hook stop | Source: `scribe-nudge.ts`. |
| `CLAUDE_CODE_SESSION_ID` | channel, CLI, hooks | Current Claude session id when set. |
| `CLAUDE_PROJECT_DIR` | hooks | Project dir from Claude Code. |
| `CLAUDE_CODE_ENTRYPOINT` | hooks | Harness detection; prefix `sdk` means headless. Source: `decision-log-start.ts`, `scribe-nudge.ts`. |
| `Q_DELEGATION_HOME` | hooks | Delegation marker dir override, fallback `~/.local/share/q-lab/delegation`. Source: `delegation-marker.ts`. |
| `PLUGIN_ROOT` | hooks | Set by Codex only; its presence is Codex's tell for the delegation-marker reader. |
| `RELAY_DELEGATED` | hooks | `1` suppresses decision-log hooks. Source: `decision-log-start.ts`, `scribe-nudge.ts`. |
| `OPENCODE_TUI_SERVER_URL`, `OPENCODE_SERVER_URL`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SESSION_ID`, `OPENCODE_SESSION` | server, CLI | OpenCode bridge discovery and auth. Source: `opencode-send.ts`. |
| `COCKPIT_BIN` | shim, contract suite | **New.** Absolute path of the binary to exec/test. |
| `COCKPIT_PLUGIN_ROOT` | Rust | **New.** Set by the shim: absolute, symlink-resolved `packages/monitor` dir of the running install. When unset (a bare `target/release/cockpit` run), Rust falls back to walking up from `std::env::current_exe()` to the first ancestor containing `.claude-plugin/plugin.json`; if none, it exits 2 with `cockpit: cannot locate plugin root; set COCKPIT_PLUGIN_ROOT`. |
| `COCKPIT_RELEASE_BASE_URL` | shim | **New.** Download base, default `https://github.com/FunnyQ/cc-plugins/releases/download`. Tests point it at a local server. |

## 2. Files on disk

Each JSON file keeps its TS writer's exact format: `config.json` and `daemon.json` are 2-space indent plus a trailing newline; `registry.json` is 2-space indent with no trailing newline; `scribe-nudge-toggle.json`, `scribe-nudge.json`, and delegation markers are compact (no indent, no newline); read tolerantly (unknown keys ignored, missing file or corrupt JSON = the documented empty value).

### `$COCKPIT_HOME/daemon.json`

```json
{ "pid": 12345, "port": 5858, "token": "<random hex>", "root": "/abs/.../monitor/6.0.0/skills/cockpit/scripts" }
```

- Written by the server at bind; read fresh on every call by every client (no caching — a restart changes the token). Missing/corrupt = no daemon.
- `root` is `<plugin root>/skills/cockpit/scripts` — the same string the TS daemon writes, even though the Rust binary does not live there. usage-dashboard's `live.ts` reads `port`.
- **Startup decision** (`daemon-lifecycle.ts`): no record or dead pid → start; alive and `root` equal → reuse (print URL, exit 0); alive and `root` differs → supersede (SIGTERM, wait, then SIGKILL the old pid, then start).
- **Version-aware spawn** (`cockpit-channel.ts` `versionFromRoot` / `compareVersions`): the version is the path segment after `/monitor/` in `root` (`/monitor/6.0.0/skills/...`); a repo checkout has none. The channel spawns a new server only when its own version is strictly newer than the daemon's; with either version unparseable it does not supersede and reuses the running daemon (`shouldSupersedeDaemon` returns false).

### `$COCKPIT_HOME/registry.json`

```json
{ "sessions": [ { "provider": "claude", "project": "/abs/project", "sessionId": "…", "title": "…", "titleResolved": true, "logPath": "/abs/project/.cockpit/…/<session>.jsonl", "lastHeartbeat": "2026-09-30T12:00:00.000Z" } ] }
```

- `provider` ∈ `claude|codex|opencode`; `title`/`titleResolved` optional. Main writer: CLI `log`/`scribe`; the server writes only resolved titles back. Readers: server, usage-dashboard `live.ts`. Source: `registry.ts`.
- Two writers exist, so every write is read-modify-write of the latest file content.

### `$COCKPIT_HOME/scribe-nudge-toggle.json`

Per-session nudge overrides. Source: `nudge-toggle.ts`.

### `$XDG_CONFIG_HOME/q-lab/cockpit/config.json`

```json
{ "log_language": "zh-TW", "answer_here": false, "nudges": { "user": "on", "projects": { "/abs/root": "off" } } }
```

Every key optional; `nudges.*` values only `on|off` (anything else = absent). Source: `config.ts`.

### Decision trail `<log root>/.cockpit/…/<session>.jsonl`

- Log root: walk up from cwd for an existing `.cockpit/` dir, never crossing the git root; else the git root; else cwd. Source: `log-root.ts`.
- One JSON object per line, append-only. Record types and fields: see `cockpit.ts` (`log`, `scribe`, `respond`) and `call-log.ts`. chronicle's `cockpit-trail.ts` reads these files directly, so field names, `type` values, and the `id`/`call` linkage of `needs_your_call` → `response` must not change.
- Open-call rule (`call-log.ts latestOpenCallId`): only the latest `needs_your_call` can be open; a later `response` with `call === id` closes it; a legacy `response` without `call` closes whatever the latest open call is.

### Delegation marker `~/.local/share/q-lab/delegation/<startedAt>-<rand>.json`

`{ cwd, backend, startedAt, armUntil, expiresAt, sessionIds: [] }`. Written by relay, read (and `sessionIds` appended) by the hooks. Two-phase match: `cwd` only until `armUntil`, then exact `session_id`. Read only when `PLUGIN_ROOT` is set. Source: `delegation-marker.ts`.

## 3. HTTP API (`cockpit server`)

- Binds `127.0.0.1`, default port `5858`, flag `--port N`, flag `--no-open` (otherwise opens the browser at the URL). Idle timeout 255 s.
- Routing matches on path only (any method), except `/api/answer-here`, which distinguishes GET/POST.
- Auth: the `token` from `daemon.json`, passed as `?token=` or in the JSON body, exactly as each TS handler reads it. Wrong/missing token → the same status and body the TS returns.
- JSON responses: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`. Errors: `{"error": "<message>"}` with the TS status (500 default, 400 for param validation).
- Long-poll sentinels: a hop that times out returns `{"timeout": true}` (client re-polls); an abandoned permission returns `{"abandoned": true}`; `/api/wait` without presence returns `{"not_watching": true, "reason": "…"}`.
- Static: any other GET serves `<plugin root>/skills/cockpit/dashboard/dist` through the rules of `shared/scripts/static-server.ts` (only `/` maps to `index.html`; any other missing path is 404 — no SPA fallback; MIME by extension; ETag = mtime+size including the encoding — Rust may format mtime as integer milliseconds instead of TS's fractional base-36, since clients only compare ETags for equality; gzip for its `COMPRESSIBLE` set, `Cache-Control: no-cache`, path traversal refused via `path-inside.ts`).

| Route | Method | Purpose | TS source |
|---|---|---|---|
| `/api/projects` | GET | Projects view from registry | `registry.ts` |
| `/api/sessions` | GET | Sessions view (live status overlay) | `registry.ts`, `live-sessions.ts` |
| `/api/token` | GET | Daemon token for the SPA | `cockpit-server.ts` |
| `/api/design-system` | GET | Project DESIGN.md info | `design-system.ts` |
| `/api/project-info` | GET | Project metadata | `project-info.ts` |
| `/api/log/stream` | GET SSE | Tail the session's decision trail | `log-stream.ts`, `sse-tailer.ts` |
| `/api/transcript/stream` | GET SSE | Live transcript (Claude / Codex / OpenCode, subagents) | `transcript-stream.ts`, `subagents.ts` |
| `/api/transcript/history` | GET | Paged transcript backfill | `transcript-stream.ts` |
| `/api/wait` | GET long-poll | needs_your_call wait for the CLI | `broker.ts` |
| `/api/respond` | POST | Answer a call: append `response` to the trail, wake the waiter | `broker.ts` |
| `/api/answer-here` | GET/POST | Read/set `answer_here` in config | `cockpit-server.ts`, `config.ts` |
| `/api/inbox` | GET long-poll | Channel picks up UI messages; a parked poll = channel alive | `inbox.ts` |
| `/api/send-message` | POST | UI → Claude session via inbox | `inbox.ts` |
| `/api/codex-control/status` | GET | Codex app-server control probe | `codex-control-probe.ts` |
| `/api/send-codex-message` | POST | UI → Codex session | `codex-send.ts` |
| `/api/opencode-control/status` | GET | OpenCode TUI bridge probe | `opencode-send.ts` |
| `/api/send-opencode-message` | POST | UI → OpenCode session | `opencode-send.ts` |
| `/api/permission-request` | POST | Channel reports a permission prompt | `permission.ts` |
| `/api/permission-verdict` | POST | UI answers allow/deny | `permission.ts` |
| `/api/permission-resolved` | POST | Channel reports the prompt resolved elsewhere | `permission.ts` |
| `/api/permission-stream` | GET SSE | Push prompts to the UI; subscriber = presence | `permission.ts` |
| `/api/permission-pull` | GET long-poll | Channel pulls the verdict | `permission.ts` |

SSE: `Content-Type: text/event-stream`, same event names and `data:` payloads as TS, heartbeat comment every 25 s.

**Deliberate deviation — tailer UTF-8.** TS decodes each appended chunk separately (`partial + buf.toString("utf-8")`), so a multibyte character split across two appends becomes U+FFFD. Rust keeps the unfinished tail as bytes and decodes only complete lines, so the character arrives intact. No client depends on the replacement character.

**Presence gate for `/api/wait`**: applies only when the request carries `require_watcher=1` (as `cockpit wait` sends); without it a wait parks as before. With it, refuse with `not_watching` unless `answer_here` is true in config AND the session has a live `/api/permission-stream` subscriber. Place the gate after the stash drain and the superseded check.

## 4. MCP channel (`cockpit channel`)

- stdio JSON-RPC, server name `cockpit-channel`, version `0.0.1`, the same one-line `instructions` string as `cockpit-channel.ts`.
- Capabilities: `{ "experimental": { "claude/channel": {}, "claude/channel/permission": {} }, "tools": {} }`. `tools/list` → `{ "tools": [] }`.
- Server → client notifications:
  - `notifications/claude/channel` with `{ "content": "<text>", "meta": { "source": "cockpit" } }`, sent serially in arrival order.
  - `notifications/claude/channel/permission` with `{ "request_id": "…", "behavior": "allow" | "deny" }`.
- Client → server notifications handled: `notifications/claude/channel/permission_request` (forward to `POST /api/permission-request`), and any other method containing `permission` (cancel/resolved variants → `POST /api/permission-resolved`). Unknown non-permission notifications are ignored.
- Loops: inbox long-poll `GET /api/inbox?session=…&token=…` (≥ 1 s floor + jitter between polls, `{timeout:true}` → re-poll), permission long-poll `GET /api/permission-pull` (5 min budget, cancellable). Failures back off exponentially to 30 s max; `daemon.json` is re-read on every retry.
- Session id resolution order: `CLAUDE_CODE_SESSION_ID` → `$COCKPIT_CLAUDE_SESSIONS_DIR/<ancestor pid>.json` → `--session-id` in an ancestor's argv (via `ps`) → find-session for provider `claude` and cwd, retried for 3 s.
- `ensureServer`: when no live daemon, or the version rule in §2 says supersede, spawn `<self exe> server --no-open` detached (new session, stdio null) with `COCKPIT_PLUGIN_ROOT` passed through.
- Exits 0 on stdin EOF or SIGTERM.

## 5. CLI (`cockpit <subcommand>`)

Argv, flags, stdout, stderr, and exit codes match `cockpit.ts` (subcommands `log`, `scribe`, `prep`, `config`, `wait`, `send`, `restart`, `nudge`) and `find-session.ts` (`find-session [--provider claude|codex|opencode] [projectPath]`). Notable codes: `wait` exits `3` when the call is superseded and `4` on `not_watching`; a `--diagram` that fails lint exits `1` after printing `cockpit <cmd>: --diagram failed lint — fix the Mermaid source and re-run:` and one `  - <problem>` line per problem on stderr.

`--diagram` lint: spawn `bun <plugin root>/skills/cockpit/scripts/diagram-lint.ts` with the Mermaid source on stdin; it prints a JSON array of problem strings on stdout and exits 0. Empty array = clean. Skip the spawn when `--diagram` is absent.

`restart [--port N] [--no-open]`: supersede any running daemon with this install's server, retrying up to 4 times against a concurrent MCP respawn, then verify `daemon.json.root` is ours. Source: `cockpit.ts`, `restart-lifecycle.ts`.

## 6. Hooks (`cockpit hook session-start` / `cockpit hook stop`)

- Read the harness JSON payload on stdin; write exactly what `decision-log-start.ts` / `scribe-nudge.ts` write on stdout, same exit code. `session-start` writes a plain text line; `stop` writes a JSON object.
- The stop hook's headless scribe prompt and its `--allowedTools` name the shim path `<plugin root>/skills/cockpit/bin/cockpit`, not `cockpit.ts`, because the TS CLI is deleted. Claude Code, Codex, and OpenCode (`opencode/plugin.ts`) all consume this output.
- `session-start` includes the `decision-log-reminder.ts` behavior it imports; both honor `RELAY_DELEGATED=1` and the delegation marker.
- `session-start` prints nothing when it detects Claude Code and `claude` is on PATH — port that branch and its detection exactly as `decision-log-start.ts` does.
- Timeouts: session-start 5 s, stop 10 s. Neither may block on the network.

## 7. Shim (`packages/monitor/skills/cockpit/bin/cockpit`)

1. `COCKPIT_BIN` set → `exec "$COCKPIT_BIN" "$@"`.
2. Resolve `PLUGIN_ROOT_DIR` = `cd -P "$(dirname "$0")/../../.." && pwd` (the `packages/monitor` dir, symlinks resolved); export `COCKPIT_PLUGIN_ROOT`.
3. Version = the `"version"` value in `$COCKPIT_PLUGIN_ROOT/.claude-plugin/plugin.json` (sed, no jq).
4. Target from `uname -s`/`uname -m`: Darwin arm64 → `aarch64-apple-darwin`, Darwin x86_64 → `x86_64-apple-darwin`, Linux x86_64 → `x86_64-unknown-linux-musl`, Linux aarch64|arm64 → `aarch64-unknown-linux-musl`; anything else → stderr `cockpit: unsupported platform <os>/<arch>`, exit 1.
5. Binary path `${XDG_DATA_HOME:-$HOME/.local/share}/q-lab/cockpit/bin/<version>/cockpit`; present and executable → `exec` it.
6. Missing → download `$BASE/monitor-v<version>/cockpit-<target>` and `$BASE/monitor-v<version>/SHA256SUMS` with `curl -fsSL` into a `mktemp -d` dir, verify with `shasum -a 256` (macOS) or `sha256sum` (Linux), `chmod +x`, then `mv` into place atomically (same filesystem: download into a temp dir under the bin dir). A lock dir (`mkdir <bin>/<version>.lock`) prevents two concurrent downloads; a stale lock older than 120 s is removed.
7. First argument `hook` and binary missing → start step 6 in the background (`nohup … &`, output to `/dev/null`) and `exit 0` with no output.
8. Any other subcommand → run step 6 in the foreground with a 30 s total budget; on failure print one line `cockpit: binary for <version>/<target> unavailable (<reason>); retry later or set COCKPIT_BIN` to stderr and exit 1.

## 8. Contract launcher (`packages/monitor/skills/cockpit/contract/launcher.ts`)

```ts
export type Proc = "server" | "channel" | "cli" | "hook";
// argv excludes the subcommand word for server/channel; for cli it starts with the
// subcommand ("log", "wait", …); for hook it is ["session-start"] or ["stop"].
export function command(proc: Proc, argv: string[]): string[];
export const underTest: "ts" | "rust"; // while the TS scripts exist: "rust" iff COCKPIT_BIN is set; after they are deleted: always "rust"
```

- `COCKPIT_BIN` set → `[COCKPIT_BIN, "server"|"channel"|..., ...argv]`, with `hook` → `[COCKPIT_BIN, "hook", ...argv]`.
- Unset, while the TS scripts exist → `["bun", <scripts>/cockpit-server.ts | cockpit-channel.ts | cockpit.ts | decision-log-start.ts | scribe-nudge.ts, ...]`; `find-session` maps to `find-session.ts`.
- Unset, after the TS scripts are deleted at the end of the rewrite → default to `<repo>/packages/monitor/cockpit-rs/target/release/cockpit`, and fail loudly when that binary is missing.
- **Group names are a contract.** Each port task runs only its own groups against Rust with `bun test <dir> -t "<group>"`, so every `describe` block's name starts with exactly one of these prefixes, and no test lives outside one:

  | File | Groups |
  |---|---|
  | `daemon.contract.test.ts` | `server: startup`, `server: meta` (`/api/token` only), `server: static`, `server: views` (projects, sessions, project-info, design-system), `server: log-stream`, `server: transcript`, `server: broker` (wait/respond/answer-here without a live permission-stream subscriber), `server: inbox` (inbox + send-message), `server: permission`, `server: presence` (wait paths that need a live `/api/permission-stream` subscriber), `server: codex`, `server: opencode` |
  | `channel.contract.test.ts` | `channel: handshake`, `channel: inbox`, `channel: permission`, `channel: lifecycle` (EOF / SIGTERM exit, stub daemon), `channel: spawn` (ensureServer spawns a real server on `COCKPIT_SERVER_PORT`) |

- **A port task may extend its own groups.** When a port task's acceptance names a behavior the contract suite does not cover yet, that task adds the case inside its own group in the contract file, runs it green against TS first (`bun test <file> -t "<group>"` without `COCKPIT_BIN`), then against Rust. It never edits another group. The task lists the contract file as `(modify)`. A deliberate deviation whose output cannot be observed identically is never a contract case and is verified by `cargo test` only (the tailer UTF-8 rule in §3). A deviation that is a known, fixed difference in one value may be a contract case that picks its expectation by `underTest` and asserts everything else identically (the stop hook's CLI path in the headless scribe argv).
- Daemon contract fixtures (registry entries, trail lines, transcripts) are written directly by the test, never through the CLI, so a server group never depends on a CLI port.
  | `cli.contract.test.ts` | `cli: trail` (log, scribe, prep, diagram), `cli: config` (config, nudge), `cli: find-session`, `cli: wait`, `cli: send`, `cli: restart` |
  | `hook.contract.test.ts` | `hook: session-start`, `hook: stop` |
  | `launcher.test.ts` | `harness: launcher` (tests the launcher itself; no port task runs it against Rust) |

- Every contract test runs with a fresh `COCKPIT_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` (temp dirs), fixture Claude/Codex/OpenCode dirs via the `COCKPIT_*` overrides, and a free port. The Rust run also sets `COCKPIT_PLUGIN_ROOT` to the repo's `packages/monitor`.
