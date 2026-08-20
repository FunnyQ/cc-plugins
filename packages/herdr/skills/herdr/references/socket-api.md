# Herdr Socket API

This document is verified against herdr 0.8.2, protocol 20. If live output disagrees with this doc, trust `herdr api schema --json`.

Herdr's control surface is a Unix domain socket. The `herdr` CLI is a thin client over it. Every subcommand opens the socket, sends one request, prints the response, and exits.

## Prefer the CLI

Reach for the socket only when you have a reason from the next section. Otherwise use `cli.md`.

Most CLI commands return the socket response verbatim. `pane read` and `agent read` are exceptions: the CLI unwraps and prints terminal text, while the socket returns it at `result.read.text`. Errors match across both surfaces:

```
CLI     {"error":{"code":"agent_not_found","message":"agent target nope not found"},"id":"cli:agent:get"}   exit 1
socket  {"id":"1","error":{"code":"agent_not_found","message":"agent target nope not found"}}
```

Apart from read envelopes and event streaming, a client that already parses the CLI's JSON gains no field, error code, or detail by switching transports. It gains latency, and it takes on the framing rules below.

## Use the socket for these three

1. **`events.subscribe`.** There is no `herdr events` subcommand. Event streaming exists only here. See "Events" below.
2. **A long-lived process making many calls.** One round trip costs ~1–3 ms versus ~7–9 ms for a CLI spawn. This only pays back at hundreds of calls; a poller on a multi-second interval will never notice.
3. **A process that cannot spawn children.** The socket needs no `herdr` binary on `PATH`.

Weigh one cost against all three. `HERDR_SOCKET_PATH` is a Unix domain socket on Linux and macOS, and a named pipe on Windows. A client that hardcodes Unix-socket semantics is not portable, which is why `plugin-development.md` points at `HERDR_BIN_PATH` for plugins that must run everywhere.

Single-machine medians over 20 warmed iterations, for scale rather than as a promise:

| Call | Socket | CLI |
|---|---|---|
| `ping` | 0.08 ms | — |
| `agent.list` | 0.92 ms | 7.39 ms |
| `pane.list` | 2.70 ms | 9.02 ms |

## Transport

Read the address from `HERDR_SOCKET_PATH`. It is injected into every herdr pane and every plugin process, and resolves to `~/.config/herdr/herdr.sock`. Never hardcode the path.

The wire format is newline-delimited JSON.

**Send exactly one request per connection.** The server answers the first line and closes. Verified twice: two requests written in one payload produce one response; a second request written 150 ms after the first reply gets nothing, because the connection is already closed. There is no pipelining and no keep-alive.

**Accumulate reads until you see a `\n`.** A response is not one chunk. `pane.list` arrived as 10,060 bytes across 2 reads. A client that parses the first chunk works until it doesn't.

Connect, write one line, read to the newline, close.

## Envelope

Send `id`, `method`, and `params`. All three are required — omitting `params` on a no-argument call fails:

```json
{"id":"1","method":"ping","params":{}}
```

```
{"id":"","error":{"code":"invalid_request","message":"invalid request: missing field `params` at line 1 column 26"}}
```

Success returns the request's `id` and a `result` whose `type` names the variant:

```json
{"id":"1","result":{"type":"pong","version":"0.8.2","protocol":20,
  "capabilities":{"live_handoff":true,"detached_server_daemon":true}}}
```

Errors return `code` and `message`, both required:

```json
{"id":"1","error":{"code":"agent_not_found","message":"agent target nope not found"}}
```

CLI socket commands use `server_not_running` when no compatible server is available. Alternate-screen history reads can use `agent_not_idle` when the target is not safe to scroll. `agent.prompt` returns `agent_blocked` when the target already waits at an approval or question dialog; it sends no text and starts no wait. A prompt that herdr accepted but that produced no lifecycle change within five seconds returns `agent_prompt_stalled`.

**Do not key error handling on `id`.** A request that fails to deserialise comes back with `id: ""`, because the server never read the id.

Gate on `ping` before assuming a shape. Protocol 20 is current here. Treat a supported protocol as a minimum floor unless your client has a verified reason to reject additive future protocols.

**Upgrading the binary does not upgrade the socket.** The server keeps running the version it started with, so `ping` reports the old protocol until it restarts or hands off. Compare `herdr status` client and server versions before you trust a new method. `agent.explain` is the usual casualty: it classifies against the *server's* manifest cache, so a stale server explains with stale rules.

## Methods

There are 91 methods: `agent.*` (12), `client.*` (2), `events.*` (2), `integration.*` (2), `layout.*` (3), `notification.show`, `pane.*` (30), `ping`, `plugin.*` (11), `popup.close`, `server.*` (5), `session.snapshot`, `tab.*` (7), `workspace.*` (9), `worktree.*` (4). Protocol 20 adds `pane.input.set` with `{pane_id, right_click}` for right-click routing.

Each CLI subcommand maps to the dotted method of the same name, with flags becoming params. The mapping for the calls `scripts/herd.ts` makes:

| CLI | Method | Params |
|---|---|---|
| `agent list` | `agent.list` | `{}` |
| `agent get <t>` | `agent.get` | `{target}` |
| `agent start <n> --kind K --pane P -- ARGS` | `agent.start` | `{name, kind, pane_id, args, timeout_ms}` |
| `agent prompt <t> <text> [--wait --until S]` | `agent.prompt` | `{target, text, wait:{until:[…], timeout_ms}}` |
| `agent wait <t> --until S --timeout MS` | `agent.wait` | `{target, until:[…], timeout_ms}` |
| `agent read <t> --source S --lines N` | `agent.read` | `{target, source, lines, format, strip_ansi}` |
| `agent send-keys <t> K…` | `agent.send_keys` | `{target, keys}` |
| `pane split --direction D` | `pane.split` | `{direction, target_pane_id, workspace_id, cwd, env, ratio, right_click, focus}` |
| `pane read <id> --source S` | `pane.read` | `{pane_id, source, lines, format, strip_ansi}` |
| `pane send-keys <id> K…` | `pane.send_keys` | `{pane_id, keys}` |
| `pane run <id> <cmd>` | `pane.send_input` | `{pane_id, text, keys}` |
| `pane close <id>` | `pane.close` | `{pane_id}` |
| `pane list` | `pane.list` | `{workspace_id}` |
| `tab create` | `tab.create` | `{workspace_id, label, cwd, env, focus}` |
| `tab list` / `focus` | `tab.list` / `tab.focus` | `{workspace_id}` / `{tab_id}` |

Note the shape changes, not just the names. `--env K=V` repeated becomes an `env` **object**. `--until` repeated becomes an `until` **array**. `-- ARGS` becomes `args`. `--no-focus` becomes `focus: false`, which is already the default. On `agent.prompt` the wait flags **nest**: `--wait --until S --timeout MS` becomes one `wait: {until:[…], timeout_ms}` object, and `--wait` alone becomes `wait: {}`. Passing `until` or `timeout_ms` at the top level is a deserialisation error, not a wait.

`pane.input.set` takes `{pane_id, right_click}` and routes one pane's right-click gestures. Send `right_click: "pane"` to forward unmodified hold and drag gestures to a mouse-reporting application. Send `right_click: "herdr"` to restore Herdr's pane menu. Right-clicking the pane frame always opens Herdr's menu. `pane.split` takes the same `right_click` for the pane it creates, defaulting to `herdr`.

Result variants you will unwrap: `agent_list.agents`, `agent_info.agent`, `agent_started.agent`, `pane_list.panes`, `pane_info.pane`, `pane_read.read`, `tab_created.{tab,root_pane}`, `workspace_created.{workspace,tab,root_pane}`, `wait_matched.event`. `PaneReadResult.truncated` is required and reports when older rows were omitted. Simple mutations return `{"type":"ok"}`.

## Enum spellings differ from the CLI

This is the trap. The CLI accepts hyphens; the socket accepts only the underscored variant.

| Enum | Socket values | CLI spelling that differs |
|---|---|---|
| `ReadSource` | `visible`, `recent`, `recent_unwrapped`, `detection` | `recent-unwrapped` |
| `AgentStatus` | `idle`, `working`, `blocked`, `done`, `unknown` | same |
| `SplitDirection` | `right`, `down` | same |
| `ReadFormat` | `text`, `ansi` | same |
| `PaneRightClickTarget` | `herdr`, `pane` | same |

Passing the CLI spelling returns a deserialisation error, not a friendlier one:

```
{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `recent-unwrapped`, expected one of `visible`, `recent`, `recent_unwrapped`, `detection` at line 1 column 87"}}
```

The `keys` array has no enum in the schema, so its vocabulary is not discoverable. `enter`, `Enter`, and `return` work. `cr` is rejected with `invalid_key`.

## Events

`events.subscribe` is the one capability with no CLI equivalent. It is also the one method that breaks the one-request rule: the server replies once, then **holds the connection open** and streams event lines until you close it.

```json
{"id":"e","method":"events.subscribe","params":{"subscriptions":[
  {"type":"pane.agent_status_changed","pane_id":"w2P:p1"},
  {"type":"pane.updated"}
]}}
```

`subscriptions` is a list of internally-tagged objects, not a list of strings. The first reply confirms the subscription:

```json
{"id":"e","result":{"type":"subscription_started"}}
```

Every line after it is an event, and **carries no `id`**:

```json
{"event":"pane.agent_status_changed",
 "data":{"agent":"claude","agent_status":"working","pane_id":"w2P:p1","workspace_id":"w2P"}}
```

A client that routes lines by `id` will drop every event. Route on the presence of `event` instead.

Topics: `workspace.created|updated|metadata_updated|renamed|moved|reordered|closed|focused`, `worktree.created|opened|removed`, `tab.created|closed|focused|renamed|moved`, `pane.created|closed|updated|focused|moved|exited|agent_detected|agent_status_changed|scroll_changed|output_matched`, `layout.updated`.

Most topics take no extra fields. Three do:

| Topic | Required | Optional |
|---|---|---|
| `pane.agent_status_changed` | `pane_id` | `agent_status` |
| `pane.scroll_changed` | `pane_id` | |
| `pane.output_matched` | `pane_id`, `source`, `match` | `lines`, `strip_ansi` |

Expect volume. A subscription to `pane.updated` on an active session produced 31 lines in 6 seconds.

Use `events.wait` for a single event instead of a stream. It takes `{match_event, timeout_ms}` and returns `wait_matched`. Its `match_event` uses **past-tense underscored** kinds (`pane_agent_status_changed`), not the dotted subscription topics.

## Regenerating the schema

```bash
herdr api schema --json                 # full JSON Schema to stdout
herdr api schema --output PATH
```

The document has `protocol`, `schema_version`, and a `schemas` object with five members: `request`, `success_response`, `error_response`, `event`, `subscription_event`. Request params live under `schemas.request.$defs`; result variants live under `schemas.success_response.$defs.ResponseResult`.
