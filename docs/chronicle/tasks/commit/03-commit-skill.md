# COMMIT-03: Commit skill (unified decision tree)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: commit/01, commit/02
> **Status**: todo

## Goal

Write the `commit` skill's `SKILL.md` so one skill auto-decides between a single commit (simple) and an atomic split, orchestrating the two-phase fork flow and pulling the human in only for the atomic split decision.

## Files to create / modify

- `packages/chronicle/skills/commit/SKILL.md` (new) — trigger config + orchestration prose.

## Implementation notes

`SKILL.md` is YAML frontmatter + markdown prose that the main agent follows. It does not run code itself; it instructs the main agent to spawn forks and run the analysis script (already built: `scripts/analyze-changes.ts`, which prints `{ outputPath, promptPath, totalFiles }`; the template lives at `references/commit-template.md`).

### Frontmatter

```yaml
---
name: commit
description: Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split, asking you to confirm only when a split is
  warranted. Triggers on "/chronicle:commit", "commit my changes", "commit this",
  "幫我 commit", "提交變更". Do NOT auto-fire; human-invoked only.
---
```

### Orchestration prose (the flow to document)

**Staging model (deterministic — no extra confirmation):** chronicle always works from the full working changeset (staged + unstaged + untracked, which `analyze-changes.ts` already reports together) and **re-stages whole files per its own plan** in Phase B via explicit `git add <file>`. So any prior staging state does not change the outcome and needs no separate consent prompt — this keeps the promise that the human is pulled in **only** for the atomic-split decision. v1 operates at whole-file granularity: a partially-staged file (some hunks staged, some not) is flattened to its whole-file change when grouped (consistent with hunk-level staging being out of scope). The only confirmation in the whole flow is the atomic-split gate below.

**Phase A — analyze (spawn a sub-agent):**
1. Run `analyze-changes.ts`; if `totalFiles === 0`, report "nothing to commit" and stop.
2. Read the full analysis from `outputPath` and the template from `promptPath`.
3. Classify the changeset shape (the decision tree below) and return a small structured result to the main agent — do NOT commit in this phase:
   ```ts
   type CommitPlan = {
     shape: "simple" | "atomic";
     // simple: one message; atomic: one entry per commit
     commits: { emoji: string; type: string; subject: string; body: string; zhSummary: string; files: string[] }[];
   };
   ```

**Decision tree (the fork threshold — document as tunable):**
- **atomic-worthy** if ANY of: ≥2 distinct change-types among the files (e.g. feat + fix + refactor); changes span unrelated modules/directories; file count exceeds a threshold (default **> 5** total changed files — use `analyze-changes.ts`'s `totalFiles`, which counts staged + unstaged + untracked, NOT only tracked files — state this number and that it's tunable).
- otherwise **simple** (one commit).

**Main agent gate:**
- `shape === "simple"` → proceed straight to Phase B. The human invoked the skill; that invocation IS the consent — no extra confirmation.
- `shape === "atomic"` → present the proposed split (per-commit emoji/type/subject + file list) and confirm via the **host's interactive user-prompt** (on Claude Code: `AskUserQuestion`; on Codex/other harnesses: the equivalent confirmation prompt) with options: "Execute this split (Recommended)" / "Adjust the grouping" / "Just one commit instead" / "Abort". On "Adjust", revise and re-confirm.

**Phase B — write (spawn a sub-agent):**
- Receives the confirmed `CommitPlan` + the template format.
- For each commit: `git add <explicit files>` then `git commit` with a heredoc message following the template (emoji subject + body + `---` + 繁中 summary). Never `git add -A`.
- Report `git log --oneline -n <count>` of the new commits back to the main agent.

**Edge cases to document:** pre-staged files (handled deterministically by the staging model above — no extra prompt); a single file with mixed concerns (hunk-level staging is out of scope for v1 — the whole file's change goes into one group); commit to a protected branch (defer to the user's existing git-flow guard, do not re-implement).

### Reference the pieces by name, not by task id

Point at `scripts/analyze-changes.ts` and `references/commit-template.md` (real paths in this skill), never at sibling task ids.

## Acceptance criteria

- [ ] `SKILL.md` has valid frontmatter with `name: commit` and a description carrying the trigger phrases + "human-invoked only".
- [ ] The two-phase fork flow (analyze → gate → write) is documented with the structured `CommitPlan` hand-off.
- [ ] The decision tree spells out all three atomic triggers and the default file-count threshold (against `totalFiles` incl. untracked), marked tunable.
- [ ] The deterministic staging model is documented (full changeset in, whole-file re-stage per plan, no pre-staging consent prompt); the atomic-split gate is the ONLY confirmation in the flow.
- [ ] The simple branch explicitly commits without any confirmation; the atomic branch confirms via the host's interactive prompt (`AskUserQuestion` on Claude, equivalent elsewhere).
- [ ] The write phase stages by explicit filename and uses the emoji + body + 繁中 template; no `git add -A`.
- [ ] No reference to odin-git, and no sibling-task-id references in the body.

## Verification

- [ ] `grep -n "name: commit" packages/chronicle/skills/commit/SKILL.md` matches inside frontmatter.
- [ ] Manual read-through: an agent could execute the full flow using only this file + the two referenced files.
- [ ] Smoke (manual, after packaging): dirty tree with a feat+fix mix → skill proposes a 2-commit split; a single-file doc tweak → commits straight through.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | flow wrong / simple branch asks needlessly / atomic branch skips confirm | flow mostly right but a gate or threshold is ambiguous | exact two-phase flow, correct gates, threshold spelled out + tunable |
| Trigger & flow correctness | ×2 | description won't trigger or auto-fires | triggers but flow has a gap an agent would stumble on | triggers on the right phrases, flow executable end-to-end without guessing |
| Interface & readability | ×1 | rambling, hard to follow | usable but verbose | tight, scannable, structured hand-off typed |
| Assumptions & docs | ×1 | edge cases unaddressed | some noted | pre-staged / protected-branch / mixed-file all addressed |

## Out of scope

- Hunk-level (partial-file) staging — Deferred to a later version. v1 commits whole files per group.
- Re-implementing a protected-branch guard — Deferred. Rely on the user's existing git-flow hook.
