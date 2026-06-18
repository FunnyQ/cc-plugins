# /cockpit pilot

Open the cockpit dashboard and establish the live decision trail surface for
this project. This mode never writes planning records or asks for planning
confirmation.

## Step 1 — Determine the session id

The dashboard uses the harness session id to join the decision log to the live
transcript. Run the **session-id command from your provider reference**. If it
exits non-zero, generate one (`crypto.randomUUID()`) and note which id you used
(your reference notes any provider-specific retry first).

This only resolves the id for use. It does not register the session. The session
auto-registers on the first `log` or `scribe` write.

## Step 2 — Resolve language

Read the current decision-log language from the cockpit config:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts config get-language
```

If the user explicitly asks to change it, run:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts config --log-language "<lang>"
```

Write `--decision` / `--reason` / `--tradeoff` entries in the configured
language. Do not use per-project metadata for language.

## Step 3 — Open the cockpit

The trail is only useful if the user can see it, so open the dashboard. When this
session was launched with the cockpit channel, the daemon is **already running** —
the channel MCP launches it (headless, no browser). Either way, run:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit-server.ts
```

This is an idempotent **ensure + open**: if the daemon is already up it just
opens the browser and exits; if it isn't (a Codex session, or Claude launched
without the channel flag) it launches the daemon and opens the browser. Run it
as a background task — on a cold boot the daemon is long-lived and would
otherwise block. Then tell the user the URL (default `http://localhost:5858`).
See **The dashboard daemon** below.

## The dashboard daemon

One daemon serves every project's cockpit; you don't run a server per session.

- **Singleton, idempotent.** A PID file at `~/.local/share/q-lab/cockpit/daemon.json` tracks the
  live instance. Running it again detects the running daemon, opens the browser,
  prints its URL, and exits `0` — so re-running always lands the user on the
  cockpit, even when the daemon was launched headless by the channel MCP.
- **Binds `127.0.0.1:5858`.** Override with `--port <n>`; pass `--no-open` to
  skip opening the browser (the channel MCP launches the daemon this way).
- **It will not kill a foreign process.** If port 5858 is held by something that
  isn't a cockpit daemon, it exits `1` with a clear message — re-run with
  `--port <n>`.
- **It powers `wait` / `send`.** The control loop talks to this daemon, so it
  must be running before you park a `cockpit wait` (see below).
- **Restarting onto new code.** Re-running `cockpit-server.ts` from the *same*
  install just reuses the live daemon — it won't pick up a plugin update or a
  working-tree edit. To bounce it onto fresh code, run
  `cockpit.ts restart [--port N] [--no-open]`: it kills the current daemon and
  rebinds from the install you invoke it from, then verifies it won the port,
  superseding+retrying past the channel MCP's auto-respawn. Offer this after a
  `/monitor:install` or plugin update. (If the running session's channel MCP is
  itself from an older cache, a session restart is still needed for the MCP — but
  the daemon and dashboard will already be on the new version.)

## Logging decisions afterward

A decision card exists to carry what a `git diff` throws away: **the thinking
behind the change, not the change itself.** The diff already shows *what* the
code does — your job here is to record *why it ended up this way*, so a future
reader (or you, six months from now) doesn't have to reverse-engineer it.

The filter for whether to log at all: **would someone reading the diff later ask
"why was it done this way?"** If yes, log it. If the diff explains itself
("created the User model", "renamed a variable"), skip it — a card that only
restates the diff is noise in the trail.

Write `--decision` / `--reason` / `--tradeoff` in the configured language — read
it back if you're unsure which is in effect:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts config get-language
```

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts log \
  [--session <id>] \
  --decision "what you chose / did — the one-line headline" \
  --reason   "why this path, in a sentence or two" \
  [--facet "LABEL: a distinct dimension of the thinking" ...] \
  [--tradeoff "what it costs — what you gave up or are now assuming"] \
  [--file path/a.ts --file path/b.ts] \
  [--diagram "$(cat <<'MMD'
flowchart TD
  A[...] --> B[...]
MMD
)"] \
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

- `--diagram` — optional **Mermaid** source. When structure beats prose — a flow,
  a state machine, a sequence, a dependency graph — attach it and the dashboard
  renders it inline as an SVG, themed to the Night Flight palette. You author the
  Mermaid text yourself (you have the in-session context an external CLI lacks);
  pass it as one argument (a heredoc keeps newlines intact). Reach for it only
  when a picture genuinely carries what a sentence can't — most decisions don't
  need one. Rendering is sandboxed (SVG-profile sanitized, no scripts/HTML labels);
  if the source can't parse, the card shows it as text rather than breaking.
  Colour nodes by meaning with `:::class` markers (the palette is predefined — don't
  write your own `classDef`): append the class to a node, e.g. `B[has env]:::ok`.
  `:::ok` green (success path), `:::bad` red (failure path), `:::fix` amber (the fix),
  `:::info` cyan (a note), `:::warn` dim amber, `:::start` grey (neutral entry). Tag
  only the nodes that carry meaning; leave plumbing nodes untagged.

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
--reason   "A singleton keyed by a PID file (~/.local/share/q-lab/cockpit/daemon.json) runs once;
            every session's SSE just subscribes to it."
--facet    "REJECTED: spawning a server for each session — sessions open and
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
- `log` can auto-register the live session on its first write. If the registry
  does not yet know the provider, include `--provider <provider>`.
- **Handoff (`--needs-call`)** marks the moment autopilot hands the stick back
  to the user. Supply the choices via `--option`, then immediately park with:

  ```bash
  bun <plugin-root>/skills/cockpit/scripts/cockpit.ts wait <id>
  ```

  Run `wait` according to the **wait policy in your provider reference** (Claude
  Code parks it as a background task; Codex blocks in the foreground). It
  requires the dashboard daemon (Step 3) to be running. `cockpit send <id>
  <answer>` is the terminal twin of a UI option button — both are part of this
  plugin's control-loop bridge between a parked session and the user's answer.

## While a session is live — decide in the open, ask through the cockpit

**First decide whether this even needs a question.** The decision trail should be
*predominantly your own autonomous calls* — the reasoning a `git diff` can't
show. Log those as plain `log` cards (decision / reason / facets / tradeoff)
whenever a future reader would ask "why was it done this way?" That is the bulk
of a healthy trail. `needs_your_call` is the **exception, not the default**:
reserve it for a genuine **fork only the user can settle** (which heading to take)
or **information only they have**. Do not turn a call you can make yourself into a
question — gating what you could have decided inverts the trail into a list of
prompts and buries your reasoning, leaving the user feeling they made every
decision and you made none. If you can decide and explain, decide and log it;
gate only when you genuinely cannot proceed without them.

When you do need the user, the cockpit is their single surface for being asked.
While a session is active, **route that question through `needs_your_call` — not
the harness question tool (e.g. `AskUserQuestion`) and not a bare chat prompt.**
This also applies when another skill or workflow says to "ask the user": if
Cockpit is live in this conversation, translate that ask into a
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

If the session is already parked on a `needs_your_call` and the user answers in
the agent UI/chat instead of the cockpit dashboard, treat that message as the
answer to the open call — do not ask them to repeat it in cockpit. Immediately
record it through the same bridge:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts send <id> "<answer from chat>"
```

Use `--call <callId>` if you have the call id from the preceding `log`
command; otherwise `send` resolves the latest open call from the session log.
Then continue from the delivered answer and mention briefly that the chat reply
was recorded in the cockpit trail. This keeps the `needs_your_call` card's log
state closed with a durable `response` record, even when the user answers from
the harness UI rather than the dashboard.

## Notes

- Commands use **`<plugin-root>`** — an **absolute filesystem path**, never an
  environment variable. Your provider reference (Step 0) says how to resolve it.
  Substitute the resolved absolute path into each command — never type a `${...}`
  placeholder (e.g. `${CLAUDE_PLUGIN_ROOT}`) into a Bash command; it is empty in
  the shell and collapses the path to a broken `/skills/...`.
- The cockpit CLI path resolves from the skill base-dir banner in the
  instructions.
- One session = one log file; concurrent sessions never share a file.
