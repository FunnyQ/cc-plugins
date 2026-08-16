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
  `/cockpit scribe`, read [references/scribe.md](references/scribe.md).
  Follow it.
- If invoked as `/cockpit restart`, or the user asks to restart, bounce, or
  refresh the cockpit daemon onto updated code, read
  [references/restart.md](references/restart.md). Follow it.
- Otherwise, for plain `/cockpit`, read
  [references/pilot.md](references/pilot.md). Follow it.

## OpenCode only — skip on Claude Code and Codex

Running in **OpenCode** → provider is `opencode`; the CLI accepts
`--provider opencode`. There is no OpenCode provider reference file: take the
provider value from here, skip Step 0's reference read, and go straight to the
mode reference, resolving every script from the OpenCode skill root below.

**Reads and sends both work.** Transcript reads, the decision trail, and
`needs_your_call` behave as they do for the other providers. The send bridge
ships: `scripts/opencode-send.ts`, served by the cockpit daemon at
`/api/send-opencode-message`. It discovers the TUI server from
`OPENCODE_TUI_SERVER_URL` or `OPENCODE_SERVER_URL`, falls back to a `ps` scan
for `opencode --port <n>`, health-checks `/global/health`, resolves the session
through `/session/<id>`, and delivers via `/tui/append-prompt` then
`/tui/submit-prompt`.

Two preconditions, both observed on opencode 1.18.18:

- **Start the TUI with a port.** Run `opencode --port <n>`, or set
  `OPENCODE_TUI_SERVER_URL` before the cockpit daemon starts. An
  `opencode serve` process does **not** count — discovery scans `ps` for
  `opencode` and explicitly excludes `serve`, `web`, and `attach`.
- **A successful send is not a delivery receipt.** `/tui/append-prompt`
  returns `200 true` even with no TUI attached, so treat delivery as
  best-effort and confirm through the session itself.

Scripts are at `~/.config/opencode/skills/cockpit/scripts/`;
`CLAUDE_PLUGIN_ROOT` is empty there.
