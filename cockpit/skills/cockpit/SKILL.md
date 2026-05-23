---
name: cockpit
description: >-
  Start a per-project cockpit session for Claude Code or Codex: propose a
  project goal + this session's goal, confirm them with Q, then capture the goal
  record and begin a distilled decision trail. Trigger phrases include:
  "/cockpit-start", "start cockpit", "set session goal", "開始 cockpit",
  "設定這次的目標". This skill is EXPLICITLY invoked (opt-in) — do NOT auto-fire
  on every session. Use it when Q wants to set a destination for this leg of work
  and watch the decision trail steer toward it in the cockpit dashboard.
---

# /cockpit-start

Capture a goal at session start and open a decision trail for this project —
the data the cockpit dashboard visualizes. This is the windshield: set where
we're going, then log the turns a diff can't explain.

**Opt-in.** Only run when Q invokes it (`/cockpit-start`, "設定這次的目標", …).
Never auto-start on session open — not every session deserves a goal.

## Provider

Determine which harness is running this skill:

- **Claude Code**: provider is `claude`.
- **Codex**: provider is `codex`.

Use the same provider value for `find-session.ts` and `cockpit.ts start`.
The cockpit storage, decision log, dashboard, and wait/send bridge are shared by
both providers.

Resolve `<plugin-root>` from the installed plugin root that contains this skill.
In Claude Code this is usually `${CLAUDE_PLUGIN_ROOT}`. In a development checkout
from this repository, use `cockpit` from the repo root, for example
`bun cockpit/skills/cockpit/scripts/cockpit.ts ...`.

## Procedure

Follow this order strictly. **The human holds the stick at goal-setting** — this
mirrors `needs_your_call`: nothing is written until Q confirms.

### 1. Determine the session id

Use the current harness session id, because the dashboard uses it to join the
decision log to the live transcript:

```bash
bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider <claude|codex>
```

- Claude: finds the most-recently-touched transcript under
  `~/.claude/projects/**/<id>.jsonl` for this project.
- Codex: reads `~/.codex/state_5.sqlite`, finds the latest non-archived thread
  for this project cwd, and uses its thread id.

If it exits non-zero (no transcript/thread yet), generate one
(`crypto.randomUUID()`) and note which id you used. For Codex, prefer retrying
once after a tool call before falling back, because the thread row normally
exists once the session has written state.

### 2. Propose goals (don't write yet)

Draft two one-line goals from the conversation + repo state:

- **`project_goal`** — the persistent destination for this project. If
  `<project>/.cockpit/project-meta.md` already exists, reuse / refine its
  frontmatter `project_goal` rather than inventing a new one.
- **`session_goal`** — what *this* leg of the journey achieves.

Keep each to one line. Q reacts and edits; he doesn't write from scratch.

### 3. Human gate — confirm goals + log language

Present both goals to Q with the structured question tool when available, or ask
plainly. Q confirms, edits, or rejects. **Do not run any `cockpit` command until
Q confirms.** If Q rejects, stop — write nothing.

In the same gate, settle the **decision-log language** (`log_language`) — the
language you'll write decision/reason/tradeoff entries in:

- If `project-meta.md` already has a `log_language`, reuse it silently — it's a
  per-project setting, don't re-ask.
- Otherwise ask. Default to English, then add options inferred from context —
  the language Q is writing in now, and any languages from repo/global
  instructions.

### 4. Write (only after confirmation)

Run, substituting the confirmed text, provider, session id, and chosen language
(omit `--log-language` to keep an existing value / default to English):

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

The trail is only useful if Q can see it, so bring up the dashboard. Run it as a
background task — it's a long-lived server that would otherwise block:

```bash
bun <plugin-root>/skills/cockpit/scripts/serve-dashboard.ts
```

Then tell Q the URL it prints (default `http://localhost:5858`). See **The
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

During implementation, append decisions a **diff can't explain** (skip busywork
like "created the User model"). Write `--decision` / `--reason` / `--tradeoff` in
the project's **`log_language`** (the `project-meta.md` frontmatter set at start;
default English) — read it back if you're unsure which language is in effect:

```bash
bun <plugin-root>/skills/cockpit/scripts/cockpit.ts log \
  --session <id> \
  --decision "what was decided / done" \
  --reason   "why — the part a diff can't show" \
  [--tradeoff "what was given up"] \
  [--file path/a.ts --file path/b.ts] \
  [--needs-call --option "A" --option "B"]
```

- `--file` and `--option` are repeatable.
- `log` does not need `--provider` after `start`; the existing registry entry
  keeps the provider. If logging before `start`, include `--provider codex` for
  Codex.
- **Handoff (`--needs-call`)** marks the moment autopilot hands the stick back
  to Q. Supply the choices via `--option`, then immediately run
  `cockpit wait <id>` to park for Q's answer:

  ```bash
  bun <plugin-root>/skills/cockpit/scripts/cockpit.ts wait <id>
  ```

  Harness policy:

  - **Claude Code**: run `cockpit wait <id>` as a background task. Claude Code
    surfaces completed background task output back into the conversation, so the
    session can stay parked until Q answers in the dashboard.
  - **Codex**: run `cockpit wait <id>` in the foreground as a blocking tool
    call, and do not send the final response while it is waiting. The wait
    stdout is the wake-up signal. When Q clicks a dashboard option, the command
    prints the answer and this same turn should continue from that answer.
  - **Other harnesses**: use foreground wait unless the harness is known to
    resume the conversation from background task stdout.

  Requires the dashboard daemon (step 5) to be running. `cockpit send <id>
  <answer>` is the terminal twin of a UI option button — both are part of this
  plugin's control-loop bridge between a parked session and Q's answer.

## Notes

- One session = one log file; concurrent sessions never share a file.
- The persistent **project** goal lives only in `project-meta.md` frontmatter
  (single source of truth). It is not duplicated into the log. The log's goal
  record carries only `session_goal`.
