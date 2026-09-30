# SERVER-03: Transcript stream and history

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/02, server/08
> **Status**: done
> **Models**: dev=opus/high

## Goal

`GET /api/transcript/stream` and `GET /api/transcript/history` serve live and paged transcripts for Claude, Codex, and OpenCode sessions with the same frames, filters, cursors, and confinement as the Bun daemon's `transcript-stream.ts`.

## Files to create / modify

- `packages/monitor/skills/cockpit/contract/daemon.contract.test.ts` (modify) — add any case this task's acceptance names that the suite lacks, inside this task's own group(s) only; green against TS first.
- `packages/monitor/cockpit-rs/src/server/transcript.rs` (modify — currently an empty stub router and an empty `TranscriptState`) — routes `/api/transcript/stream` and `/api/transcript/history`, Claude/Codex tail source, history paging; declares `mod opencode_rows;`.
- `packages/monitor/cockpit-rs/src/server/transcript/opencode_rows.rs` (new) — OpenCode message/part rows → transcript entries, and the OpenCode polling stream.

Reuse, do not re-implement: the resilient tailer (`crate::server::log_stream::sse_tailer`: `create_tail_stream`, `TailSource`, `Resolve`, `Backlog`, `split_complete_lines`, `HEARTBEAT_MS`, the SSE envelope) and the provider helpers in `crate::server::sources` (`resolve_claude_transcript_path`, `resolve_codex_rollout_path`, `codex_dir`, `codex_sessions_dir`, `opencode_db`, `opencode_timestamp_ms`). Do not edit `sources.rs`, `server/mod.rs`, `AppState`, or `Cargo.toml` — they belong to the server foundation; if a helper named here is missing, write it privately inside `transcript.rs`.

The subagent and session-title modules live under the views module (`crate::server::views::subagents`, `crate::server::views::session_title`); the transcript routes do not call them — `transcript-stream.ts` imports neither — so never re-create them here.

## Implementation notes

### Constants

`BACKLOG_LINES = 50`, `BACKLOG_READ_CHUNK_BYTES = 256 KiB`, `MAX_BACKLOG_READ_BYTES = 2 MiB`, `MAX_HISTORY_LIMIT = 200`. Session id: UUID regex `^[0-9a-f-]{36}$`, except OpenCode `^[A-Za-z0-9_.:-]+$` and length ≤ 160.

### Parameters and errors (both routes)

- `provider`: absent or `claude` → Claude; `codex`; `opencode`; anything else → `400` `{"error":"invalid provider"}`.
- Invalid session id → `400` `{"error":"invalid session id"}`.
- A resolved transcript whose realpath is outside the provider root (`realpath(COCKPIT_CLAUDE_PROJECTS_DIR)` for Claude, `realpath(codex sessions dir)` for Codex; fall back to the unresolved dir when realpath fails) → `403` `{"error":"transcript path is outside ~/.claude/projects"}` / `…outside Codex sessions`.

### Display filter (shared by stream and history)

An entry is displayed when `type` ∈ `{user, assistant, system, tool, tool_use, tool_result, response_item}`; a `response_item` additionally needs `payload.type` ∈ `{message, function_call, function_call_output, custom_tool_call}`. Blank and invalid-JSON lines are skipped. Stream frames are `data: <compact JSON of the entry>\n\n`.

### Backward line reader (port of `readLinesEndingAt`)

`read_lines_ending_at(path, end_offset, max_lines) -> (lines, partial, start_offset)`: read backward from `end_offset` in 256 KiB chunks, counting `0x0a` bytes, stopping once `newline_count >= max_lines` or 2 MiB were read. Concatenate as bytes and do every cut on bytes: when the read began mid-file (`start > 0`) drop everything up to and including the first `0x0a`; split at the last `0x0a` into complete bytes / `partial` bytes; keep the last `max_lines` complete lines. Only then decode each complete line (lossy UTF-8); `partial` stays raw bytes, so a file that currently ends mid-character loses nothing when the rest is appended. Compute `start_offset` from raw byte lengths: `end_offset - (sum of kept lines' byte lengths + their newline bytes + partial.len())`, or `end_offset - partial.len()` when no lines. Add a cargo test where the backlog ends in half a multibyte character and a later append completes it: the character arrives intact and `historyStart` points at a real line start.

### Claude / Codex stream

- `resolve()`: provider path lookup; not found or realpath fails → `Wait` (a transcript can appear moments after selection); outside the root → `Fail` 403 as above; else `Ready(realpath)`.
- `read_backlog(path, size)`: `read_lines_ending_at(path, size, 50)`; `complete = lines.join("\n")`; `partial` goes into `Backlog.partial` as its raw bytes (the tailer's partial buffer is bytes); `meta = {"historyStart": start_offset, "hasMore": start_offset > 0}` (that key order) — this is the `backlog-done` payload.
- `emit`: display filter, one frame per entry.

### OpenCode stream (no file — DB polling)

- Rows: `select m.id as message_id, m.time_created as message_created, m.time_updated as message_updated, m.data as message_data, p.id as part_id, p.time_created as part_created, p.data as part_data from (select id, session_id, time_created, time_updated, data from message where session_id = ? and time_updated > ? order by time_updated desc, id desc limit ?) m left join part p on p.message_id = m.id order by m.time_created asc, m.id asc, p.time_created asc, p.id asc`. Missing DB or any error → no rows.
- Frames: `: connected`; backlog = rows after 0, limit 50; then `event: backlog-done` with `{}`; then every `COCKPIT_TAIL_POLL_MS` (default 2000) poll rows with `time_updated > cursor`; heartbeat every 25 s. `cursor = max(cursor, message_updated || message_created || 0)` over emitted rows. A `seen` set of message uuids suppresses re-emitting an entry.
- Row → entry (port `openCodeRowsToEntries` / `openCodePartContent` / `openCodeReadToolContent` exactly, including field order): group rows by `message_id` in first-seen order; parts mapped as — `tool` with `tool == "read"` → one `tool_result` `{type, label: "Read · <last 3 path segments>" or "Read", file_path, content}` (skipped when both text and path are empty, then falls through); `text` → `{type:"text", text}`; `reasoning` → `{type:"thinking", thinking}`; other `tool` → `{type:"tool_use", name: name ?? tool ?? "tool", input: input ?? whole part}`; `step-start`/`step-finish` → nothing; `patch` with at least one string in `files` → one text block whose text is the line `Changed files:` followed by one line per file of the form dash, space, the compact path wrapped in backticks, joined with `\n` (no files → nothing); else `text ?? content` string → text; else text = pretty JSON (`JSON.stringify(part, null, 2)`, 2-space indent). Entry: `{type: role, uuid: message_id, timestamp: ISO(message_updated) or omitted, message: {role, content}, provider: "opencode"}` where role is `user` iff data.role is `user`, else `assistant`; content = parts, or fallback `data.content ?? data.text ?? pretty(summary) ?? ""`; skip an entry with no parts whose content is null or blank string.

### History (`/api/transcript/history?session&provider&before&limit`)

- Empty result `{"entries": [], "historyStart": 0, "hasMore": false}` for: OpenCode, `before` not a finite number > 0, no transcript, realpath failure.
- Else clamp `end = min(before, size)`; `cap = min(max(1, limit || 50), 200)`; `read_lines_ending_at(path, end, cap)`; respond `{"entries": [displayed entries oldest-first], "historyStart": start_offset, "hasMore": start_offset > 0}`. Read failure → `500` `{"error":"failed to read transcript history"}`.
- `Number("")` is `0` in JS, so an empty `before` gives the empty result and an empty `limit` means 50.

## Acceptance criteria

- [x] Every `server: transcript` contract test passes against the Rust binary and still passes against TS.
- [x] The Claude/Codex backlog is the last 50 lines of the file, then filtered for display, and `backlog-done` carries `historyStart`/`hasMore` that page correctly through `/api/transcript/history` to offset 0.
- [x] A transcript created after the stream opens is streamed once it appears; a symlink escaping the provider root answers 403 before any SSE bytes.
- [x] OpenCode streams produce entries identical to TS on the contract's OpenCode fixture, including `read` tool results and patch summaries, and new messages arrive on the next poll without duplicates.
- [x] A 2.4 GB-class transcript never gets read whole: backlog and history reads are bounded to 2 MiB (verified by a `cargo test` on a sparse large file).
- [x] (human) Open the dashboard served by the Rust server against real sessions; the transcript, decision log, subagent and design-system panels render as they do on the Bun server.

## Verification

- [x] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [x] `cargo fmt --manifest-path packages/monitor/cockpit-rs/Cargo.toml -- --check && cargo clippy --manifest-path packages/monitor/cockpit-rs/Cargo.toml --all-targets -- -D warnings`
- [x] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: transcript"`
- [x] `bun test packages/monitor/skills/cockpit/contract/daemon.contract.test.ts -t "server: transcript"` (TS still green)

## Eval rubric

> Scale 0–5, see `../_context/rubric.md`. Weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong provider files streamed, confinement bypassable, or entries malformed | Claude works; Codex/OpenCode mapping, history cursor, or filter drifts | All three providers, the filter, cursor math, and confinement match TS |
| Test coverage | ×2 | Contract group not run on Rust | Group passes; cursor and OpenCode mapping untested in Rust | Group passes on both; `cargo test` covers `read_lines_ending_at` edges (mid-file start, no newline, multibyte), OpenCode part mapping, bounded reads |
| Interface & readability | ×1 | Tailer or path helpers duplicated | Reused but OpenCode logic tangled with file tailing | Tail source and OpenCode poller are separate, both reuse the shared helpers |
| Assumptions & docs | ×1 | Magic numbers without source | Constants present, JS coercions unexplained | Constants named; `Number()` coercion and ordering choices commented |

## Out of scope

- Subagent counts and historical titles for the sessions list — owned by the views module; not used by these routes.
- Paging OpenCode history — the TS returns an empty page for OpenCode; keep it that way.
