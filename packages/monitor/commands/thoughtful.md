---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---

From now on, auto-log the interesting parts of this session as a standing best-effort behavior. You are the main agent; when you complete a logical chunk of work that is genuinely worth recording, spawn a background fork to distill it into cockpit decision-trail entries. Do not run `cockpit start`; the first `cockpit scribe` write auto-registers the session.

Fire a fork when you have just made a non-obvious decision between real alternatives, used an implementation that looks odd but is deliberate, learned something tricky while debugging or correcting an assumption, or found a sharp caveat, precondition, or ordering trap that should be remembered.

Skip the fork for typos, one-line trivial edits, pure formatting, simple lookups, restating something already logged, and confirmations with no decision content. Prefer one fork per logical chunk of work, not one per file or step.

Before spawning any fork, resolve the current main-agent session id using the
selected Cockpit provider's session-id command. This is the **initiating parent
session**. Put that literal id in the fork prompt as `<parent-session-id>`; do
not ask the fork to resolve it again. Context inheritance does not imply session
identity: a background fork can have its own transcript/session row.

On Claude Code, use the Agent tool in the background with `subagent_type: "fork"` so the fork inherits the current conversation context (the "why"). Use this exact prompt:

```text
Run /cockpit scribe to distill the work we just completed into cockpit decision-trail entries. The initiating parent session is <parent-session-id>. Pass --session <parent-session-id> on every cockpit scribe call.
```

Use `"fork"` specifically — omitting `subagent_type` (or naming any other type) starts a fresh agent with no conversation context, which defeats the point. Fire-and-forget, then continue or finish normally.

On Codex, spawn a background sub-agent with `fork_context: true` and no `agent_type`, so it inherits the current context. Use a prompt that states the surface is Codex and that every cockpit scribe call must pass `--provider codex`, for example:

```text
You are running under Codex. Run /cockpit scribe to distill the work we just completed into cockpit decision-trail entries. The initiating parent session is <parent-session-id>. Pass --session <parent-session-id> and --provider codex on every cockpit scribe call.
```

Codex has no SessionStart hooks, so `/thoughtful` is the only way to enable this behavior there. When a background fork later reports completion, no action is needed.

This mode is best-effort, not a guarantee. Over a long session it may fade; when you notice a worthy moment, re-affirm the behavior internally. Missing some entries is acceptable, and you should not force forks on trivial turns to compensate.
