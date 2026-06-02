---
name: thoughtful
description: >-
  Turn on thoughtful auto-logging for this cockpit session. After you invoke it,
  the agent — at its own judgment, when it has just done something worth
  recording — spawns a background fork to write typed cockpit decision-trail
  entries. EXPLICIT opt-in: trigger on "/thoughtful", "thoughtful mode",
  "開啟自動日誌", "讓 cockpit 自動記錄". Do NOT auto-fire on every session.
---

# Thoughtful Mode

From now on, log the interesting parts of this session automatically — no `cockpit start` required, no manual `cockpit log`. When you complete something genuinely worth recording, spawn a background fork to run `/cockpit-scribe`, which distills the work into typed decision-trail entries. The rest of the session continues normally.

---

## WHEN to log

**Log when you have just:**
- Made a non-obvious decision between real alternatives → a **decision**
- Wrote something that looks wrong but is deliberate → a **rationale**
- Solved a tricky problem, debugged something subtle, or overturned an
  assumption → a **learning**
- Hit a sharp edge, precondition, or ordering trap the pilot must remember → a
  **caveat**

These four lenses are independent — a single chunk of work often deserves two or
three of them at once, not just the decision. The fork (`/cockpit-scribe`)
sweeps all four; your job here is only to notice the moment is worth a fork.

**Skip (do not spawn a fork):**
- Typo fixes, single-line edits, pure formatting
- Simple lookups or restating something already logged
- Trivial confirmations with no decision content

**Volume bias:** one fork per logical chunk of work, not one per file or step. Quality over volume.

---

## HOW to log

The spawn mechanism differs by surface — this plugin ships both `.claude-plugin` and `.codex-plugin`, so the skill loads under both.

### On Claude Code

Use the **Agent tool** and **omit `subagent_type`** entirely. Omitting it causes the fork to inherit your full conversation context (cache-warm after a recent turn — cheap and already knows the "why"). Run it background, fire-and-forget:

```
Agent tool call:
  prompt: "Run the /cockpit-scribe skill to distill the work we just completed into cockpit decision-trail entries."
  subagent_type: <omit — do not set>
```

Do not wait for completion. Continue or stop as you normally would.

> **Why omit `subagent_type`?** A custom subagent_type creates a clean slate — it loses the inherited context and the cache-warm cost benefit. The whole point is that the fork already knows the "why".

### On Codex

Spawn a **background sub-agent with `fork_context: true` and no `agent_type`** — this inherits the current context (the Codex equivalent of Claude's context-inheriting fork). Run it fire-and-forget with a prompt that **states the surface is Codex**, so the fork passes `--provider codex` to `cockpit scribe` (it defaults to Claude otherwise and would resolve the wrong session):

```
"You are running under Codex. Run the /cockpit-scribe skill to distill the work we just completed into cockpit decision-trail entries — pass --provider codex on every cockpit scribe call."
```

---

## No cockpit start needed

This works without `cockpit start`. The first `cockpit scribe` write auto-registers the session (`tracked: true`), so it becomes visible in the dashboard immediately. If you also want a goal / north-star for the session, run `/cockpit` separately — that's a different path.

---

## When the fork reports back

When the background sub-agent later reports completion, no action is needed. Acknowledge and move on.

---

## Best-effort caveat

This is a standing instruction, not a guarantee. Over a long session the mode may fade — when you notice a worthy moment, re-affirm the behavior to yourself. Missing some entries is acceptable; do not force a fork on trivial turns to compensate.
