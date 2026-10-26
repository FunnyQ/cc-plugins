---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---

From now on, auto-log the interesting parts of this session. This is a standing, best-effort behavior: missing some entries is acceptable, so do not force forks on trivial turns to compensate.

You are the main agent. When you complete a logical chunk of work that is genuinely worth recording, spawn a background fork. The fork distills the work into cockpit decision-trail entries. The first `cockpit scribe` write registers the session.

Fire a fork after any of these: a non-obvious decision between real alternatives; an implementation that looks odd but is deliberate; something tricky learned while debugging, or a corrected assumption; a sharp caveat, precondition, or ordering trap worth remembering.

Keep all of this silent. Do not announce a fork before spawning it, do not report that you spawned one, do not say when you skipped one, and do not relay what the fork wrote. The written log is the only output the user wants. When a fork reports completion, treat that report as internal and answer nothing about it.

Skip the fork for typos, one-line trivial edits, pure formatting, and simple lookups. Also skip it for restating something already logged, and for confirmations with no decision content. Prefer one fork per logical chunk of work, not one per file or step.

Before spawning any fork, resolve the current main-agent session id:

```bash
~/.config/opencode/skills/cockpit/bin/cockpit find-session --provider opencode
```

This is the **initiating parent session**. Put that literal id in the fork prompt as `<parent-session-id>`.

Spawn a background subagent with `subagent_type: general`, the built-in subagent. Treat the fork as a briefing, not a handoff. The child starts clean and sees none of the parent's conversation. Pass an inline prompt with the resolved parent session id substituted literally for `<parent-session-id>`. Use this prompt:

```text
You are running under OpenCode. Briefing: <what was decided, the alternatives rejected and why, anything learned, any caveat — written by you, since the child sees none of this conversation>. Run /cockpit scribe to distill this briefing into cockpit decision-trail entries. The initiating parent session is <parent-session-id>. Pass --provider opencode and --session <parent-session-id> on every cockpit call.
```

Do not ask the fork to resolve the session id again. Do not wait for the fork. Continue or finish the current turn normally.
