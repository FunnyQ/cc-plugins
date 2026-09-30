# CONTRACT-02: Daemon HTTP contract

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Status**: done
> **Models**: dev=opus/high

## Goal

A black-box bun suite that pins every observable behavior of `cockpit server` (startup, `daemon.json`, every route in contracts.md §3, SSE, long-poll sentinels, static serving). It must pass against today's TS daemon, and later the Rust daemon must pass the same suite.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (new) — the suite.
- `packages/monitor/skills/cockpit/contract/fixtures.ts` (modify) — add `seedTrail`, `seedRegistry`, `appendTrail`, and an SSE reader. Keep existing exports unchanged.

## Implementation notes

### Harness you build on (already exists)

`contract/launcher.ts` exports:
- `command(proc, argv)`, `underTest`, `SCRIPTS_DIR`, `PLUGIN_ROOT`.

`contract/fixtures.ts` exports:
- `makeHomes()`, `freePort()`, `baseEnv(h, extra)`
- `makeProviderFixtures(h)`, `fixtureEnv(f)`
- `startDaemon(env, {port})` → `{proc, port, token, base, info}`, `stopDaemon(d)`
- `run(proc, argv, {env, cwd, stdin})` → `{exitCode, stdout, stderr}`
- `readJsonl(path)`, `cleanup(...dirs)`

### Fixtures are written directly, never through the CLI

In Rust mode `run("cli", …)` executes the Rust CLI, which may still be a stub when a server group is ported. So this suite writes every fixture file itself, in the exact on-disk shapes of contracts.md §2:

```ts
// Writes <projectDir>/.cockpit/logs/<sid>.jsonl (one JSON object per line) and returns its path.
export function seedTrail(projectDir: string, sid: string, records: object[]): string;
// Appends one record line to an existing trail.
export function appendTrail(path: string, record: object): void;
// Writes $COCKPIT_HOME/registry.json as {"sessions":[...]}, 2-space indent, no trailing newline.
export function seedRegistry(cockpitHome: string, entries: RegistryEntry[]): void;
```

- Copy record shapes from real TS output: run `bun packages/monitor/skills/cockpit/scripts/cockpit.ts log …` once by hand against a temp `COCKPIT_HOME`, read the resulting line and registry entry, and freeze them as literals in `fixtures.ts`. A `needs_your_call` record carries `type: "decision"`, `needs_your_call: true`, and an `id`.
- `RegistryEntry`: `{provider, project, sessionId, title?, titleResolved?, logPath, lastHeartbeat}`.
- No test in this file calls `run("cli", …)`.

### Rules for the whole suite

- Every `describe` name starts with exactly one group from this list, and no test sits outside a group:
  - `server: startup`
  - `server: meta`
  - `server: static`
  - `server: views`
  - `server: log-stream`
  - `server: transcript`
  - `server: broker`
  - `server: inbox`
  - `server: permission`
  - `server: presence`
  - `server: codex`
  - `server: opencode`
- Port tasks will run `bun test <file> -t "server: meta"`. Each group must therefore do its own setup in its own `beforeAll`/`afterAll`, one daemon per group, and pass when run alone.
- Shrink every long-poll with env overrides so the suite finishes in under ~60 s:
  - `COCKPIT_WAIT_TIMEOUT_MS=1500`
  - `COCKPIT_STASH_TTL_MS=2000`
  - `COCKPIT_TAIL_POLL_MS=100`
  - `COCKPIT_RESOLVE_POLL_MS=100`
  - `COCKPIT_TRANSCRIPT_GUARD_MS` small
  - `COCKPIT_CHANNEL_TTL_MS` small
- Assert on status code, `Content-Type`, `Cache-Control`, and parsed JSON. Where a JSON key set matters (for example `daemon.json`), compare the sorted key lists. Where a value is volatile (timestamps, tokens), assert its type, not its value.
- Discover each handler's exact behavior (query param names, body shapes, status codes, SSE event names) by reading the TS module named per route in contracts.md §3. The suite pins what TS does today, even where that looks odd. When a TS behavior looks like a bug, pin it anyway and add a one-line `// pins TS quirk: …` comment.
- SSE reading: `fetch` the URL, read `res.body` with a reader, split on `\n\n`, stop after N events or a 5 s deadline, then abort the controller. Do not wait for the 25 s heartbeat.

### Coverage per group (minimum)

- **server: startup**
  - `daemon.json` has exactly the keys `pid`, `port`, `root`, `token`; `root` ends in `/skills/cockpit/scripts`.
  - Reuse: a second launch with the same env and root exits 0 and leaves the first pid alive.
  - Supersede: write a `daemon.json` pointing at a live dummy process (`Bun.spawn(["sleep","30"])`) with a different `root`, launch, and confirm the dummy gets SIGTERMed and `daemon.json` now has the new pid.
  - A dead-pid record means a fresh start.
- **server: meta**
  - `/api/token` returns the token; its status, headers, and body shape match TS.
- **server: views**
  - `/api/projects` and `/api/sessions` are shaped from a `seedRegistry` registry; include one ended/stale session.
  - A Claude session with one `subagents/agent-*.jsonl` fixture next to its transcript reports the subagent count TS reports for it in `/api/sessions` (assert the exact number).
  - `/api/project-info` and `/api/design-system` against `projectDir`, with and without a `DESIGN.md`.
  - Bad or missing token on each of these routes that TS guards returns the TS status and body.
- **server: static**
  - `/` serves `index.html`; an unknown path such as `/no/such/page` returns 404 (TS has no SPA fallback).
  - MIME type is chosen by extension.
  - The `ETag` then `If-None-Match` round trip returns 304.
  - `Accept-Encoding: gzip` on a compressible asset returns `Content-Encoding: gzip`, with a different ETag from the plain response.
  - `Cache-Control: no-cache` is set.
  - `/../../package.json` and an encoded `%2e%2e` traversal are both refused with the TS status.
- **server: log-stream**
  - Open the SSE for a seeded session and get the backlog events.
  - `appendTrail` one record and get a new event within 2 s.
  - A missing session or a bad param returns the TS 400 JSON.
- **server: transcript**
  - `/api/transcript/history` paging for the Claude fixture: first page, then a cursor page.
  - `/api/transcript/stream` for the Claude fixture: backlog, plus an event after appending a line to the fixture JSONL.
  - The same, one assertion each, for the Codex rollout and OpenCode fixtures.
- **server: broker** — no test here opens `/api/permission-stream`. Every wait below carries `require_watcher=1` unless it says otherwise.
  - Without `require_watcher=1`, `/api/wait` parks and returns `{timeout:true}` after the shrunken budget even with `answer_here` off (the gate is opt-in).
  - With `answer_here` off, the wait returns `{not_watching:true, reason}`.
  - With `answer_here` on but no subscriber, the wait returns `{not_watching:true, reason}` with the TS reason.
  - A stash drain works: respond first, then wait within the TTL, and the answer is delivered (the drain runs before the presence gate).
  - A superseded call is reported the TS way (the superseded check runs before the presence gate).
  - A POST to `/api/respond` appends a `response` line whose `call` equals the open call id, with the TS status and body.
  - `/api/answer-here`: GET returns the default; POST toggles and persists to `$XDG_CONFIG_HOME/q-lab/cockpit/config.json`.
- **server: presence** — each test opens `/api/permission-stream?session=…&token=…` itself and keeps it open while waiting; every wait carries `require_watcher=1`.
  - With `answer_here` on and the subscriber live, `/api/wait` parks and returns `{timeout:true}` after the shrunken budget.
  - A POST to `/api/respond` wakes the parked wait with the answer, and the trail gains the `response` line.
  - Two sessions, each with its own subscriber, never cross-talk.
  - Closing the subscriber makes the next wait return `not_watching`.
- **server: inbox**
  - A parked `/api/inbox?session=&token=` poll receives a message POSTed to `/api/send-message`.
  - A message sent with nobody parked is stashed, then delivered on the next poll within the TTL.
  - With nobody polling, `send-message` reports "no channel" the TS way.
  - Timeout returns `{timeout:true}`.
- **server: permission**
  - A POST to `permission-request` is pushed on `permission-stream`.
  - A POST to `permission-verdict` resolves a parked `permission-pull` with `{request_id, behavior}`.
  - A POST to `permission-resolved` withdraws the request from the stream the TS way.
  - An abandoned request returns `{abandoned:true}`.
- **server: codex**
  - `/api/codex-control/status` with no Codex socket and no `codex` binary reachable returns the TS "unavailable" shape. Point `COCKPIT_CODEX_DIR` at the fixture and put a PATH without `codex` in `env`.
  - `/api/send-codex-message` in that state returns the TS error status and body.
- **server: opencode**
  - `/api/opencode-control/status` with no TUI server returns the TS unavailable shape. Clear the `OPENCODE_*` env vars and put first on `PATH` a `ps` stub that prints only a header line, so a real opencode TUI on the runner's machine is never discovered. Every `server: opencode` case uses that stub; discovery sees only the candidates the case provides.
  - Against a stub `Bun.serve` answering `GET /global/health` (200, JSON `{"healthy":true}`), `GET /session/<id>` (200, JSON `{"id":"<id>","directory":"<projectDir>"}`), `POST /tui/append-prompt` (200, JSON `true`) and `POST /tui/submit-prompt` (200, JSON `true`), with `OPENCODE_TUI_SERVER_URL` pointing at it, a POST to `/api/send-opencode-message` delivers the text: assert the stub saw health → session → append → submit in that order, with the text.
  - The same stub answering `GET /session/<id>` with 404 makes the send report `OpenCode session not found` the TS way.

## Acceptance criteria

- [x] `daemon.contract.test.ts` has all 12 `server: *` groups, and every test sits inside one of them.
- [x] Every route in contracts.md §3's table is exercised at least once, plus the static 404 for an unknown path.
- [x] No test calls `run("cli", …)`; all fixtures come from `seedTrail`, `appendTrail`, `seedRegistry`, or the provider fixtures, and no `server: broker` test opens `/api/permission-stream`.
- [x] Failure paths are asserted: bad token, `{timeout:true}`, `{not_watching:true}`, `{abandoned:true}`, 304, gzip, traversal refused, dead-pid start, supersede.
- [x] Each group passes when run alone with `-t "server: <group>"`.
- [x] The suite passes against TS in under 90 s and leaves no daemon process running.
- [x] No test touches the real home, the real XDG dirs, or port 5858.
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` passes (`COCKPIT_BIN` unset).
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: broker"` passes on its own.
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: static"` passes on its own.
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: presence"` passes on its own.
- [x] `grep -c 'run("cli"' packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` prints `0`.
- [x] `pgrep -f 'cockpit-server.ts --no-open --port' ; test $? -eq 1` after the run (no leaked daemon).
- [x] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Eval rubric

> Scale 0–5 (see `../_context/rubric.md`); weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Suite fails against TS, or asserts behavior TS does not have | Green, but some assertions are so loose (status-only) that a wrong Rust body would pass | Green against TS; assertions pin status, headers, and body shape tightly enough that a divergent reimplementation fails |
| Test coverage | ×2 | Only happy paths for a few routes | Every route touched, but failure paths or SSE follow-up events are missing | Every route plus every sentinel, auth failure, static edge, and startup branch covered |
| Interface & readability | ×1 | One giant test with shared mutable state across groups | Groups exist but depend on each other's state | Each group is self-contained, filterable with `-t`, and reads as a spec of the route |
| Assumptions & docs | ×1 | Quirks pinned silently | Some quirks commented | Every pinned TS quirk carries a `// pins TS quirk:` line; env shrink values are explained |

## Out of scope

- Channel, CLI, and hook contracts. Reason: they are separate suites with their own groups.
- Real Codex app-server or real OpenCode TUI delivery. Reason: those need live processes; a person checks them by hand later.
- Fixing any TS bug found. Reason: the suite pins today's behavior; report the bug in the task notes instead.
