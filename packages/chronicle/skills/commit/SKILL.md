---
name: commit
description: >-
  Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split.
when_to_use: >-
  When you want to commit the current changes now. The `simple` argument
  forces one commit instead of the auto-decided atomic split. Human-invoked
  only — do NOT auto-fire from an incidental mention of committing.
argument-hint: "[simple]"
---

# Chronicle Commit

A commit run is one agent, one file, and two script calls.
`scripts/analyze-changes.ts` hands back the changeset, the recent commits and the
message template as one digest. `scripts/commit.ts apply` reads the plan file the
agent writes from it, decides the shape, checks the plan covers the changeset,
stages, commits, and verifies. Re-running `apply` finishes an interrupted run
instead of duplicating it.

Spawn ONE **Lawspeaker** and let it run the whole flow. That keeps every diff and
every line of git output out of the main conversation, which is the only reason
this work happens in a subagent at all.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:lawspeaker   (subagent_type — a custom agent, NOT a fork)
       1. bun analyze-changes.ts   → the digest: files, diffs, template
       2. group, order, write the plan file (both shapes' prose)
       3. bun commit.ts apply      → shape decided, committed, verified
```

Spawn via `subagent_type`, never a fork. Spawn exactly one Lawspeaker, in one
`Agent` call, with no `name`. It spawns nobody, so this flow no longer needs a
raised `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` — chronicle's other skills still do.

The role lives at `packages/chronicle/agents/lawspeaker.md` and auto-registers as
`chronicle:lawspeaker`.

`simple` skips classification, cohesion grouping, `moduleSpread`, and ordering:
that work was always discarded, because `decideShape` returns `simple` before it
reads a single signal.

## The main agent's job (thin)

1. **Parse the mode**. `mode: "simple"` if the argument is `simple`
   (case-insensitive) or the user's phrasing clearly asks for one commit ("one
   commit", "快速 commit", "single commit"). Otherwise `mode: "auto"`.
2. **Distill `contextBrief`** — terse intent and non-obvious rationale from this
   chat. The Lawspeaker sees the diff but not the conversation, so this is the only
   source of *why* for every commit body it writes. Everything the reader of a
   commit would need to know, and nothing else.
3. **Spawn the Lawspeaker** (`subagent_type: "chronicle:lawspeaker"`), passing:
   - the **skill directory** — the skill's load-time "Base directory for this
     skill" banner value, so it can resolve `<skill dir>/scripts/`. Do not
     hard-code a repo-relative path or rely on `${CLAUDE_PLUGIN_ROOT}`.
     Pass it as a **literal absolute path**, never as a `$`-prefixed token —
     nothing sets that variable in the agent's shell, so its command silently
     runs against `/`.
   - `contextBrief` (from step 2).
   - `branch` — the current branch. If it is protected, defer to the user's existing
     branch guard before spawning; do not re-implement branch protection.
   - `mode` (from step 1).
4. **Verify against git, not against the report.** The Lawspeaker returns `base`.
   Run `git log --oneline {base}..HEAD` and report that.
   - No `base`, or the range is empty → report no commit plus the Lawspeaker's
     reason. Do not respawn.

There is no baseline to record before the spawn: `apply` computes `base` from the
log itself, so a second `rev-parse` here would only re-derive it at the most
expensive context in the flow.

Never report success the Lawspeaker did not report. `ok: false` is a failure even
when commits exist.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_lawspeaker` and pass the literal skill directory, `contextBrief`,
   `branch`, and `mode`.
2. **Generic sub-agent API only**: first verify the stable role file exists at
   `$CODEX_HOME/agents/chronicle/lawspeaker.toml` (default `$CODEX_HOME` to
   `~/.codex`). Spawn exactly one non-fork generic agent with task name
   `chronicle_lawspeaker` and no inherited turns. Tell it to read and obey the
   `developer_instructions` in `lawspeaker.toml` before it handles the same four
   inputs. Do not paste or improvise the role instructions.

Both paths return only the final log. After Codex returns, apply the `base` check
above and report only commits that actually landed.

If neither path is available, do not pretend the agent flow ran. If the role file
is missing, tell the user to invoke `chronicle:install` and start a new Codex
thread. The main agent may run `analyze-changes.ts` and `commit.ts` inline only when
the user explicitly asks to continue without agents.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/commit/references/opencode.md` instead of the
spawn instructions above — a bare agent name, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

## Edge cases

- **Nothing to commit**: `analyze-changes.ts` says so on its first line; the
  Lawspeaker reports `nothing to commit` and stops.
- **Pre-staged files**: no extra prompt — the script stages the plan's files either way.
- **Single file with mixed concerns**: the whole file goes into one commit. There is
  no hunk splitting.
- **Merge or cherry-pick in progress**: git demands the whole index, so only one
  commit is possible. `apply` refuses an atomic plan there rather than letting the
  first commit swallow the rest.
- **A re-run after any failure**: safe. `apply` reads how much of the plan is already
  at HEAD off the log, not off a stored flag.
- **A changeset too wide for one digest**: `analyze-changes.ts` holds back the
  largest diffs, names them, and keeps the payload path. The file table, the stats
  and the template always survive; only diff detail is budgeted.
