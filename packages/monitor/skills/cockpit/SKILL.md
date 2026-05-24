---
name: cockpit
description: >-
  Start a per-project cockpit session for Claude Code or Codex: propose a
  project goal + this session's goal, confirm them with the user, then capture the goal
  record and begin a distilled decision trail. Trigger phrases include:
  "/cockpit-start", "start cockpit", "set session goal", "開始 cockpit",
  "設定這次的目標". This skill is EXPLICITLY invoked (opt-in) — do NOT auto-fire
  on every session. Use it when the user wants to set a destination for this leg of work
  and watch the decision trail steer toward it in the cockpit dashboard.
---

# /cockpit

Capture a goal at session start and open a decision trail for this project —
the data the cockpit dashboard visualizes. This sets the heading: where we're
going, then the turns a diff can't explain.

**Opt-in.** Only run when the user invokes it (`/cockpit`, "設定這次的目標", …).
Never auto-start on session open — not every session deserves a goal.

This skill serves both **Claude Code** and **Codex**. The cockpit storage,
decision log, dashboard, and wait/send bridge are shared by both providers; only
a few things differ per provider, and those live in the provider reference.

## Step 0 — Provider

Determine which harness is running this skill:

- Running in **Claude Code** → provider is `claude`.
- Running in **Codex** → provider is `codex`.

Then **read the matching reference once** — it gives you the three things this
procedure defers to it:

- Claude Code → [references/claude.md](references/claude.md)
- Codex → [references/codex.md](references/codex.md)

Each reference defines, for its provider: the **`<plugin-root>`** used in every
command below, the exact **session-id command** (Step 1), and the **wait
policy** for `needs_your_call`. Everything else here is shared.

## Procedure

Follow this order strictly. **The human holds the stick at goal-setting** — this
mirrors `needs_your_call`: nothing is written until the user confirms.

### 1. Determine the session id

The dashboard uses the harness session id to join the decision log to the live
transcript. Run the **session-id command from your provider reference**. If it
exits non-zero, generate one (`crypto.randomUUID()`) and note which id you used
(your reference notes any provider-specific retry first).

### 2. Propose goals (don't write yet)

Draft two one-line goals from the conversation + repo state:

- **`project_goal`** — the persistent destination for this project. If
  `<project>/.cockpit/project-meta.md` already exists, reuse / refine its
  frontmatter `project_goal` rather than inventing a new one.
- **`session_goal`** — what *this* leg of the journey achieves.

Keep each to one line. The user reacts and edits; they do not write from scratch.

### 3. Human gate — confirm goals + log language

Present both goals to the user with the structured question tool when available, or ask
plainly. The user confirms, edits, or rejects. **Do not run any `cockpit` command until
the user confirms.** If the user rejects, stop — write nothing.

In the same gate, settle the **decision-log language** (`log_language`) — the
language you'll write decision/reason/tradeoff entries in:

- If `project-meta.md` already has a `log_language`, reuse it silently — it's a
  per-project setting, don't re-ask.
- Otherwise ask. Default to English, then add options inferred from context —
  the language the user is writing in now, and any languages from repo/global
  instructions.

### 4. Write (only after confirmation)

Run, substituting the confirmed text, the provider from Step 0, the session id,
and the chosen language (omit `--log-language` to keep an existing value /
default to English):

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts start \
  --provider <claude|codex> \
  --session <id> \
  --session-goal "<confirmed session goal>" \
  --project-goal "<confirmed project goal>" \
  --log-language "<confirmed language>"
```

This writes `<project>/.cockpit/project-meta.md` (frontmatter `project_goal` +
`log_language`), appends the goal record as line 1 of
`<project>/.cockpit/logs/<id>.jsonl`, and registers the session in
`~/.cockpit/registry.json` with its provider.

### 5. Start (or reuse) the dashboard daemon

The trail is only useful if the user can see it, so bring up the dashboard. Run it as a
background task — it's a long-lived server that would otherwise block:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit-server.ts
```

Then tell the user the URL it prints (default `http://localhost:5858`). See **The
dashboard daemon** below for how it behaves — most importantly, it's a singleton,
so running this when one is already up is harmless (it just reprints the URL).

## The dashboard daemon

One daemon serves every project's cockpit; you don't run a server per session.

- **Singleton, idempotent.** A PID file at `~/.cockpit/daemon.json` tracks the
  live instance. Starting it again detects the running daemon, prints its URL,
  and exits `0`.
- **Binds `127.0.0.1:5858`.** Override with `--port <n>`; pass `--no-open` to
  skip auto-opening the browser.
- **It will not kill a foreign process.** If port 5858 is held by something that
  isn't a cockpit daemon, it exits `1` with a clear message — re-run with
  `--port <n>`.
- **It powers `wait` / `send`.** The control loop talks to this daemon, so it
  must be running before you park a `cockpit wait` (see below).

## Logging decisions afterward

A decision card exists to carry what a `git diff` throws away: **the thinking
behind the change, not the change itself.** The diff already shows *what* the
code does — your job here is to record *why it ended up this way*, so a future
reader (or you, six months from now) doesn't have to reverse-engineer it.

The filter for whether to log at all: **would someone reading the diff later ask
"why was it done this way?"** If yes, log it. If the diff explains itself
("created the User model", "renamed a variable"), skip it — a card that only
restates the diff is noise in the trail.

Write `--decision` / `--reason` / `--tradeoff` in the project's
**`log_language`** (the `project-meta.md` frontmatter set at start; default
English) — read it back if you're unsure which is in effect:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts log \
  [--session <id>] \
  --decision "what you chose / did — the one-line headline" \
  --reason   "why this path, in a sentence or two" \
  [--facet "LABEL: a distinct dimension of the thinking" ...] \
  [--tradeoff "what it costs — what you gave up or are now assuming"] \
  [--file path/a.ts --file path/b.ts] \
  [--needs-call --option "A" --option "B"]
```

**What each field carries:**

- `--decision` — *what* you chose or did, in one line.
- `--reason` — the lead: *why this path and not another,* in prose. The core
  narrative of the call.
- `--facet "LABEL: text"` (**repeatable**) — break out a distinct dimension of the
  reasoning into its own labeled row. **You choose the label** — pick the one that
  fits *this* decision, because no two decisions involve the same dimensions. A
  suggested vocabulary (use it loosely, don't force it, invent a label when none
  fit):
  - `PROBLEM` — what you understood the task to be, when it isn't obvious from the code.
  - `CONSTRAINT` — the limit that ruled out the cleaner option (perf, an API shape, compat, a deadline).
  - `REJECTED` — the approach a reader would expect, and why you didn't take it. Often the most useful row.
  - `ASSUMPTION` — what you're now leaning on that, if it changed, would break this.
  - `PRIOR-ART` — the existing pattern/decision you're following (or deliberately not).

  Reach only for the facets that *actually apply* — a card with one sharp `REJECTED`
  beats one padded with five hollow rows. Each facet renders as its own stencil row
  in the dashboard, so the card reads like a field manual of how the call was made.
- `--tradeoff` — what the choice *costs*: what you gave up. (A forward-looking risk
  often reads better as an `ASSUMPTION` or `RISK` facet — use whichever frames it best.)

`--reason` and each `--facet` body render as Markdown in the dashboard.

**Example 1 — shallow vs. with the thinking, facets pulling their weight:**

```bash
# ❌ Shallow — just echoes the diff
--decision "Dedup transcript entries by requestId:messageId"
--reason   "To avoid duplicate entries"

# ✅ Reason carries the narrative; facets break out the dimensions
--decision "Dedup transcript entries by requestId:messageId"
--reason   "Streamed assistant turns get re-emitted on reconnect, so the same usage
            was counted twice and cost showed ~2x."
--facet    "CONSTRAINT: requestId alone collides across a multi-message turn; messageId
            alone repeats across requests — only the pair is unique per billable unit."
--facet    "ASSUMPTION: holds every seen key in memory for the session — fine at current
            log sizes, would need an LRU if a session ran for days."
```

The ✅ version lets a reader reconstruct *why the pair*, *what bug it fixes*, and
*when it stops working* — each on its own scannable row.

**Example 2 — the whole call turns on the alternative you rejected:**

```bash
--decision "One dashboard daemon serves every project, not a server per session"
--reason   "A singleton keyed by a PID file (~/.cockpit/daemon.json) starts once;
            every session's SSE just subscribes to it."
--facet    "REJECTED: spawning a server on each `cockpit start` — sessions open and
            close constantly, so per-session servers mean port churn and orphaned
            processes nobody reaps."
--facet    "RISK: all projects share port 5858 — if the daemon crashes, every project's
            live view goes dark with it."
```

The `REJECTED` row is the fork a future reader would otherwise have to rediscover by
trial — now it's a labeled line they can scan to in a second.

**Example 3 — a `needs_your_call`, where the decision is the question itself:**

```bash
--decision "Persist pricing overrides — per-project or one global file?"
--reason   "Codex and Claude share a machine but rates differ per workspace; unclear
            whether you want one source of truth or per-repo control."
--needs-call --option "Global ~/.config" --option "Per-project .cockpit/"
```

The `--reason` still earns its place: it tells the user *why the fork exists* before
they pick, so the answer lands in the trail with its context intact.

- `--session` is optional: when omitted, `log` resolves the current session
  itself (Claude via `CLAUDE_CODE_SESSION_ID`, Codex via its state DB), so a
  decision can't be misfiled to the wrong or a stale session. Pass it explicitly
  only when logging for a session other than the live one.
- `--facet`, `--file`, and `--option` are repeatable.
- `log` does not need `--provider` after `start`; the existing registry entry
  keeps the provider. If logging before `start`, include `--provider <provider>`.
- **Handoff (`--needs-call`)** marks the moment autopilot hands the stick back
  to the user. Supply the choices via `--option`, then immediately park with:

  ```bash
  bun <plugin-root>/skills/cockpit/scripts/cockpit.ts wait <id>
  ```

  Run `wait` according to the **wait policy in your provider reference** (Claude
  Code parks it as a background task; Codex blocks in the foreground). It
  requires the dashboard daemon (Step 5) to be running. `cockpit send <id>
  <answer>` is the terminal twin of a UI option button — both are part of this
  plugin's control-loop bridge between a parked session and the user's answer.

## While a session is live — ask through the cockpit

Once a session has been started (Step 4) and the dashboard is up (Step 5), the
cockpit is the user's single surface for being asked. While such a session is active,
**route every question for the user through `needs_your_call` — not the harness
question tool (e.g. `AskUserQuestion`) and not a bare chat prompt.** This rule
also applies when another skill or workflow says to "ask the user": if Cockpit is
started and running in this conversation, translate that ask into a
`needs_your_call` log entry and wait for the cockpit answer instead of asking in
chat. Two cases, one channel:

- **A decision fork** — autopilot hit a branch and needs the user to pick a heading.
- **Missing information** — you need a value, preference, or confirmation only the user
  can give before continuing.

Both belong in the cockpit: log the `--needs-call` (the `--decision` carries
the question, one `--option` per suggested choice — options are optional, omit
them for a pure free-text ask), then park `cockpit wait <id>` per your provider's
wait policy. The ask surfaces as the warm "your turn" moment, the user answers in the
dashboard (or via `cockpit send <id> <answer>`), and the question with its answer
lands in the trail. Falling back to `AskUserQuestion` splits the user's attention off
the cockpit and leaves the decision trail with a hole where a turn should be.

## Notes

- Commands use **`<plugin-root>`**; your provider reference (Step 0) says how to
  resolve it.
- One session = one log file; concurrent sessions never share a file.
- The persistent **project** goal lives only in `project-meta.md` frontmatter
  (single source of truth). It is not duplicated into the log. The log's goal
  record carries only `session_goal`.
