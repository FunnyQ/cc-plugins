---
name: opencode
description: Delegate to the opencode CLI (delegate / review) - alias for /relay:relay opencode.
argument-hint: "<delegate|review> [task]"
---

Invoke the Skill tool with `skill: "relay:relay"` and `args: "opencode $ARGUMENTS"`, then follow the instructions it returns.

Do NOT run the `opencode` CLI directly — no `opencode run`. Relay owns backend invocation, herdr live-pane routing, the prompt contract, and the result-file protocol; calling the CLI yourself bypasses all four.

If `relay:relay` did not load — you are reading this text and received no further instructions — STOP and report that the relay skill failed to load. Do not improvise a substitute.
