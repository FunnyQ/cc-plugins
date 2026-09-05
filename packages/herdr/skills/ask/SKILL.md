---
name: ask
description: >-
  Ask another project's agent a question and get its answer back — an agent
  already running in its Herdr workspace when one is open, otherwise a known
  project resolved from the herdr-workbench registry or zoxide, spun up on
  demand.
when_to_use: >-
  Use when you need an ANSWER from a different project, not just to hand it
  work — "what version of X does <project> use", "ask the api-service agent
  what port it runs on", "check with <project> whether Y is done". If you just
  want to hand off work and move on with no answer needed, use `tell` instead.
argument-hint: <project-or-fragment> <question>
version: 1
---

# Ask another project's agent

`ask` is `tell`'s round-trip sibling: same addressing, same fallback chain, but it waits for the target to actually answer and hands you back clean text instead of firing and forgetting.

## Do it

**Always run this through Bash with `run_in_background: true`.** `ask` can block up to 10 minutes waiting for an answer — running it in the foreground would stall the whole conversation for that long. Poll for the result the normal way (you'll get a completion notification); do not add your own sleep loop around it.

```bash
HERD="$SKILL_DIR/../herdr/scripts/herd.ts"

bun "$HERD" ask api-service "what port does the dev server run on?"
bun "$HERD" ask web-app/dashboard "is the migration finished?"
```

Resolve `$SKILL_DIR` the same way `tell` does — from the load-time **"Base directory for this skill"** banner, not `${CLAUDE_PLUGIN_ROOT}`.

## Addressing and fallback

Identical to the `tell` skill — read it first if you have not: same fragment matching (workspace label / tab label / agent name / pane id / cwd, slash-narrowed), same three-layer fallback when no live agent matches (project registry → zoxide → auto-spawn into a fresh workspace), same hard refusal on ambiguity at either layer. Everything in `tell`'s `## Rules` about never picking for the user, reporting a spawned agent, and never touching your own pane applies here unchanged.

The one difference in fallback behavior: a pane `ask` spawns itself gets **closed** once the answer is collected, unless the caller passed `--keep-pane`. An agent that was already running before you asked it anything is never closed, no matter what.

## How the answer comes back

`ask` does not read the target's pane — pane text can't prove an answer is complete versus a mid-turn snapshot. Instead it writes the question to a file with instructions to write the final answer to a second file ending in a fixed sentinel, sends the target a one-line pointer to that file, and polls until the agent settles (`idle`/`done`) **and** the sentinel has landed. Both conditions, not either — a settled status with no valid file yet is not an answer.

## Rules

**Timeout is not failure.** Default wait is 10 minutes. If it's not answered by then, the result carries `{pending: true}` plus a ready-to-run `collect` command (target + result-file path) in the `report` field. Run that verbatim to redeem the answer later — **do not call `ask` again** with the same question; the target may still be working on the first one, and asking twice just adds a second competing prompt to its input.

**A settled agent with no file is a real failure, not a timeout.** If the target's status goes idle/done but it never wrote a valid result, `ask` throws instead of returning pending — waiting longer will not produce an answer the target never intended to write. Report this to the user; it usually means the target ignored the file-contract instructions or hit an error before finishing.

**`collect` never closes anything.** It doesn't know whether the pane it's polling was one `ask` spawned or one that was already running, so closing there could take down someone else's session. Only `ask` itself ever closes a pane, and only the one it spawned.

**Ask before telling anything destructive** still applies if the question itself would make the target act — same bar as `tell`.

For the rest of the wrapper (`spawn`, `send`, `keys`, `wait`, `read`, `close`, `tell`), see the `herdr` skill.
