# CONTRACT-01: Launcher harness

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: contract/02, contract/03, contract/04
> **Status**: done

## Goal

A bun test harness that launches either the TS cockpit scripts or the Rust `cockpit` binary through one API. Every contract suite is written once and runs against both implementations.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/launcher.ts` (new): implementation switch and argv builder.
- `packages/monitor/skills/cockpit/contract/fixtures.ts` (new): temp homes, free port, provider fixture dirs, daemon start/stop.
- `packages/monitor/skills/cockpit/contract/launcher.test.ts` (new): smoke test of the harness in TS mode.

## Implementation notes

### launcher.ts

Implement exactly this API:

```ts
export type Proc = "server" | "channel" | "cli" | "hook";
export const underTest: "ts" | "rust"; // "rust" iff process.env.COCKPIT_BIN is set (non-empty)
export function command(proc: Proc, argv: string[]): string[];
export const SCRIPTS_DIR: string;  // absolute packages/monitor/skills/cockpit/scripts
export const PLUGIN_ROOT: string;  // absolute packages/monitor (resolved from import.meta.dir)
```

- `argv` excludes the subcommand word for `server` and `channel`.
- For `cli`, `argv` starts with the subcommand (`log`, `scribe`, `prep`, `config`, `wait`, `send`, `restart`, `nudge`, `find-session`).
- For `hook`, `argv` is `["session-start"]` or `["stop"]`.
- **Rust mode** (`COCKPIT_BIN` set):
  - `server`: `[BIN, "server", ...argv]`
  - `channel`: `[BIN, "channel", ...argv]`
  - `cli`: `[BIN, ...argv]`
  - `hook`: `[BIN, "hook", ...argv]`
- **TS mode**, where `S = SCRIPTS_DIR`:
  - `server`: `["bun", S/cockpit-server.ts, ...argv]`
  - `channel`: `["bun", S/cockpit-channel.ts, ...argv]`
  - `cli` with `find-session`: `["bun", S/find-session.ts, ...rest]`
  - `cli` with anything else: `["bun", S/cockpit.ts, ...argv]`
  - `hook session-start`: `["bun", S/decision-log-start.ts]`
  - `hook stop`: `["bun", S/scribe-nudge.ts]`
  - Throw on an unknown hook name.

### fixtures.ts

Build this on the patterns in the existing `scripts/broker.test.ts` and `scripts/cockpit-bridge.test.ts`:
- temp dirs via `realpathSync(mkdtempSync(join(tmpdir(), "cockpit-…-")))`
- a random port
- a `waitForReady` loop polling every 50 ms, up to 100 tries — but probe `GET /api/token`, not `/api/sessions` as those tests do, because the Rust server foundation serves `/api/token` before any views route exists

Exports:

```ts
export type Env = Record<string, string>;
export type Homes = { cockpitHome: string; configHome: string; dataHome: string; root: string /* parent tmp dir */ };
export function makeHomes(): Homes;                       // fresh temp dirs
export async function freePort(): Promise<number>;        // bind 127.0.0.1:0 via Bun.listen, read port, close
export function baseEnv(h: Homes, extra?: Env): Env;      // see env rules below
export type ProviderFixtures = {
  claudeProjectsDir: string; claudeSessionsDir: string;
  codexDir: string; codexStateDb: string; codexSessionsDir: string;
  opencodeDb: string; projectDir: string; claudeSessionId: string;
  codexThreadId: string; opencodeSessionId: string;
};
export function makeProviderFixtures(h: Homes): ProviderFixtures;
export function fixtureEnv(f: ProviderFixtures): Env;     // the COCKPIT_* overrides pointing at f
export type Daemon = { proc: Subprocess; port: number; token: string; base: string; info: any };
export async function startDaemon(env: Env, opts?: { port?: number }): Promise<Daemon>;
export async function stopDaemon(d: Daemon): Promise<void>;
export function run(proc: Proc, argv: string[], opts: { env: Env; cwd?: string; stdin?: string }):
  { exitCode: number; stdout: string; stderr: string };   // Bun.spawnSync(command(proc, argv), …)
export function readJsonl(path: string): any[];           // tolerant: skips blank/corrupt lines
export function cleanup(...dirs: string[]): void;         // rmSync recursive force
```

**`baseEnv`**:
- Starts from `process.env`, then deletes every variable that would let the runner's own session leak into a case: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PROJECT_DIR`, `PLUGIN_ROOT`, `RELAY_DELEGATED`, `Q_DELEGATION_HOME`, every `OPENCODE_*`, and every `COCKPIT_*` except `COCKPIT_BIN` and `COCKPIT_PLUGIN_ROOT`. A case that needs one of them passes it in `extra`. Add a launcher test that runs with `CLAUDE_CODE_SESSION_ID` and `RELAY_DELEGATED=1` set in the parent and proves neither reaches the child.
- Sets `COCKPIT_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to the temp homes.
- Sets `HOME` to `h.root`, so the legacy `~/.cockpit` migration and the `~/.claude` fallbacks never touch the real home.
- In Rust mode, also sets `COCKPIT_PLUGIN_ROOT = PLUGIN_ROOT`.
- Merges `extra` last.

**`makeProviderFixtures`** creates, under `h.root`:
- **Claude**: `claude/projects/<encoded projectDir>/<claudeSessionId>.jsonl` with 3 transcript lines (a user message, an assistant text message and an assistant tool_use), plus `claude/sessions/<pid>.json`. Use Claude Code's path encoding: `/` and `.` → `-`. Copy the encoding from `find-session.ts`.
- **Codex**: `codex/state_5.sqlite`, built with `bun:sqlite`, holding a `threads` table with one row for `projectDir`. Copy the column names and types the TS readers query in `codex-db.ts`, `live-sessions.ts`, `find-session.ts` and `session-title.ts`. Also a rollout JSONL under `codex/sessions/` that the row points to.
- **OpenCode**: `opencode/opencode.db`, built with `bun:sqlite`, with one session row and one message row. Copy the tables and columns queried in `shared/scripts/opencode.ts` and the transcript reader in `transcript-stream.ts`.
- `projectDir`: a temp project dir containing `.git/` (made with `git init -q`), so log-root resolution has a git root.

**`fixtureEnv`** returns:
- `COCKPIT_CLAUDE_PROJECTS_DIR`
- `COCKPIT_CLAUDE_SESSIONS_DIR`
- `COCKPIT_CODEX_DIR`
- `COCKPIT_CODEX_STATE_DB`
- `COCKPIT_CODEX_SESSIONS_DIR`
- `COCKPIT_OPENCODE_DB`

**`startDaemon`**:
1. Spawn `command("server", ["--no-open", "--port", String(port)])` with `env`, stdout and stderr piped.
2. Poll until `$COCKPIT_HOME/daemon.json` exists with a matching `port`, and `GET /api/token` returns `ok` (the first route the server foundation serves). Allow up to 10 s.
3. Return the parsed `daemon.json` as `info`.

**`stopDaemon`**: SIGTERM the process, await its exit for up to 3 s, then SIGKILL.

Fixture shapes must be the minimum the TS readers accept. Read those readers; do not invent columns.

### launcher.test.ts

- One `describe("harness: launcher", …)`. This harness-only group is exempt from the §8 group table because it tests no cockpit behavior.
- Assert `command()` output for every `Proc` in the current mode.
- Assert that `makeProviderFixtures` produces files that `bun find-session.ts --provider claude <projectDir>` (run with `fixtureEnv`) resolves to `claudeSessionId`. Assert the same for the `codex` and `opencode` providers with their ids.
- Assert that `startDaemon` then `stopDaemon` leaves no live pid.

## Acceptance criteria

- [x] `launcher.ts` exports exactly the API above, and `underTest` is `"rust"` only when `COCKPIT_BIN` is non-empty.
- [x] In TS mode, `command()` maps every `Proc` and every CLI subcommand, including `find-session`, to the TS script listed above.
- [x] `makeProviderFixtures` output resolves through `find-session.ts` for all three providers.
- [x] `startDaemon` returns a `daemon.json` with numeric `pid` and `port`, a string `token`, and a `root` ending in `/skills/cockpit/scripts`. `stopDaemon` leaves that pid dead.
- [x] No test reads or writes the real `~/.local/share/q-lab/cockpit`, `~/.config/q-lab`, `~/.claude`, `~/.codex`, or port 5858.
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/contract/launcher.test.ts` passes (TS mode, `COCKPIT_BIN` unset).
- [x] `bun test packages/monitor/skills/cockpit/contract/` passes.
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.
- [x] `git status --short -- packages/monitor/skills/cockpit/contract/` lists `launcher.ts`, `fixtures.ts`, `launcher.test.ts`.

## Eval rubric

> Scale 0–5 (see `../_context/rubric.md`); weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong script mapping, or fixtures the TS readers reject | Mapping right, but a provider fixture fails to resolve or a leak into the real home is possible | Every mapping matches the spec; all 3 providers resolve; homes are fully isolated |
| Test coverage | ×2 | No smoke test | Mapping tested; fixtures or the daemon lifecycle untested | Mapping, fixtures for 3 providers, and daemon start/stop all asserted |
| Interface & readability | ×1 | Suites would have to re-implement spawning | API usable but typed loosely (`any` everywhere) | Small, typed API that later suites can call without reading its internals |
| Assumptions & docs | ×1 | Fixture columns invented with no source | Columns right but the source reader not named | Each fixture's shape names the TS reader it satisfies in a one-line comment |

## Out of scope

- The contract suites themselves (daemon, channel, CLI, hooks). Reason: separate tasks build on this harness.
- Any Rust code. Reason: this task writes no Rust; each process port is gated by its own contract-group dependency.
