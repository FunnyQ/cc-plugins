# Token-Atlas LIVE Research

Research date: 2026-05-21

Goal: identify reliable data sources for a Token-Atlas "Live now" panel and full-conversation stream across Claude Code and Codex.

## Recommendation

Use a provider-specific source priority instead of forcing Claude Code and Codex into the same storage model.

1. Claude Code primary: `~/.claude/sessions/*.json` for current session status, plus `~/.claude/projects/**/<sessionId>.jsonl` for transcript streaming.
2. Claude Code enrichment: statusLine JSON / hooks can provide `session_id`, `transcript_path`, context window, rate limits, model, cwd, and session metadata, but they are not required for the first LIVE slice.
3. Codex primary when available: Codex app-server websocket protocol for loaded threads, true status changes, and turn/item streaming.
4. Codex fallback: `~/.codex/state_5.sqlite` for thread metadata and `threads.rollout_path`, plus tailing rollout JSONL files for transcript streaming.
5. Codex optional precision layer: hooks sidecar that writes Token-Atlas-owned status files when app-server is not running.

## Claude Code Findings

### Current-session status

Claude Code has an on-disk live session probe:

```text
~/.claude/sessions/<pid>.json
```

The relevant fields observed locally and confirmed by community tooling are:

```ts
type ClaudeLiveSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  updatedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
};
```

`claude-busy-monitor` documents this as the authoritative state source for Claude Code v2.1.119+, with `status` values `busy`, `idle`, and `waiting`. That matches our local `~/.claude/sessions/*.json` files.

Implementation note:

- Use this source for `/api/live` Claude rows.
- Keep a stale cutoff, e.g. `updatedAt` older than 10 minutes.
- Treat `waiting` separately from `idle` if we want UI nuance. `waiting` usually means the agent needs user input or approval.
- Verify the `pid` still exists where cheap, but do not make PID existence the only source of truth because resumed/migrated sessions may keep useful metadata briefly.

Source:

- https://pypi.org/project/claude-busy-monitor/1.0.0/

### Transcript streaming

Claude Code persists append-only JSONL transcripts here:

```text
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

Important transcript traits:

- One file per session.
- Filename is the session UUID.
- Append-only JSONL, one event per line.
- Entries include `type`, `sessionId`, `cwd`, `timestamp`, and message/tool data.
- Assistant entries include token usage fields under `message.usage`.

Implementation note:

- For `GET /api/stream`, first validate the session id against the active session list or known transcript files.
- Resolve transcript by using `transcript_path` when available, or glob `~/.claude/projects/**/<sessionId>.jsonl`.
- Realpath-check the result is inside `~/.claude/projects`.
- Tail by byte offset with partial-line buffering and truncation reset.

Sources:

- https://claude-dev.tools/docs/jsonl-format
- https://code.claude.com/docs/en/hooks

### Hooks and statusLine

Claude Code hooks provide lifecycle events useful for optional enrichment or sidecar state:

- `SessionStart`: fires when a session begins or resumes. Input includes `session_id`, `transcript_path`, `cwd`, `source`, and `model`.
- `UserPromptSubmit`: fires before Claude processes a user prompt.
- `PreToolUse` / `PostToolUse`: surround tool execution.
- `Notification`: can indicate permission prompts or idle prompts.
- `Stop`: fires when the main Claude Code agent finishes responding. Input includes `session_id`, `transcript_path`, `cwd`, `stop_hook_active`, and `last_assistant_message`.
- `StopFailure`: fires when the turn ends due to API/rate/auth/model/server errors.

Claude Code statusLine receives JSON on stdin and can include:

- `session_id`
- `session_name`
- `transcript_path`
- `model`
- `workspace.current_dir`
- `context_window.used_percentage`
- `rate_limits.five_hour.used_percentage`
- `rate_limits.five_hour.resets_at`
- `rate_limits.seven_day.used_percentage`
- `rate_limits.seven_day.resets_at`
- `version`

Implementation note:

- Do not require users to install Token-Atlas hooks for v1 Claude LIVE, because `~/.claude/sessions/*.json` already solves status.
- Hooks are useful if we later want richer event history, permission/waiting reasons, or cross-session sidecar data.
- statusLine is a good source for usage limits, context percentage, and transcript path, but it only refreshes on Claude Code events unless `refreshInterval` is configured.

Sources:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/statusline
- https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- https://github.com/leeguooooo/claude-code-usage-bar

### Existing project patterns

Useful public examples:

- `claude-busy-monitor`: reads `~/.claude/sessions/<pid>.json` for status and transcript JSONL for usage.
- `Claude-Code-Agent-Monitor`: uses Claude Code hooks, posts events to an Express server, stores in SQLite, and broadcasts to a dashboard over WebSocket.
- `Master of Puppets` VS Code extension: reads `~/.claude/projects/` JSONL files and watches file changes for a real-time dashboard.
- `claude-code-usage-bar`: uses statusLine JSON for rate limits/context and tails active transcript JSONL for prompt-cache age.

Takeaway:

- For our use case, `~/.claude/sessions/*.json` is better than hook inference for Level 1 because it already contains status.
- Hooks are better than transcript-only inference if we ever want detailed state transitions.
- JSONL tailing is the right primitive for Level 2 transcript stream.

Sources:

- https://pypi.org/project/claude-busy-monitor/1.0.0/
- https://github.com/hoangsonww/Claude-Code-Agent-Monitor
- https://marketplace.visualstudio.com/items?itemName=ukaszGawin.master-of-puppets
- https://github.com/leeguooooo/claude-code-usage-bar

## Codex Findings

### Best live source: app-server protocol

Codex has an app-server JSON-RPC protocol that exposes the exact live concepts we need:

- `thread/loaded/list`: returns thread ids currently loaded in memory.
- `thread/status/changed`: emitted whenever a loaded thread status changes.
- Status values include `notLoaded`, `idle`, `systemError`, and `active`.
- `active` means the thread is running.
- `turn/start`, `turn/started`, `turn/completed`, and `item/*` notifications provide real turn/item streaming.
- `thread/read` and `thread/turns/list` provide stored thread data without manually reading files.

Implementation note:

- If Token-Atlas can connect to the local Codex app-server websocket, this should be the primary Codex LIVE source.
- Map Codex `active` to Token-Atlas `busy`, `idle` to `idle`, `systemError` to `error`, and `notLoaded` to `recent` or hidden depending on UI scope.
- This avoids guessing from file mtime and avoids reading debug logs.

Source:

- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### Fallback source: SQLite + rollout JSONL

Codex persists metadata and transcripts in two layers:

```text
~/.codex/state_5.sqlite
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
```

The `threads` table includes:

- `id`
- `rollout_path`
- `created_at`
- `updated_at`
- `created_at_ms`
- `updated_at_ms`
- `cwd`
- `title`
- `source`
- `model_provider`
- `model`
- `tokens_used`

The rollout JSONL file is the full event history. Codex source describes `RolloutRecorder` as the durable writer, and `state_5.sqlite` as the query/index layer.

Implementation note:

- For Codex fallback `/api/live`, query recent rows from `threads`, verify `rollout_path` exists, and classify status as activity-based: `recent`, `stale`, or `active-inferred`.
- For Codex fallback `/api/stream`, use `threads.rollout_path`, realpath-check inside `~/.codex/sessions`, and tail JSONL by byte offset.
- Do not rely on `~/.codex/log/codex-tui.log` for product behavior. It is large, debug-oriented, and not a stable data contract.

Sources:

- https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
- https://ccusage.com/guide/codex/session
- https://deepwiki.com/peteromallet/dataclaw/5.3-codex-sessions

### Optional precision fallback: hooks sidecar

Codex hooks can provide lifecycle signals similar to Claude hooks:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Stop`

One public issue notes that hook payloads include session/turn ids, but do not yet expose enough root/subagent relationship metadata for perfect multi-agent classification. That matters if a subagent `Stop` should not mark the parent idle.

Implementation note:

- If app-server is not running and we want true Codex busy/idle, install Token-Atlas hooks that write sidecar files under `~/.cache/token-atlas/live/codex/<threadId>.json`.
- User prompt submit sets `busy`; Stop sets `idle`; permission/request hooks can set `waiting`.
- Treat subagent relationships carefully; do not let a child stop event mark the parent idle.

Sources:

- https://deepwiki.com/openai/codex/3.11-hooks-system
- https://github.com/openai/codex/issues/20675
- https://github.com/openai/codex/issues/15266

## Unified API Shape

Suggested `/api/live` row:

```ts
type LiveSession = {
  provider: "claude" | "codex";
  id: string;
  projectName: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | "recent" | "stale" | "error";
  statusSource:
    | "claude-session-file"
    | "claude-hook-sidecar"
    | "codex-app-server"
    | "codex-hook-sidecar"
    | "codex-sqlite-rollout";
  updatedAt: string;
  ageMs: number;
  transcriptPath?: string;
  model?: string;
  version?: string;
};
```

Suggested stream endpoint:

```text
GET /api/stream?provider=claude&id=<sessionId>
GET /api/stream?provider=codex&id=<threadId>
```

Security rules:

- Validate provider.
- Validate id format per provider.
- Resolve the id through the provider's known metadata source before opening files.
- Realpath-check transcript paths:
  - Claude: inside `~/.claude/projects`
  - Codex: inside `~/.codex/sessions` or `~/.codex/archived_sessions` only if archived sessions are explicitly supported
- Keep localhost binding.
- Keep the modal notice: `Shows raw local transcript content.`

## Build Plan Impact

Recommended update to `PLAN.md`:

1. Keep Claude Level 1 as originally planned: `~/.claude/sessions/*.json`.
2. Add `waiting` as a first-class status.
3. Add Codex Level 1 with source priority:
   - app-server websocket when reachable
   - hook sidecar when installed
   - SQLite/rollout activity fallback
4. Add Codex Level 2 stream:
   - app-server item stream when connected
   - rollout JSONL tail fallback
5. Keep per-session cost deferred.

## Open Questions

1. Do we want Token-Atlas to start or manage a Codex app-server, or only connect if one already exists?
2. Should Token-Atlas install Claude/Codex hooks automatically, or expose a separate setup command?
3. Should archived Codex rollouts be visible in LIVE search/stream, or only active sessions?
4. Should `waiting` be displayed separately from `idle`, or merged visually with a warning/attention state?
