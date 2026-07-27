---
name: claude-cli
description: Delegate to the claude CLI (delegate / review) - alias for /relay:relay claude.
argument-hint: "<delegate|review> [task]"
---

Invoke the Skill tool with `skill: "relay:relay"` and `args: "claude $ARGUMENTS"`. Follow the instructions it returns.

Do NOT run the `claude` CLI directly — no `claude -p`. Relay owns backend invocation, herdr live-pane routing, the prompt contract, and the result-file protocol. Calling the CLI yourself bypasses all four.

If `relay:relay` did not load, you are reading this text. You received no further instructions. STOP. Report that the relay skill failed to load. Do not improvise a substitute.
