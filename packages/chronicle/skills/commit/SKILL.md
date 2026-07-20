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

Spawn ONE **Lawspeaker** that owns the whole flow: it spawns a cheap Haiku
watcher, settles the shape (auto-decided, or forced to one commit in `simple` mode),
then spawns a cheap Haiku runesmith — keeping all git output out of the main
conversation while preserving the "why" behind the changes.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:lawspeaker   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:watcher  (Haiku) — runs analyze-changes.ts, returns changeset facts + two proposals
       ├─ Lawspeaker auto-decides simple | atomic
       └─ chronicle:runesmith   (Haiku) — stages whole files + writes commits from the Lawspeaker's brief
```

Spawn via `subagent_type`, never fork: the Lawspeaker must be able to spawn its
children and does not inherit the main conversation.

Diff analysis stays inside the Lawspeaker subtree; the main agent also performs the
small final verification commands below. The three agents live at
`packages/chronicle/agents/{lawspeaker,watcher,runesmith}.md` and auto-register as
`chronicle:lawspeaker` / `chronicle:watcher` / `chronicle:runesmith`.

## The main agent's job (thin)

The main agent does five things:

0. **Record baseline** — run `git rev-parse HEAD 2>/dev/null || true`; an empty
   baseline means an unborn branch.
1. **Parse invocation mode** — if the argument is `simple` (case-insensitive), or
   the user's phrasing clearly asks for a single commit ("one commit", "快速 commit",
   "single commit"), set `mode: "simple"`; otherwise set `mode: "auto"`.
2. **Distill `contextBrief`** — terse intent and non-obvious rationale from this chat.
3. **Spawn the Lawspeaker** (`subagent_type: "chronicle:lawspeaker"`), passing:
   - `$SKILL_DIR` — the skill's load-time "Base directory for this skill" banner
     value (so it can resolve `$SKILL_DIR/scripts/analyze-changes.ts` and
     `$SKILL_DIR/references/commit-template.md`). Do not hard-code a repo-relative
     path or rely on `${CLAUDE_PLUGIN_ROOT}`.
   - `contextBrief` (from step 2).
   - `branch` — the current branch. If it is a protected branch, defer to the
     user's existing git-flow guard before spawning; do not re-implement branch
     protection.
   - `mode` — `"auto"` by default, or `"simple"` when the invocation forces one
     commit.

4. **Verify** — run `git rev-parse HEAD 2>/dev/null || true`, then compare with baseline:

   - Changed: report `git log --oneline <baseline>..HEAD`; for an empty baseline,
     report `git log --oneline`.
   - Unchanged: report no commit plus Lawspeaker's reason. Do not respawn.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_lawspeaker` and pass `$SKILL_DIR`, `contextBrief`, `branch`, and
   `mode`.
2. **Generic sub-agent API only**: first verify the stable role files exist under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   exactly one non-fork generic agent with task name `chronicle_lawspeaker`, no
   inherited turns, and a prompt that tells it to read and obey the
   `developer_instructions` in `lawspeaker.toml` before handling the same four
   inputs. Its stable instructions delegate sequentially to generic watcher and
   runesmith children that self-load their own TOMLs. Do not paste or improvise the
   role instructions in the spawn prompt.

Both paths return only the final log and preserve the same Lawspeaker → Watcher →
Runesmith isolation. These roles are installed by `chronicle:install`.

After Codex returns, apply the baseline HEAD check above and report only commits that
actually landed.

If neither a named-role selector nor a non-fork generic sub-agent API is available,
do not silently pretend the agent flow ran. If the stable role files are missing,
tell the user to invoke `chronicle:install` and start a new Codex thread. The main
agent may run the legacy inline analyze → decide → commit flow only when the user
explicitly asks to continue without agents. The same `simple` argument still forces
one commit from `simpleCommit` and skips the decision tree.

## Edge Cases

- **Nothing to commit**: watcher returns `nothingToCommit`; the Lawspeaker reports
  `nothing to commit` and stops.
- **Pre-staged files**: handled by the staging model above — no extra prompt.
- **Single file with mixed concerns**: the whole file goes into one commit (no
  hunk splitting in v1).
