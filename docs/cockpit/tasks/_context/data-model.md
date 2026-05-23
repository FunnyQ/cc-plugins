# Data model

> Inline schemas every kernel / server / bridge / ui task relies on. Authoritative; copy these shapes verbatim.

## Per-project files

### `<project>/.cockpit/project-meta.md` — persistent project goal

YAML frontmatter + prose body (hybrid, borrowed from Stitch/DESIGN.md: structured head for the renderer, prose body for humans). Read whole, hand-edited or regenerated; **not** append-only.

```markdown
---
project_goal: One-line persistent destination for this project.
created: 2026-05-23T09:00:00Z
owner: Q
---

Longer prose describing the project's purpose, constraints, north star.
Free-form. The renderer shows the frontmatter as structured fields and
the body as markdown.
```

### `<project>/.cockpit/logs/<session-id>.jsonl` — goal + decision trail

Append-only JSONL. **One session = one file** (concurrent sessions never share a file). `<session-id>` is the Claude Code session uuid. Line 1 is the goal record; subsequent lines are decision or response records. Three record types: `goal` | `decision` | `response`.

**Goal record** (line 1):

```json
{ "type": "goal", "session_goal": "what this leg of the journey achieves", "ts": "2026-05-23T09:00:00Z" }
```

- Only the **session** goal lives here. The persistent **project** goal is owned by `project-meta.md` frontmatter (single source of truth) — it is *not* duplicated into the log.

**Decision record** (appended by `cockpit log`) — **8 fields**:

```json
{
  "type": "decision",
  "decision": "what was decided / done",
  "reason": "why — the part a diff can't show",
  "tradeoff": "what was given up / the alternative not taken (may be empty string)",
  "needs_your_call": false,
  "options": [],
  "files": [],
  "timestamp": "2026-05-23T09:14:22Z"
}
```

- `type`: `"decision"`.
- `needs_your_call`: `true` marks the moment autopilot hands the control stick back to Q. When `true`, **`options` should list the choices** the UI renders as buttons; the session then parks on a wait-task (see "Bridge / rendezvous" below) until Q answers.
- `options`: `string[]` — the pickable answers for a `needs_your_call`; empty `[]` for ordinary decisions. Q may always type a free-form answer instead of picking.
- `files`: `string[]` — relative paths touched by this decision; empty `[]` when not file-specific.
- Only record decisions a diff can't explain (skip "created User model" busywork).

**Response record** (appended by the daemon when Q answers a `needs_your_call`):

```json
{ "type": "response", "answer": "the option Q picked, or free-form text", "ts": "2026-05-23T09:15:10Z" }
```

- A `response` resolves the **most recent open `needs_your_call`** in the same session (at most one is open at a time, because the session is parked while waiting). No id pairing needed.
- The UI renders it inline right after the resolved needs_your_call card.

**Robustness rule** (all record types): one malformed line must not break parsing of the others — parse line-by-line, skip bad lines, keep going.

## Central daemon state (`~/.cockpit/`)

### `daemon.json` — PID-file for reuse

```json
{ "pid": 12345, "port": 5858, "token": "hex-random" }
```

Reuse logic (copied from impeccable / token-atlas): read the file, `process.kill(pid, 0)` to probe — if alive, reuse that port; if it throws (ESRCH), the daemon is dead, rebind and rewrite.

### `registry.json` — session registry + heartbeat

```json
{
  "sessions": [
    {
      "project": "/Users/funnyq/Projects/q-lab/some-project",
      "sessionId": "0a1b2c3d-....-............",
      "logPath": "/Users/funnyq/Projects/q-lab/some-project/.cockpit/logs/<id>.jsonl",
      "lastHeartbeat": "2026-05-23T09:14:22Z"
    }
  ]
}
```

- `cockpit start` upserts the session entry; `cockpit log` (and `start`) refresh `lastHeartbeat`.
- The daemon derives **active vs ended**: `active` if `lastHeartbeat` (or the log file mtime) is within the staleness window (default **10 minutes**, matching token-atlas live-session filtering); otherwise `ended` (read-only).
- The daemon watches only the `logPath`s listed here — no filesystem scanning.

## Bridge / rendezvous (the control loop)

The bidirectional channel that lets Q answer a `needs_your_call` from the UI and wake the LLM. Adapted from impeccable's broker, but **per-session keyed** (not a flat queue) so concurrent sessions never steal each other's events.

In-daemon state (no file needed — lives in the daemon process):

```ts
// one outstanding wait per session at a time (the session is parked)
state.pendingWaits = new Map<string /* sessionId */, (answer: string) => void>()
```

Flow:

1. LLM logs a `decision` with `needs_your_call: true` + `options`, then runs `cockpit wait <sessionId>` (a background task — zero LLM cost while parked).
2. `cockpit wait` hits `GET /api/wait?session=<id>&token=<t>` — a **long-poll** that registers a resolver in `pendingWaits` and holds the connection (single hop ~270s, loop until answered).
3. Q clicks an option (or types) → UI `POST /api/respond { session, answer, token }`. `cockpit send <id> <answer>` is the CLI equivalent of that POST.
4. Daemon's `respond` handler: (a) appends a **response record** to that session's log, (b) resolves the matching `pendingWaits` entry → the `/api/wait` request returns `{ answer }`.
5. `cockpit wait` prints the answer and exits → the harness wakes the LLM, which continues.

**Hard caveat** (carry into bridge tasks): `respond` / `cockpit send` only reaches a session that is **currently parked** in a `cockpit wait` task. A session whose turn has fully ended (idle at the REPL) has no live poll, so it cannot be reached — UI control only applies to `active` + parked sessions. Surface this in the UI (an answerable call vs a historical, now-unreachable one).

Endpoints (added to the daemon):

```
GET  /api/wait?session=<uuid>&token=<t>   → long-poll, resolves to { "answer": "..." }
POST /api/respond  { session, answer, token }  → append response record + resolve the parked wait
```

Auth: the shared `token` from `daemon.json` (write endpoints + wait require it; read/SSE endpoints stay open on localhost).

## TypeScript types (use verbatim)

```ts
type RecordType = "goal" | "decision" | "response"

type GoalRecord = {
  type: "goal"
  session_goal: string
  ts: string
}

type DecisionRecord = {
  type: "decision"
  decision: string
  reason: string
  tradeoff: string
  needs_your_call: boolean
  options: string[]   // choices for a needs_your_call; [] otherwise
  files: string[]     // relative paths touched; [] when not file-specific
  timestamp: string
}

type ResponseRecord = {
  type: "response"
  answer: string
  ts: string
}

type LogRecord = GoalRecord | DecisionRecord | ResponseRecord

type RegistryEntry = {
  project: string
  sessionId: string
  logPath: string
  lastHeartbeat: string
}

type SessionStatus = "active" | "ended"

type DaemonInfo = { pid: number; port: number; token: string }
```
