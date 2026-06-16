---
name: commit
description: Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split, asking you to confirm only when a split is
  warranted. Triggers on "/chronicle:commit", "commit my changes", "commit this",
  "幫我 commit", "提交變更". Do NOT auto-fire; human-invoked only.
---

# Chronicle Commit

Run Chronicle as a two-phase fork flow: analyze first, gate in the main agent, then write commits.

Both phases run as **context-inheriting forks** — on Claude Code, the Agent tool with `subagent_type: "fork"` (never omitted, never a fresh/named type). A fork inherits the current conversation (the "why" behind the changes, so commit bodies explain intent instead of just restating the diff) **and** keeps its own tool output (the full diff, git spew) out of the main agent's context. Omitting `subagent_type` — or naming any other type — starts a fresh, context-less agent: the commit message then degrades to diff-plus-template with no rationale, which defeats the purpose. On Codex, spawn a background sub-agent with `fork_context: true` (no `agent_type`) for the same effect.

## Staging Model

Chronicle works from the full working changeset: staged, unstaged, and untracked files together. `analyze-changes.ts` reports that combined set.

In Phase B, re-stage files per the confirmed plan with explicit `git add <file>` commands. Prior staging state does not change the outcome and needs no separate consent prompt.

Pull the human in only for the atomic-split decision. The only confirmation in the whole flow is the atomic-split gate.

v1 operates at whole-file granularity. If a file is partially staged, flatten it to a whole-file change when assigning it to a commit group.

## Phase A - Analyze

Spawn an analyze fork (`subagent_type: "fork"`; on Codex, `fork_context: true`). It must not commit.

Resolve the script from the skill's load-time "Base directory for this skill" banner as `$SKILL_DIR/scripts/analyze-changes.ts`, with a file-exists guard. Do not hard-code a repo-relative path such as `bun packages/chronicle/skills/commit/scripts/analyze-changes.ts`, and do not rely on `${CLAUDE_PLUGIN_ROOT}`.

The analyze fork must:

1. Run `$SKILL_DIR/scripts/analyze-changes.ts`. If `totalFiles === 0`, report `nothing to commit` and stop.
2. Read the full analysis JSON from `outputPath` and the message template from `promptPath`.
3. Classify the changeset shape with the decision tree below.
4. Return a small structured result:

```ts
type CommitPlan = {
  shape: "simple" | "atomic";
  // simple: one message; atomic: one entry per commit
  commits: { emoji: string; type: string; subject: string; body: string; zhSummary: string; files: string[] }[];
};
```

## Decision Tree

Classify as **atomic-worthy** if any condition is true:

- There are >=2 distinct change-types among the files, such as `feat` + `fix` + `refactor`.
- Changes span unrelated modules or directories.
- File count exceeds the tunable threshold: default **> 5** total changed files. Use `analyze-changes.ts`'s `totalFiles`, which counts staged, unstaged, and untracked files, not only tracked files.

Otherwise classify as **simple** and return one commit.

## Main Agent Gate

If `shape === "simple"`, proceed straight to Phase B. The human invoked this skill; that invocation is the consent. Do not ask for extra confirmation.

If `shape === "atomic"`, present the proposed split with each commit's emoji, type, subject, and file list. Confirm through the host's interactive user prompt:

- Claude Code: use `AskUserQuestion`.
- Codex or other harnesses: use the equivalent confirmation prompt.

Offer these options:

- `Execute this split (Recommended)`
- `Adjust the grouping`
- `Just one commit instead`
- `Abort`

On `Adjust the grouping`, revise the `CommitPlan` and re-confirm. On `Just one commit instead`, collapse to a simple plan and proceed to Phase B. On `Abort`, stop without committing.

## Phase B - Write

Spawn a write fork (`subagent_type: "fork"`; on Codex, `fork_context: true`) with the confirmed `CommitPlan` and the template format from `references/commit-template.md`. Because the fork inherits the conversation, lean on that "why" when writing each commit body — explain intent, not just the mechanical diff. But mind the template's **length guardrail**: the inherited context is deep, so deliberately keep the body terse (~3–4 one-line bullets) and the 繁中 summary to 1–3 sentences that *summarize* rather than re-translate the body. When in doubt, shorter.

For each commit in order:

1. Run `git add <explicit files>` using the files listed for that commit. Do not use `git add -A`.
2. Run `git commit` with a heredoc message that follows the template:

```text
{emoji} {type}: {subject}

- what changed and why (English, markdown list)
- another detail

---

繁體中文摘要
```

Each commit message must describe only the files in that commit. After all commits are written, report `git log --oneline -n <count>` for the new commits back to the main agent.

## Edge Cases

- **Pre-staged files**: handle deterministically with the staging model above. Do not ask for an extra prompt.
- **Single file with mixed concerns**: hunk-level staging is out of scope for v1. Put the whole file's change into one group.
- **Commit to a protected branch**: defer to the user's existing git-flow guard. Do not re-implement branch protection.
