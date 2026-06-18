---
name: commit
description: Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split. Triggers on "/chronicle:commit", "commit my
  changes", "commit this", "幫我 commit", "提交變更". Do NOT auto-fire; human-invoked only.
---

# Chronicle Commit

Spawn ONE **Commit Manager** that owns the whole flow: it spawns a cheap Haiku
analyst, auto-decides simple vs atomic, then spawns a cheap Haiku writer — keeping
all git output out of the main conversation while preserving the "why" behind the
changes.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:manager   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:analyst  (Haiku) — runs analyze-changes.ts, returns changeset facts + two proposals
       ├─ Manager auto-decides simple | atomic
       └─ chronicle:writer   (Haiku) — stages whole files + writes commits from the Manager's brief
```

Why this exact shape — it threads the harness's spawn rules (see below for the
verified model):

- **The Manager is spawned via `subagent_type`, never as a fork.** A fork is a leaf
  — it is forbidden from spawning subagents — so a fork Manager could never reach
  the children. A nested custom agent can. The cost: a nested agent does **not**
  inherit the conversation, so the main agent must hand the Manager the distilled
  **`contextBrief`** in its spawn prompt (the Manager has no other source for the
  "why").
- **The Manager can spawn because it is a custom agent whose `tools:` include
  `Agent`.** Spawn capability is purely tools-gated. The Manager is given
  `Agent` + `Read` and **deliberately no `Bash`** — so it physically cannot run git
  itself and *must* delegate. "Orchestrate, never execute" is structural here, not a
  rule it has to remember.
- **The children are Haiku, spawned by name.** A nested custom agent can address
  plugin-defined types (`chronicle:analyst` / `chronicle:writer`) via
  `subagent_type` — verified. They run on Haiku (set in their own frontmatter),
  cheap and correct for mechanical work, and never see the conversation — so the
  Manager's per-commit `whyBrief` is the only "why" the writer gets.

All diff/git output stays inside the Manager subtree; the main agent only sees the
final `git log`. The three agents live at
`packages/chronicle/agents/{manager,analyst,writer}.md` and auto-register as
`chronicle:manager` / `chronicle:analyst` / `chronicle:writer`.

### Verified spawn model (why the above is safe)

Live-tested in this harness:

| Caller | Can spawn? |
|---|---|
| Fork (`subagent_type:"fork"`) | ❌ — a fork is a leaf, never delegates |
| Custom agent **with `Agent` in `tools:`** | ✅ — and it can address plugin types like `chronicle:analyst` |
| Custom agent without `Agent` | ❌ |

So: Manager = custom agent + `Agent` tool (can spawn) − `Bash` (can't run git).
Children = custom agents without `Agent` (leaves that do the git work).

## The main agent's job (thin)

The main agent does exactly two things, then waits for the Manager's report:

1. **Distill the `contextBrief`** — a tight summary of *why* these changes were
   made, drawn from this conversation. This cannot move into the Manager (the
   Manager can't see the chat). Keep it to the rationale a commit body would want:
   intent, the problem being solved, anything non-obvious from the diff.
2. **Spawn the Manager** (`subagent_type: "chronicle:manager"`), passing:
   - `$SKILL_DIR` — the skill's load-time "Base directory for this skill" banner
     value (so it can resolve `$SKILL_DIR/scripts/analyze-changes.ts` and
     `$SKILL_DIR/references/commit-template.md`). Do not hard-code a repo-relative
     path or rely on `${CLAUDE_PLUGIN_ROOT}`.
   - `contextBrief` (from step 1).
   - `branch` — the current branch. If it is a protected branch, defer to the
     user's existing git-flow guard before spawning; do not re-implement branch
     protection.

The Manager returns the final `git log --oneline`; the main agent relays it to the
user (commit hash + subject line per commit) and nothing else.

## What the Manager does (reference)

Full procedure lives in `agents/manager.md`. In brief: spawn `chronicle:analyst` →
auto-apply the decision tree → build a whole-file `CommitPlan` with a per-commit
`whyBrief` → spawn `chronicle:writer` → relay its `git log` up.

### Decision tree (Manager, automatic)

Classify as **atomic** if ANY is true, else **simple**:

- `>= 2` distinct change-types among the files (e.g. `feat` + `fix` + `refactor`).
- Changes span unrelated modules or directories.
- File count `> 5` total changed files (analyst's `totalFiles`, counting staged +
  unstaged + untracked).

There is **no confirmation gate** — the human's invocation of the skill is the
consent, and a nested Manager can't prompt anyway. It decides and proceeds.

## Staging Model

Chronicle works from the full working changeset: staged, unstaged, and untracked
files together (`analyze-changes.ts` reports that combined set). The writer
re-stages per the plan with explicit `git add <file>` — prior staging state does
not change the outcome.

**Whole-file granularity, always.** Every changed file belongs to exactly one
commit. A file with mixed concerns goes *entirely* into one commit. Hunk-level
staging is out of scope: the plan never splits a file, and the writer stages only
by explicit filename — never `git add -p`, `git add -A`, or `git add .` (Claude
Code's Bash tool can't drive interactive `-p` anyway). The no-hunk guarantee lives
in the plan, not in special writer handling.

## Codex

Codex has no named-agent registry. There the main agent runs the same flow inline
(or via its own sub-agent mechanism with `fork_context` for the why): analyze →
auto-decide → commit, honoring the same whole-file / no-hunk rule.

## Edge Cases

- **Nothing to commit**: analyst returns `nothingToCommit`; the Manager reports
  `nothing to commit` and stops.
- **Pre-staged files**: handled by the staging model above — no extra prompt.
- **Single file with mixed concerns**: the whole file goes into one commit (no
  hunk splitting in v1).
