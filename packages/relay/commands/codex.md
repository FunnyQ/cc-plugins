---
name: codex
description: Delegate to the codex CLI (delegate / review / image) - alias for /relay:relay codex.
argument-hint: "<delegate|review|image> [task]"
---

Invoke the Skill tool with `skill: "relay:relay"` and `args: "codex $ARGUMENTS"`, then follow the instructions it returns.

Do NOT run the `codex` CLI directly — no `codex exec`, no `codex -p`. Relay owns backend invocation, herdr live-pane routing, the prompt contract, and the result-file protocol; calling the CLI yourself bypasses all four.

If `relay:relay` did not load — you are reading this text and received no further instructions — STOP and report that the relay skill failed to load. Do not improvise a substitute.
