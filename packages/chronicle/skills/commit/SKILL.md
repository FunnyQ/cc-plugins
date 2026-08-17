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

A commit run is two files and one script. `scripts/commit.ts` checks the watcher's
proposal file and decides the shape, then checks the plan file covers the
changeset, stages, commits, and verifies. Both hand-offs are files on disk rather
than agent replies, so a child that answers in prose costs nothing. Re-running
`apply` finishes an interrupted run instead of duplicating it.

Spawn ONE **Lawspeaker**. It owns the flow: it spawns a cheap Haiku watcher to read
the diff, orders the commits, writes the plan file, then spawns a cheap Haiku
runesmith to run the script. This keeps every diff and every line of git output out
of the main conversation.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:lawspeaker   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:watcher  (Haiku) — reads the diff, writes the ordered groups to the proposal file
       ├─ Lawspeaker orders the commits and writes the plan file's prose
       └─ chronicle:runesmith (Haiku) — runs commit.ts apply, returns the distilled result
```

Spawn via `subagent_type`, never a fork. Spawn exactly one Lawspeaker, in one
`Agent` call, with no `name`. This chain is nested and sequential, not a team: never
spawn the watcher or the runesmith yourself, and never put two agents in one
message. The Lawspeaker must be able to spawn its children, so this flow needs
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` — see `chronicle:install`.

The three agents live at `packages/chronicle/agents/{lawspeaker,watcher,runesmith}.md`
and auto-register as `chronicle:lawspeaker` / `chronicle:watcher` / `chronicle:runesmith`.

## The main agent's job (thin)

1. **Record baseline**. Run `git rev-parse HEAD 2>/dev/null || true`. An empty
   baseline means an unborn branch.
2. **Parse the mode**. `mode: "simple"` if the argument is `simple`
   (case-insensitive) or the user's phrasing clearly asks for one commit ("one
   commit", "快速 commit", "single commit"). Otherwise `mode: "auto"`.
3. **Distill `contextBrief`** — terse intent and non-obvious rationale from this
   chat. The Lawspeaker does not see the conversation, and this is the only source
   for every commit body it writes. Everything the reader of a commit would need to
   know, and nothing else.
4. **Spawn the Lawspeaker** (`subagent_type: "chronicle:lawspeaker"`), passing:
   - the **skill directory** — the skill's load-time "Base directory for this
     skill" banner value, so it can resolve `<skill dir>/scripts/` and hand the
     path to its children. Do not hard-code a repo-relative path or rely on
     `${CLAUDE_PLUGIN_ROOT}`.
     Pass it as a **literal absolute path**, never as a `$`-prefixed token —
     nothing sets that variable in a child's shell, so its command silently
     runs against `/`.
   - `contextBrief` (from step 3).
   - `branch` — the current branch. If it is protected, defer to the user's existing
     branch guard before spawning; do not re-implement branch protection.
   - `mode` (from step 2).
5. **Verify**. Run `git rev-parse HEAD 2>/dev/null || true` and compare with the
   baseline.
   - Changed → report `git log --oneline {baseline}..HEAD` (or `git log --oneline`
     for an empty baseline).
   - Unchanged → report no commit plus the Lawspeaker's reason. Do not respawn.

Never report success the Lawspeaker did not report. `ok: false` is a failure even
when commits exist.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_lawspeaker` and pass the literal skill directory, `contextBrief`,
   `branch`, and `mode`.
2. **Generic sub-agent API only**: first verify the stable role files exist under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   exactly one non-fork generic agent with task name `chronicle_lawspeaker` and no
   inherited turns. Tell it to read and obey the `developer_instructions` in
   `lawspeaker.toml` before it handles the same four inputs. Its stable instructions
   delegate sequentially to generic watcher and runesmith children that self-load
   their own TOMLs. Do not paste or improvise the role instructions.

Both paths return only the final log. After Codex returns, apply the baseline HEAD
check above and report only commits that actually landed.

If neither path is available, do not pretend the agent flow ran. If the role files
are missing, tell the user to invoke `chronicle:install` and start a new Codex
thread. The main agent may run `analyze-changes.ts` and `commit.ts` inline only when
the user explicitly asks to continue without agents.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/commit/references/opencode.md` instead of the
spawn instructions above — bare agent names, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

## Edge cases

- **Nothing to commit**: the watcher returns `nothingToCommit`; the Lawspeaker
  reports `nothing to commit` and stops.
- **Pre-staged files**: no extra prompt — the script stages the plan's files either way.
- **Single file with mixed concerns**: the whole file goes into one commit. There is
  no hunk splitting.
- **Merge or cherry-pick in progress**: git demands the whole index, so only one
  commit is possible. `apply` refuses an atomic plan there rather than letting the
  first commit swallow the rest.
- **A re-run after any failure**: safe. `apply` reads how much of the plan is already
  at HEAD off the log, not off a stored flag.
