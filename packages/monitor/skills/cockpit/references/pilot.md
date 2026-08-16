# /cockpit pilot

Open the cockpit dashboard. Establish the live decision trail surface for
this project. This mode never writes planning records. It never asks for
planning confirmation.

## Step 1 — Resolve session id and language

The dashboard uses the harness session id to join the decision log to the
live transcript. Resolve that id and the configured decision-log language in
one call:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts prep --provider <provider>
```

If it exits non-zero because the session id cannot be resolved, generate one
with `crypto.randomUUID()`. Note which id you used. Check your provider
reference — it notes any provider-specific retry to try first.

**OpenCode only**: there is no banner. Scripts are at
`~/.config/opencode/skills/cockpit/scripts/`; `CLAUDE_PLUGIN_ROOT` is empty there.

This only resolves the id for use. It does not register the session. The
session auto-registers on the first `log` or `scribe` write.

## Step 2 — Optionally update language

If the user explicitly asks to change it, run:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts config --log-language "<lang>"
```

Write `--decision` / `--reason` / `--tradeoff` entries in the configured
language. Do not use per-project metadata for language.

## Step 3 — Open the cockpit

The trail is only useful if the user can see it, so open the dashboard. When
this session was launched with the cockpit channel, the daemon is **already
running**. The channel MCP launches it headless, with no browser. Either
way, run:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit-server.ts
```

This command is an idempotent **ensure + open**. If the daemon is already
up, it opens the browser and exits. If the daemon is not up — a Codex
session, or Claude launched without the channel flag — it launches the
daemon and opens the browser. On a cold boot the daemon is long-lived and
would otherwise block, so run it as a background task. Then tell the user
the URL (default `http://localhost:5858`). See **The dashboard daemon**
below.

## The dashboard daemon

One daemon serves every project's cockpit. You do not run a server per
session.

- **Singleton, idempotent.** A PID file at `~/.local/share/q-lab/cockpit/daemon.json` tracks the
  live instance. Running it again detects the running daemon. It opens the
  browser, prints the URL, and exits `0`. Re-running always lands the user
  on the cockpit, even when the daemon was launched headless by the channel
  MCP.
- **Binds `127.0.0.1:5858`.** Override with `--port <n>`. Pass `--no-open`
  to skip opening the browser — the channel MCP launches the daemon this
  way.
- **It will not kill a foreign process.** If port 5858 is held by something
  that is not a cockpit daemon, it exits `1` with a clear message. Re-run
  with `--port <n>`.
- **It powers `wait` / `send`.** The control loop talks to this daemon. The
  daemon must be running before you park a `cockpit wait` (see below).
- **Restarting onto new code.** Re-running `cockpit-server.ts` from the
  *same* install reuses the live daemon. It does not pick up a plugin
  update or a working-tree edit. Use `/cockpit restart` for that. Offer it
  after a `/monitor:install`, a plugin update, or an edit to any cockpit
  script. See [references/restart.md](restart.md).

## Logging decisions afterward

A decision card exists to carry what a `git diff` throws away: **the
thinking behind the change, not the change itself.** The diff already shows
*what* the code does. Your job here is to record *why it ended up this
way*. A future reader — or you, six months from now — should not have to
reverse-engineer it.

The filter for whether to log at all: **would someone reading the diff
later ask "why was it done this way?"** If yes, log it. If the diff
explains itself ("created the User model", "renamed a variable"), skip it.
A card that only restates the diff is noise in the trail.

Write `--decision` / `--reason` / `--tradeoff` in the configured language.
Read it back if you are unsure which is in effect:

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
  reasoning into its own labeled row. **You choose the label.** Pick the
  label that fits *this* decision. No two decisions involve the same
  dimensions. Below is a suggested vocabulary. Use it loosely, do not force
  it, and invent a label when none fit:
  - `PROBLEM` — what you understood the task to be, when it isn't obvious from the code.
  - `CONSTRAINT` — the limit that ruled out the cleaner option (perf, an API shape, compat, a deadline).
  - `REJECTED` — the approach a reader would expect, and why you didn't take it. Often the most useful row.
  - `ASSUMPTION` — what you're now leaning on that, if it changed, would break this.
  - `PRIOR-ART` — the existing pattern/decision you're following (or deliberately not).

  Reach only for the facets that *actually apply*. A card with one sharp
  `REJECTED` beats one padded with five hollow rows. Each facet renders as
  its own stencil row in the dashboard, so the card reads like a field
  manual of how the call was made.
- `--tradeoff` — what the choice *costs*: what you gave up. (A forward-looking
  risk often reads better as an `ASSUMPTION` or `RISK` facet — use whichever
  frames it best.)

`--reason` and each `--facet` body render as Markdown in the dashboard.

- `--diagram` — optional **Mermaid** source. Use it when structure beats
  prose: for a flow, a state machine, a sequence, or a dependency graph.
  Attach it only when a picture genuinely carries what a sentence cannot.
  When you decide to attach a `--diagram`, read
  [references/diagram.md](diagram.md) first.

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

The `REJECTED` row is the fork a future reader would otherwise rediscover by
trial. Now it is a labeled line they can scan to in a second.

**Example 3 — a `needs_your_call`, where the decision is the question itself:**

```bash
--decision "Persist pricing overrides — per-project or one global file?"
--reason   "Codex and Claude share a machine but rates differ per workspace; unclear
            whether you want one source of truth or per-repo control."
--needs-call --option "Global ~/.config" --option "Per-project .cockpit/"
```

The `--reason` still earns its place. It tells the user *why the fork
exists* before they pick. The answer then lands in the trail with its
context intact.

- `--session` is optional. When omitted, `log` resolves the current session
  itself — Claude via `CLAUDE_CODE_SESSION_ID`, Codex via its state DB. This
  way a decision cannot be misfiled to the wrong or a stale session. Pass
  `--session` explicitly only when logging for a session other than the
  live one.
- `--facet`, `--file`, and `--option` are repeatable.
- `log` can auto-register the live session on its first write. If the registry
  does not yet know the provider, include `--provider <provider>`.
- **Handoff (`--needs-call`)** marks the moment autopilot hands the stick back
  to the user. Supply the choices via `--option`. Then park immediately with:

  ```bash
  bun <plugin-root>/skills/cockpit/scripts/cockpit.ts wait <id>
  ```

  Run `wait` according to the **wait policy in your provider reference**.
  Claude Code parks it as a background task. Codex blocks in the
  foreground. `wait` requires the dashboard daemon (Step 3) to be running.
  `cockpit send <id> <answer>` is the terminal twin of a UI option button.
  Both are part of this plugin's control-loop bridge between a parked
  session and the user's answer.

  `wait` exit codes: `0` an answer was delivered on stdout, `3` the call is no
  longer open, `4` nobody is watching this session in the cockpit. On `4`, ask
  in the terminal instead — see "Nobody is watching" below.

## While a session is live — decide in the open, ask through the cockpit

**First decide whether this even needs a question.** The decision trail
should be *predominantly your own autonomous calls* — the reasoning a `git
diff` can't show. Log those as plain `log` cards (decision / reason /
facets / tradeoff) whenever a future reader would ask "why was it done this
way?" That is the bulk of a healthy trail. `needs_your_call` is the
**exception, not the default**: reserve it for a genuine **fork only the
user can settle** (which heading to take) or **information only they
have**. Do not turn a call you can make yourself into a question. Gating
what you could have decided inverts the trail into a list of prompts. It
buries your reasoning. The user is then left feeling they made every
decision, and you made none. If you can decide and explain, decide and log
it. Gate only when you genuinely cannot proceed without the user.

When you do need the user, the cockpit is their single surface for being
asked. While a session is active, **route that question through
`needs_your_call`. Do not use the harness question tool (e.g.
`AskUserQuestion`). Do not use a bare chat prompt.** This also applies when
another skill or workflow says to "ask the user." If Cockpit is live in
this conversation, translate that ask into a `needs_your_call` log entry.
Wait for the cockpit answer instead of asking in chat. Two cases, one
channel:

- **A decision fork** — autopilot hit a branch and needs the user to pick a heading.
- **Missing information** — you need a value, preference, or confirmation only the user
  can give before continuing.

Both belong in the cockpit. Log the `--needs-call` — the `--decision`
carries the question, and each `--option` is one suggested choice. Options
are optional: omit them for a pure free-text ask. Then park with
`cockpit wait <id>`, per your provider's wait policy. The ask surfaces as
the warm "your turn" moment. The user answers in the dashboard, or via
`cockpit send <id> <answer>`. The question and its answer then land in the
trail. Falling back to `AskUserQuestion` splits the user's attention off
the cockpit. It leaves the decision trail with a hole where a turn should
be.

### Nobody is watching — ask in the terminal

The rule above assumes the user wants to be asked in the cockpit. By default
they do not — the terminal is the default asking surface. `wait` exits `4`
unless **both** hold:

- the user turned on the cockpit's **Ask me here** switch, and
- a cockpit tab is connected with this session selected.

The switch is global and off by default. The user flips it in the dashboard,
or with `cockpit config --answer-here on`. Never flip it for them: it states
where they want to be interrupted, which is theirs to decide.

On exit `4`, ask the same question with the harness tool (`AskUserQuestion`)
or in chat. Then record their answer through the bridge, so the card still
closes with a durable `response`:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts send <id> "<answer>"
```

Never re-run `wait` for that same call after falling back. The user is
answering in the terminal, and a second park would strand the session.

Keep logging the `--needs-call` card first, even on this path. The trail
records the question wherever it was answered.

If the session is already parked on a `needs_your_call` and the user
answers in the agent UI or chat instead of the cockpit dashboard, treat
that message as the answer to the open call. Do not ask them to repeat it
in cockpit. Immediately record it through the same bridge:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts send <id> "<answer from chat>"
```

Use `--call <callId>` if you have the call id from the preceding `log`
command. Otherwise, `send` resolves the latest open call from the session
log. Then continue from the delivered answer. Mention briefly that the
chat reply was recorded in the cockpit trail. This keeps the
`needs_your_call` card's log state closed with a durable `response`
record, even when the user answers from the harness UI rather than the
dashboard.

## Notes

- Commands use **`<plugin-root>`** — an **absolute filesystem path**, never
  an environment variable. Your provider reference (Step 0) says how to
  resolve it. Substitute the resolved absolute path into each command.
  Never type a `${...}` placeholder (e.g. `${CLAUDE_PLUGIN_ROOT}`) into a
  Bash command. It is empty in the shell, and it collapses the path to a
  broken `/skills/...`.
- The cockpit CLI path resolves from the skill base-dir banner in the
  instructions.
- One session = one log file. Concurrent sessions never share a file.
