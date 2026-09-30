# CONTRACT-03: Channel MCP contract

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01
> **Status**: todo

## Goal

A black-box bun suite that drives `cockpit channel` over real stdio JSON-RPC against a stub daemon. It pins the handshake, the inbox → notification path, the permission relay in both directions, and the process lifecycle. It must pass against today's TS channel, and later the Rust channel must pass the same suite.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/channel.contract.test.ts` (new): the suite.
- `packages/monitor/skills/cockpit/contract/fixtures.ts` (modify, only if needed): add a `StubDaemon` helper and an MCP stdio client helper when they are cleaner there. Keep the existing exports unchanged.
- `packages/monitor/skills/cockpit/scripts/cockpit-server.ts` (modify): `parsePort()` falls back to `COCKPIT_SERVER_PORT` before `DEFAULT_PORT` when `--port` is absent, so the spawn test can run on a free port.

## Implementation notes

### Harness you build on (already exists)

`contract/launcher.ts` exports `command(proc, argv)`, `underTest`, `SCRIPTS_DIR`, `PLUGIN_ROOT`.

`contract/fixtures.ts` exports:
- `makeHomes()`, `freePort()`, `baseEnv(h, extra)`
- `makeProviderFixtures(h)`, `fixtureEnv(f)`
- `startDaemon`, `stopDaemon`, `run`, `readJsonl`, `cleanup`

### Spawning the channel

- Run `Bun.spawn(command("channel", []), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env })`.
- Set `CLAUDE_CODE_SESSION_ID=<fixed uuid>` in `env`. This makes session resolution deterministic; the first resolution rule wins.
- **Framing**: newline-delimited JSON-RPC 2.0. That is the MCP stdio transport both the TS SDK and rmcp use. Write one JSON object plus `\n` per message. Read stdout line by line.
- Write a small client helper: `request(method, params)` returns a promise of the result, matched by `id`; `notify(method, params)`; and `nextNotification(method, timeoutMs)`.

### `COCKPIT_SERVER_PORT` in the TS server

The channel spawns `cockpit-server.ts --no-open` with no `--port`, and today `parsePort()` in `cockpit-server.ts` then returns `DEFAULT_PORT` (5858). Change only its final fallback:

```ts
// before
return DEFAULT_PORT;
// after — env override, same validity rule as --port
const envPort = parseInt(process.env.COCKPIT_SERVER_PORT || "", 10);
return Number.isFinite(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_PORT;
```

`--port` still wins. `ensureServer` in `cockpit-channel.ts` spawns `bun <server> --no-open` with `{detached: true, stdio: "ignore"}` and no `env` option, so the server inherits the channel's environment and `COCKPIT_SERVER_PORT` set on the channel reaches it.

### Stub daemon

- A `Bun.serve` on a free port inside the test. It records every request (method, path, query, JSON body) in an array. Implement:
  - `GET /api/inbox`: parks until the test pushes a message, then returns the same JSON the real `inbox.ts` handler returns for a delivered message (read `inbox.ts` for the shape). Returns `{"timeout":true}` after about 500 ms when nothing is pushed.
  - `POST /api/permission-request`: records the body and returns what `permission.ts` returns.
  - `GET /api/permission-pull`: parks until the test pushes a verdict, then returns `{request_id, behavior}` in the `permission.ts` shape. Otherwise returns `{"timeout":true}` after about 500 ms.
  - `POST /api/permission-resolved`: records the body and returns what `permission.ts` returns.
- Write `$COCKPIT_HOME/daemon.json` as `{"pid": process.pid, "port": <stub port>, "token": "<test token>", "root": "/unversioned/test/root"}`.
  - The test process's pid is alive.
  - An unversioned root cannot be ordered, so the channel reuses this daemon and never spawns a server. That rule comes from `cockpit-channel.ts` `shouldSupersedeDaemon`: no version → reuse.
- Every request to the stub carries the test token, in the query or the body, exactly as `cockpit-channel.ts` sends it. Assert that.

### Groups (every `describe` starts with one of these; each group passes alone with `-t`)

- **channel: handshake**
  - `initialize` with protocol version `2025-06-18`, `capabilities: {}`, and `clientInfo`. The result's `serverInfo` is `{name:"cockpit-channel", version:"0.0.1"}`.
  - The whole `capabilities` object deep-equals `{ "experimental": { "claude/channel": {}, "claude/channel/permission": {} }, "tools": {} }` — no extra keys at any level.
  - `capabilities.tools` is present.
  - `instructions` equals the `CHANNEL_INSTRUCTIONS` string in `cockpit-channel.ts`. Copy it into the test as a literal.
  - After `notifications/initialized`, `tools/list` returns `{tools: []}`.
  - `ping` returns `{}`.
- **channel: inbox**
  - Push 2 messages through the stub. Two `notifications/claude/channel` arrive in order, each with `params` `{content:"<text>", meta:{source:"cockpit"}}`.
  - The stub saw `GET /api/inbox` with `session=<uuid>` and the token.
  - After a `{timeout:true}` reply, the channel re-polls: at least 2 inbox requests within 3 s, and none sooner than 1 s apart after a timeout. This pins the 1 s floor.
- **channel: permission**
  - Send the client notification `notifications/claude/channel/permission_request` with the params shape `cockpit-channel.ts` expects (read `PermissionRequestSchema`). The stub then records `POST /api/permission-request` with the forwarded fields.
  - Pushing a verdict `{request_id, behavior:"allow"}` through the stub produces the server notification `notifications/claude/channel/permission` with `{request_id, behavior:"allow"}`.
  - Sending one of the cancel methods listed in `PERMISSION_CANCEL_METHODS` makes the stub record `POST /api/permission-resolved`.
  - An undocumented `notifications/claude/channel/permission_foo` is also forwarded as resolved. That is the fallback handler.
  - A non-permission unknown notification is ignored: no stub request, and the process stays alive.
- **channel: lifecycle** — against the stub daemon only; never spawns a server.
  - Closing stdin makes the process exit with code 0 within 3 s.
  - SIGTERM makes it exit within 3 s.
  - When the stub daemon is unreachable (a `daemon.json` with a live pid but a closed port), the channel keeps running and retries with backoff. It does not exit within 3 s.
- **channel: spawn** — the one group that needs a real server behind the channel.
  - With no `daemon.json` in a temp `COCKPIT_HOME`, start the channel with `COCKPIT_SERVER_PORT=<freePort()>`. `daemon.json` appears within 10 s with a live pid and `port` equal to that free port, and `GET http://127.0.0.1:<port>/api/token` answers.
  - Never rely on 5858: the test fails, not skips, when `daemon.json.port` is anything but the chosen port.
  - Afterwards, SIGTERM the spawned pid from `daemon.json`, close the channel, and assert that pid is gone.

### Pinning rules

- Where TS behavior looks odd, pin it and add a `// pins TS quirk: …` comment.
- Timeouts: every wait has a deadline of 5 s or less, so a Rust regression fails fast instead of hanging. One exception: `channel: spawn` waits up to 10 s for `daemon.json`, because it covers a detached process start.

## Acceptance criteria

- [ ] `channel.contract.test.ts` has the 5 `channel: *` groups, and every test sits inside one of them.
- [ ] The handshake asserts `serverInfo`, both experimental capability keys, `tools`, `instructions`, the empty `tools/list`, and `ping`.
- [ ] Inbox ordering, the notification `params` shape, the token and session on requests, and the re-poll floor are asserted.
- [ ] The permission relay is asserted in both directions, plus the cancel list, the undocumented-permission fallback, and ignored unknown notifications.
- [ ] `channel: lifecycle` asserts EOF exit 0, SIGTERM exit, and survival while the daemon is unreachable, all against the stub.
- [ ] `channel: spawn` asserts `ensureServer` started a server on the `COCKPIT_SERVER_PORT` free port, and no test in the file binds or probes 5858.
- [ ] `cockpit-server.ts --no-open` with `COCKPIT_SERVER_PORT` set and no `--port` binds that port; with `--port` also given, `--port` wins.
- [ ] The suite passes against TS, each group also passes alone with `-t`, and no spawned server or channel survives the run.
- [ ] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Verification

- [ ] `bun test packages/monitor/skills/cockpit/contract/channel.contract.test.ts` passes (`COCKPIT_BIN` unset).
- [ ] `bun test packages/monitor/skills/cockpit/contract/channel.contract.test.ts -t "channel: handshake"` passes on its own.
- [ ] `bun test packages/monitor/skills/cockpit/contract/channel.contract.test.ts -t "channel: spawn"` passes on its own.
- [ ] `pgrep -f cockpit-channel.ts; test $? -eq 1` after the run (no leaked channel).
- [ ] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/scripts/cockpit-server.ts` prints nothing.
- [ ] `bunx --bun tsc --noEmit | grep packages/monitor/skills/cockpit/contract/` prints nothing.

## Eval rubric

> Scale 0–5 (see `../_context/rubric.md`); weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Fails against TS, or talks to the channel through the SDK instead of raw stdio | Green, but the capability or notification shapes are only loosely checked | Green against TS; exact method names, param shapes, and capability keys pinned over raw stdio |
| Test coverage | ×2 | Handshake only | Handshake + inbox; permission, lifecycle, or spawn is thin | All 5 groups, including the fallback handler, backoff survival, and `ensureServer` spawn on a free port |
| Interface & readability | ×1 | Ad-hoc string parsing everywhere | A client helper exists but hides failures | A small typed JSON-RPC client and stub daemon that a reader can follow; deadlines on every wait |
| Assumptions & docs | ×1 | Stub responses invented | Stub shapes right but unsourced | Each stub response names the TS handler it mimics; pinned quirks commented |

## Out of scope

- The real daemon's inbox and permission routes. Reason: the daemon suite covers them; this suite isolates the channel with a stub.
- A real Claude Code session. Reason: a person checks end-to-end delivery by hand later.
