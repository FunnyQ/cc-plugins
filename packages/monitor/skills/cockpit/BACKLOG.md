# Cockpit — Backlog

Enhancement ideas for the cockpit dashboard, surfaced 2026-05-27 while testing the
Permission Relay feature. Today the cockpit is a deliberately minimal **UI→agent
text barge-in bridge**: the send box POSTs raw text to `/api/send-message`, the
channel injects it as `<channel source="cockpit">…</channel>` into the live turn,
and the agent's reply rides the transcript. These items would grow it toward a
fuller cockpit-only workflow (so a user never has to drop back to the Claude Code
TUI). None are built yet.

> Driver: a **cockpit-only** workflow. Anything that still forces a trip to the TUI
> (slash commands, `@` mentions, skill discovery, starting a session) is a gap.

---

## 1. `@` file mention / file tree in the send box

**Priority: high · Effort: low** — the easiest win.

The send box is plain text today; typing `@path` just sends the literal string (no
picker, no resolution). Add a file-tree / autocomplete to the send box that inserts
a real path into the message.

- Scope: a file browser (rooted at the session's project cwd, already known via the
  registry / `?project=`) + `@`-triggered autocomplete that inserts the path string.
- Out of scope (v1): uploading file *contents* — inserting the path is enough; the
  agent reads it.
- Open Q: respect `.gitignore` / hide `node_modules`?

## 2. Skill list panel

**Priority: medium · Effort: medium**

Surface the session's available skills in the dashboard so the user can see/trigger
them without the TUI.

- **Source caveat (important):** do **not** read plugin *manifests* — those list
  what's *installed*, but the user can disable skills, so manifests ≠ the actual
  *enabled* set. The real source is Claude Code's runtime state (settings
  enabled/disabled, or the session's available-skills context). Needs a docs lookup
  / empirical check before building — TBD.
- Triggering a skill from cockpit is really "inject `/skill-name` as a message" —
  but slash commands are a TUI-layer feature the agent can't execute from injected
  text (see item 4 / the `/clear` note), so a "trigger" button may be display-only
  until that's solved.

## 3. Spawn a new `claude` session from cockpit (needs a PTY)

**Priority: medium · Effort: high**

Today cockpit only *observes/attaches to* existing sessions (registry + transcript);
it does not start them — you still launch `claude` in a terminal. Letting cockpit
create a session means the daemon must spawn a `claude` process **attached to a
pseudo-terminal (PTY)**, not a plain pipe — otherwise `claude` detects a non-TTY
stdout and falls into `-p`/print non-interactive mode instead of an interactive
session.

- Approach: `node-pty` (`pty.spawn`), daemon owns the PTY lifecycle and streams its
  output into the transcript view; the existing send box becomes that session's
  stdin.
- Background: see the PTY explainer note in Obsidian (`📥 inbox/2026-05-27-*pty*`).
- Heaviest item: process/PTY lifecycle, cleanup, multiplexing multiple sessions.

## 4. (Related constraint) `/clear` and other slash commands

`/clear` and slash commands are **Claude Code TUI-layer** features — the agent never
receives them and can't trigger a context clear from injected channel text. A
cockpit "new session" (item 3) is the closest substitute for `/clear`. True
slash-command support from cockpit would need harness-level cooperation that doesn't
exist today; tracked here only as a known boundary, not a planned item.

---

_When ready to build, run `/probe-deep` on a chosen item to produce a PLAN + task
tree (same workflow as the Permission Relay feature)._
