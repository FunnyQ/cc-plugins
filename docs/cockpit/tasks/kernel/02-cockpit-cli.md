# KERNEL-02: cockpit CLI (start | log)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
>
> **Depends on**: kernel/01
> **Blocks**: kernel/03, server/02
> **Status**: done

## Goal

A `cockpit` Bun CLI that produces all the kernel data: `cockpit start` writes `project-meta.md` + the session goal record and registers the session; `cockpit log` atomically appends an 8-field decision record. Both refresh the session heartbeat.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/cockpit.ts` (new) — the CLI with `start` and `log` subcommands.

## Implementation notes

Single-file Bun script, invoked as `bun cockpit.ts <subcommand> [args]`. Uses `node:fs`, `node:path`, `node:os`. No external deps.

### Paths

- Project root = `process.cwd()` (the CLI is run from inside the target project).
- `<project>/.cockpit/project-meta.md`, `<project>/.cockpit/logs/<session-id>.jsonl`.
- `~/.cockpit/registry.json` (central). Create `~/.cockpit/` if missing.
- Session id: prefer `--session <id>`; the `/cockpit-start` skill passes the real Claude Code session uuid. Fall back to a generated uuid if absent.

### `cockpit start`

Args: `--session <id>`, `--session-goal <text>`, `--project-goal <text>`, optional `--owner <name>` (default `Q`).

1. Ensure `<project>/.cockpit/logs/` exists.
2. Write `project-meta.md` (overwrite/regenerate is fine — it's a snapshot) with YAML frontmatter (`project_goal`, `created` ISO-8601 if new else preserve, `owner`) + an empty prose body placeholder.
3. Append the **goal record** as line 1 of `logs/<id>.jsonl` (create the file). Only `session_goal` — the project goal lives in `project-meta.md`, not the log:
   ```json
   { "type": "goal", "session_goal": "...", "ts": "<ISO>" }
   ```
   (`--project-goal` is still consumed here, but only to write the `project_goal` frontmatter in step 2.)
4. Upsert the session into `~/.cockpit/registry.json` (`project`, `sessionId`, `logPath`, `lastHeartbeat = now`).

### `cockpit log`

Args: `--session <id>`, `--decision <text>`, `--reason <text>`, optional `--tradeoff <text>` (default `""`), **repeatable** `--file <relpath>` (→ `files[]`), **repeatable** `--option <text>` (→ `options[]`), and a `--needs-call` boolean flag.

1. Build a **DecisionRecord** (all 8 fields; `files` and `options` default to `[]`; `timestamp = now`).
2. **Atomic append**: open the log file with append flag (`fs.appendFileSync(path, JSON.stringify(rec) + "\n")`); one record = one line.
3. Refresh `lastHeartbeat` for that session in the registry.
4. **When `--needs-call` is set**, the caller (the LLM, per the `/cockpit-start` skill) should immediately follow with `cockpit wait <session>` to park for Q's answer (that command lives in the bridge bucket). This task only writes the record; it does not block.

### Types (from data-model.md — use verbatim)

```ts
type GoalRecord = { type: "goal"; session_goal: string; ts: string }
type DecisionRecord = {
  type: "decision"; decision: string; reason: string; tradeoff: string
  needs_your_call: boolean; options: string[]; files: string[]; timestamp: string
}
type RegistryEntry = { project: string; sessionId: string; logPath: string; lastHeartbeat: string }
```

### Registry upsert

Read `~/.cockpit/registry.json` (`{ sessions: RegistryEntry[] }`, default `{ sessions: [] }`), replace the entry matching `sessionId`, or push a new one, write back. Tolerate a missing/corrupt file by starting from `{ sessions: [] }`.

## Acceptance criteria

- [x] `cockpit start --session <id> --session-goal X --project-goal Y` creates `.cockpit/project-meta.md` (frontmatter carries `project_goal: Y`) and `.cockpit/logs/<id>.jsonl` whose first line is a goal record containing `session_goal` but **no** `project_goal`.
- [x] A registry entry for the session appears in `~/.cockpit/registry.json` with a fresh `lastHeartbeat`.
- [x] `cockpit log --session <id> --decision D --reason R` appends exactly one line, a valid DecisionRecord with all 8 fields (`tradeoff` defaults to `""`, `needs_your_call` to `false`, `options`/`files` to `[]`).
- [x] `--needs-call` sets `needs_your_call: true`; repeated `--file a --file b` produces `files: ["a","b"]`; repeated `--option X --option Y` produces `options: ["X","Y"]`.
- [x] Running `log` twice appends two lines; existing lines are untouched (true append, not rewrite).
- [x] Each `start`/`log` updates that session's `lastHeartbeat`.

## Verification

- [x] In a scratch dir: `bun cockpit/skills/cockpit/scripts/cockpit.ts start --session 11111111-1111-1111-1111-111111111111 --session-goal "test" --project-goal "scratch"` then `cat .cockpit/logs/11111111-*.jsonl | jq` shows `{type:"goal", session_goal:"test"}` with no `project_goal`.
- [x] `bun .../cockpit.ts log --session 1111... --decision "chose X" --reason "Y" --needs-call --option "A" --option "B" --file src/x.ts` → `tail -1 .cockpit/logs/1111*.jsonl | jq` shows all 8 fields, `needs_your_call: true`, `options: ["A","B"]`, `files: ["src/x.ts"]`.
- [x] `jq '.sessions[] | select(.sessionId=="1111...")' ~/.cockpit/registry.json` shows the entry.

## Out of scope

- `cockpit wait` / `cockpit send` (the control-loop CLIs) — built in the bridge bucket; this task only writes records.
- Reading/aggregating logs for display — Deferred to the server bucket.
