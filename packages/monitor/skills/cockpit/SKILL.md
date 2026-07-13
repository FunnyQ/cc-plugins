---
name: cockpit
description: >-
  /cockpit opens the Claude Code or Codex cockpit dashboard and may set the
  global decision-log language; /cockpit scribe lets a fork distill recent work
  into typed trail entries; /cockpit restart bounces the dashboard daemon onto
  this install's code after a plugin update or a script edit. This skill is
  EXPLICITLY invoked (opt-in) — do NOT auto-fire on every session.
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
