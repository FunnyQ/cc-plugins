---
name: commit
description: Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split, asking you to confirm only when a split is
  warranted. Triggers on "/chronicle:commit", "commit my changes", "commit this",
  "幫我 commit", "提交變更". Do NOT auto-fire; human-invoked only.
---

# Chronicle Commit

Run Chronicle as a single **Commit Manager** that owns the whole flow: it spawns a
cheap Haiku analyst, decides simple vs atomic, then spawns a cheap Haiku writer —
keeping all git spew out of the main conversation while preserving the "why"
behind the changes.

## Topology

```
main agent
  └─ Commit Manager   (subagent_type: "fork" — inherits THIS conversation, runs on your model)
       ├─ chronicle:analyst  (fresh Haiku) — runs analyze-changes.ts, returns changeset facts + two proposals
       ├─ Manager decides simple | atomic  (+ atomic gate)
       └─ chronicle:writer   (fresh Haiku) — stages files + writes commits from the Manager's brief
```

Why this exact shape — it threads three Claude Code constraints:

- **The Manager is a fork** so it inherits the conversation: the "why" behind the
  changes, so commit bodies explain intent instead of restating the diff. Omitting
  `subagent_type` (or naming any other type) would start a fresh, context-less
  Manager and defeat the purpose. On Codex, spawn the Manager as a background
  sub-agent with `fork_context: true`.
- **Its children are fresh named agents, not forks.** A fork may spawn other
  subagent types but **never another fork**, and a fresh agent honors a per-call
  `model` override — so `chronicle:analyst` and `chronicle:writer` run on Haiku
  (set in their own frontmatter), which is cheap and correct for mechanical work.
- **The children do NOT inherit the conversation.** This is the load-bearing rule:
  the Manager must **distill the rationale and pass it down in each child's
  prompt** — above all the writer's per-commit `whyBrief`. Skip it and the commit
  body degrades to a restated diff, which is the whole thing this design avoids.

All diff/git output stays inside the Manager subtree; the main agent only sees the
final `git log`.

The two Haiku agents live at `packages/chronicle/agents/{analyst,writer}.md` and
auto-register as `chronicle:analyst` / `chronicle:writer`.

## Staging Model

Chronicle works from the full working changeset: staged, unstaged, and untracked
files together. `analyze-changes.ts` reports that combined set.

In Phase B, re-stage files per the confirmed plan with explicit `git add <file>`
commands. Prior staging state does not change the outcome and needs no separate
consent prompt.

Pull the human in only for the atomic-split decision. The only confirmation in the
whole flow is the atomic-split gate.

v1 operates at whole-file granularity. If a file is partially staged, flatten it to
a whole-file change when assigning it to a commit group.

## Spawning the Commit Manager

The main agent spawns ONE Commit Manager fork (`subagent_type: "fork"`; on Codex,
`fork_context: true`) and hands it the skill's load-time "Base directory for this
skill" banner value as `$SKILL_DIR` (so it can resolve
`$SKILL_DIR/scripts/analyze-changes.ts` and `references/commit-template.md`). Do
not hard-code a repo-relative path, and do not rely on `${CLAUDE_PLUGIN_ROOT}`.

The Manager runs the phases below and returns the final `git log --oneline` to the
main agent.

## Phase A — Analyze

The Manager spawns `chronicle:analyst` (a fresh Haiku agent) with the absolute
`analyze-changes.ts` path. The analyst:

1. Runs the script. If `totalFiles === 0`, it reports `nothingToCommit`; the
   Manager then reports `nothing to commit` to the main agent and stops.
2. Returns changeset facts plus two proposals (`simpleCommit` and `atomicPlan`),
   along with `promptPath`. The analyst classifies change-types but does **not**
   decide simple-vs-atomic and never commits.

## Decision (Manager)

The Manager — not the analyst — applies the decision tree. Classify as
**atomic-worthy** if any condition is true:

- There are >= 2 distinct change-types among the files (e.g. `feat` + `fix` + `refactor`).
- Changes span unrelated modules or directories.
- File count exceeds the tunable threshold: default **> 5** total changed files
  (use the analyst's `totalFiles`, which counts staged + unstaged + untracked).

Otherwise classify as **simple**.

## Gate (Manager, atomic only)

If **simple**, proceed straight to Phase B — the human invoked this skill; that
invocation is the consent. Do not ask for extra confirmation.

If **atomic**, the Manager (a foreground fork, so it can prompt directly) presents
the proposed split — each commit's emoji, type, subject, and file list — and
confirms through the host's interactive prompt:

- Claude Code: `AskUserQuestion`.
- Codex or other harnesses: the equivalent confirmation prompt.

Options:

- `Execute this split (Recommended)`
- `Adjust the grouping`
- `Just one commit instead`
- `Abort`

On `Adjust the grouping`, revise the plan and re-confirm. On `Just one commit
instead`, collapse to the `simpleCommit` plan and proceed. On `Abort`, stop
without committing.

## Phase B — Write

The Manager builds the confirmed `CommitPlan` and — drawing on the conversation it
inherited — fills a per-commit **`whyBrief`** (the distilled intent for that
commit). It then spawns `chronicle:writer` (a fresh Haiku agent) with the
`CommitPlan` and the template format from `references/commit-template.md`.

The writer does not see the conversation, so the `whyBrief` is the only "why" it
gets — make it carry the intent, but keep it tight: the template's **length
guardrail** still applies (body ~3–4 one-line bullets; 繁中 summary 1–3 sentences
that summarize, not re-translate). When in doubt, shorter.

For each commit in order the writer runs `git add <explicit files>` (never `git
add -A`) then `git commit` with the heredoc template. After all commits, it returns
`git log --oneline -n <count>`, which the Manager relays to the main agent.

## Edge Cases

- **Pre-staged files**: handle deterministically with the staging model above. Do
  not ask for an extra prompt.
- **Single file with mixed concerns**: hunk-level staging is out of scope for v1.
  Put the whole file's change into one group.
- **Commit to a protected branch**: defer to the user's existing git-flow guard.
  Do not re-implement branch protection.
