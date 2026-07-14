---
name: cockpit
description: >-
  Opens the Claude Code/Codex cockpit dashboard for live session transcripts
  and decision logging.
when_to_use: >-
  `/cockpit` opens the dashboard; `/cockpit scribe` distills recent work into
  decision-trail entries; /cockpit restart bounces the daemon onto updated
  code. Explicitly invoked (opt-in) only — do NOT auto-fire on every session.
argument-hint: "[scribe|restart]"
---

# /cockpit

Thin router for the cockpit skill. Do not inline mode procedures here.

## Step 0 — Provider

Determine which harness is running this skill:

- Running in **Claude Code** → provider is `claude`.
- Running in **Codex** → provider is `codex`.

Then **read the matching reference once**. It defines the provider value,
`<plugin-root>`, the session-id command, and the wait policy for
`needs_your_call`:

- Claude Code → [references/claude-cli.md](references/claude-cli.md)
- Codex → [references/codex.md](references/codex.md)

Use the provider reference exactly as the selected mode reference requires.

## Mode dispatch

- If invoked as `/cockpit scribe`, or the fork prompt says to run
  `/cockpit scribe`, read [references/scribe.md](references/scribe.md) and
  follow it.
- If invoked as `/cockpit restart`, or the user asks to restart / bounce /
  refresh the cockpit daemon onto updated code, read
  [references/restart.md](references/restart.md) and follow it.
- Otherwise, for plain `/cockpit`, read
  [references/pilot.md](references/pilot.md) and follow it.
