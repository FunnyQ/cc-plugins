---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---

From now on, auto-log the interesting parts of this session. Treat this as a standing best-effort behavior.

You are the main agent. When you complete a logical chunk of work that is genuinely worth recording, spawn a background fork. The fork distills the work into cockpit decision-trail entries. Do not run `cockpit start`. The first `cockpit scribe` write auto-registers the session.

After a non-obvious decision between real alternatives, fire a fork. After using an implementation that looks odd but is deliberate, fire a fork. After learning something tricky while debugging, or after correcting an assumption, fire a fork. After finding a sharp caveat, precondition, or ordering trap worth remembering, fire a fork.

Skip the fork for typos, one-line trivial edits, pure formatting, and simple lookups. Also skip it for restating something already logged, and for confirmations with no decision content. Prefer one fork per logical chunk of work, not one per file or step.

Before spawning any fork, resolve the current main-agent session id. Use the
selected Cockpit provider's session-id command. This is the **initiating parent
session**. Put that literal id in the fork prompt as `<parent-session-id>`. Do
not ask the fork to resolve it again. Context inheritance does not imply session
identity: a background fork can have its own transcript/session row.

On Claude Code, use the Agent tool in the background with `subagent_type: "fork"`. This makes the fork inherit the current conversation context (the "why"). Use this exact prompt:

```text
Run /cockpit scribe to distill the work we just completed into cockpit decision-trail entries. The initiating parent session is <parent-session-id>. Pass --session <parent-session-id> on every cockpit scribe call.
```

Use `"fork"` specifically. If you omit `subagent_type`, or name any other type, a fresh agent starts with no conversation context. This defeats the point. Do not wait for the fork. Continue or finish the current turn normally.

On Codex, spawn a background sub-agent with `fork_context: true` and no `agent_type`. This makes it inherit the current context. Use a prompt that states the surface is Codex. The prompt must also say every cockpit scribe call needs `--provider codex`. For example:

```text
You are running under Codex. Run /cockpit scribe to distill the work we just completed into cockpit decision-trail entries. The initiating parent session is <parent-session-id>. Pass --session <parent-session-id> and --provider codex on every cockpit scribe call.
```

Codex has no SessionStart hooks. So `/thoughtful` is the only way to enable this behavior there. When a background fork later reports completion, no action is needed.

This mode is best-effort, not a guarantee. Over a long session, this behavior may fade. When you notice a worthy moment, re-affirm the behavior internally. Missing some entries is acceptable. Do not force forks on trivial turns to compensate.
