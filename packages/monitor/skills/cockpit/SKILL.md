---
name: cockpit
description: >-
  /cockpit opens the Claude Code or Codex cockpit dashboard and may set the
  global decision-log language; /cockpit scribe lets a fork distill recent work
  into typed trail entries. This skill is EXPLICITLY invoked (opt-in) — do NOT
  auto-fire on every session.
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

- Claude Code → [references/claude.md](references/claude.md)
- Codex → [references/codex.md](references/codex.md)

Use the provider reference exactly as the selected mode reference requires.

## Mode dispatch

- If invoked as `/cockpit scribe`, or the fork prompt says to run
  `/cockpit scribe`, read [references/scribe.md](references/scribe.md) and
  follow it.
- Otherwise, for plain `/cockpit`, read
  [references/pilot.md](references/pilot.md) and follow it.

- `/cockpit` → provider reference, then `references/pilot.md`.
- `/cockpit scribe` → provider reference, then `references/scribe.md`.
