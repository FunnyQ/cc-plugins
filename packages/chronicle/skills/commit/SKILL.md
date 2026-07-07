---
name: commit
description: Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split. Triggers on "/chronicle:commit", "commit my
  changes", "commit this", "幫我 commit", "提交變更". Do NOT auto-fire; human-invoked only.
---

# Chronicle Commit

Spawn ONE **Lawspeaker** that owns the whole flow: it spawns a cheap Haiku
watcher, auto-decides simple vs atomic, then spawns a cheap Haiku runesmith — keeping
all git output out of the main conversation while preserving the "why" behind the
changes.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:lawspeaker   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:watcher  (Haiku) — runs analyze-changes.ts, returns changeset facts + two proposals
       ├─ Lawspeaker auto-decides simple | atomic
       └─ chronicle:runesmith   (Haiku) — stages whole files + writes commits from the Lawspeaker's brief
```

Spawn via `subagent_type`, never fork (a fork cannot spawn children); design
rationale lives in `packages/chronicle/DESIGN.md`.

All diff/git output stays inside the Lawspeaker subtree; the main agent only sees the
final `git log`. The three agents live at
`packages/chronicle/agents/{lawspeaker,watcher,runesmith}.md` and auto-register as
`chronicle:lawspeaker` / `chronicle:watcher` / `chronicle:runesmith`.

## The main agent's job (thin)

The main agent does exactly two things, then waits for the Lawspeaker's report:

1. **Distill the `contextBrief`** — a tight summary of *why* these changes were
   made, drawn from this conversation. This cannot move into the Lawspeaker (the
   Lawspeaker can't see the chat). Keep it to the rationale a commit body would want:
   intent, the problem being solved, anything non-obvious from the diff.
2. **Spawn the Lawspeaker** (`subagent_type: "chronicle:lawspeaker"`), passing:
   - `$SKILL_DIR` — the skill's load-time "Base directory for this skill" banner
     value (so it can resolve `$SKILL_DIR/scripts/analyze-changes.ts` and
     `$SKILL_DIR/references/commit-template.md`). Do not hard-code a repo-relative
     path or rely on `${CLAUDE_PLUGIN_ROOT}`.
   - `contextBrief` (from step 1).
   - `branch` — the current branch. If it is a protected branch, defer to the
     user's existing git-flow guard before spawning; do not re-implement branch
     protection.

The Lawspeaker returns the final `git log --oneline`; the main agent relays it to the
user (commit hash + subject line per commit) and nothing else.

## What the Lawspeaker does (reference)

Full procedure lives in `agents/lawspeaker.md`. In brief: spawn `chronicle:watcher` →
auto-apply the decision tree → build a whole-file `CommitPlan` with a per-commit
`whyBrief` → spawn `chronicle:runesmith` → relay its `git log` up.
The Lawspeaker auto-decides simple vs atomic and commits with whole-file granularity.

## Codex

Codex has no named-agent registry. There the main agent runs the same flow inline
(or via its own sub-agent mechanism with `fork_context` for the why): analyze →
auto-decide → commit, honoring the same whole-file / no-hunk rule.

## Edge Cases

- **Nothing to commit**: watcher returns `nothingToCommit`; the Lawspeaker reports
  `nothing to commit` and stops.
- **Pre-staged files**: handled by the staging model above — no extra prompt.
- **Single file with mixed concerns**: the whole file goes into one commit (no
  hunk splitting in v1).
