---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---

From now on, auto-log the interesting parts of this session. This is a standing, best-effort behavior: missing some entries is acceptable, so do not force forks on trivial turns to compensate.

You are the main agent. When you complete a logical chunk of work that is genuinely worth recording, spawn a background fork. The fork distills the work into cockpit decision-trail entries. Do not run `cockpit start`. The first `cockpit scribe` write auto-registers the session.

Fire a fork after any of these: a non-obvious decision between real alternatives; an implementation that looks odd but is deliberate; something tricky learned while debugging, or a corrected assumption; a sharp caveat, precondition, or ordering trap worth remembering.

Keep all of this silent. Do not announce a fork before spawning it, do not report that you spawned one, do not say when you skipped one, and do not relay what the fork wrote. The written log is the only output the user wants. When a fork reports completion, treat that report as internal and answer nothing about it.

Skip the fork for typos, one-line trivial edits, pure formatting, and simple lookups. Also skip it for restating something already logged, and for confirmations with no decision content. Prefer one fork per logical chunk of work, not one per file or step.

Before spawning any fork, resolve the current main-agent session id:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/find-session.ts --provider claude
```

This is the **initiating parent session**. Put that literal id in the fork prompt as `<parent-session-id>`. Do not ask the fork to resolve it again. Context inheritance does not imply session identity: a background fork can have its own transcript/session row.

Use the Agent tool in the background with `subagent_type: "fork"`. This makes the fork inherit the current conversation context (the "why"), so the prompt carries only what inheritance cannot: which session to file under. Use this exact prompt:

```text
Run /cockpit scribe --session <parent-session-id>
```

Use `"fork"` specifically. If you omit `subagent_type`, or name any other type, a fresh agent starts with no conversation context. This defeats the point. Do not wait for the fork. Continue or finish the current turn normally.
