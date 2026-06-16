# PR-03: PR skill (history + cockpit → reviewer-legible PR/MR)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: pr/01, pr/02
> **Status**: todo

## Goal

Write the `pr` skill's `SKILL.md` so it turns the branch's commit history and cockpit decisions into a reviewer-legible GitHub PR / GitLab MR, via the two-phase fork flow with a human confirm/edit gate.

## Files to create / modify

- `packages/chronicle/skills/pr/SKILL.md` (new) — trigger config + orchestration prose.

## Implementation notes

`SKILL.md` instructs the main agent. The mechanical pieces already exist in this skill: `scripts/analyze-branch.ts` (prints `{ outputPath, provider, hasCockpit, commitCount }`; temp file is a `BranchMaterial` with `commits`, `diffStat`, `decisions`, `base`, `head`, `provider`) and `scripts/request-creator.ts` (takes a `CreateInput` JSON, returns a `CreateResult`).

### Frontmatter

```yaml
---
name: pr
description: Open a PR (GitHub) or MR (GitLab) for the current branch, with a body a
  reviewer can actually understand — why the change exists, what changed, what to focus
  on, how to judge it — enriched by the cockpit decision trail when present. Triggers on
  "/chronicle:pr", "create a PR", "open a pull request", "open an MR", "幫我開 PR",
  "建立 merge request". Human-invoked only.
---
```

### Orchestration prose (the flow to document)

**Phase A — analyze (spawn a sub-agent):**
1. Run `analyze-branch.ts`. If `commitCount === 0`, report "no commits to propose" and stop.
2. Read the `BranchMaterial` from `outputPath`.
3. Synthesize a **4-section** PR/MR body (this is the judgment — keep it in the fork):
   - **Why** — the motivation. Draw from cockpit `decision`/`reason` records and commit bodies. If `hasCockpit` is false, derive intent from the commit messages alone.
   - **What changed** — a tight summary of the commits + `diffStat` (group by area, don't just dump the log).
   - **What to focus on** — reviewer guidance: cockpit `tradeoff`s, `kind:"caveat"` records, and any `needs_your_call:true` items become the "look here" list. Note risky files from `decisions[].files`.
   - **How to judge** — acceptance/test notes: how a reviewer confirms it works (tests to run, behavior to check).
4. Also propose a **title** (concise, imperative, from the dominant change). Return `{ title, body, base, head, provider }` to the main agent.

**Main agent gate:**
- Present the proposed title + 4-section body.
- Confirm via the **host's interactive user-prompt** (on Claude Code: `AskUserQuestion`; on Codex/other harnesses: the equivalent confirmation prompt): "Create it (Recommended)" / "Open as draft" / "Edit title/body" / "Abort". On "Edit", revise and re-confirm. "Open as draft" sets `draft:true`.

**Phase B — create (spawn a sub-agent):**
- Build a `CreateInput` `{ provider, title, body, base, head, draft }` and run `request-creator.ts`.
- On `{ok:true}` → report the URL. On `{ok:false}` → relay the `reason` plainly: `missing-cli` (suggest installing `gh`/`glab`), `no-remote` (no git remote configured), `cli-error` (show the message). Never pretend success.

**Soft cockpit dependency (document explicitly):** when `hasCockpit` is false the skill still produces all four sections from commits+diff — the "Why" and "What to focus on" are thinner but present. Absence is silent, never an error.

**Provider note:** if `provider === "unknown"` (no recognizable remote), tell the user chronicle can't pick `gh`/`glab` and stop before Phase B — don't guess.

### Reference the pieces by name, not by task id

Point at `scripts/analyze-branch.ts` and `scripts/request-creator.ts`; never at sibling task ids.

## Acceptance criteria

- [ ] `SKILL.md` has valid frontmatter with `name: pr` and a description carrying the trigger phrases + "human-invoked only".
- [ ] The two-phase fork flow (analyze → gate → create) is documented with the `{title, body, base, head, provider}` and `CreateInput` hand-offs.
- [ ] The 4-section body (Why / What changed / What to focus on / How to judge) is defined with the cockpit-field → section mapping.
- [ ] The soft cockpit dependency and the `provider:"unknown"` stop condition are both documented.
- [ ] The gate offers create / draft / edit / abort via the host's interactive prompt (`AskUserQuestion` on Claude, equivalent elsewhere); failures are reported honestly.
- [ ] No odin-git reference and no sibling-task-id references in the body.

## Verification

- [ ] `grep -n "name: pr" packages/chronicle/skills/pr/SKILL.md` matches inside frontmatter.
- [ ] Manual read-through: an agent could run the full flow using only this file + the two referenced scripts.
- [ ] Smoke (manual, after packaging): a branch with a cockpit log → body's "Why"/"What to focus on" cite decisions; same branch with `COCKPIT_HOME` empty → all four sections still render, no error.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | flow wrong / hard cockpit dep / guesses provider | flow right but a hand-off or section mapping is fuzzy | exact flow, typed hand-offs, soft cockpit, unknown-provider stop, honest failures |
| Trigger & flow correctness | ×2 | won't trigger or auto-fires | triggers but flow has a gap | triggers correctly, flow executable end-to-end |
| Interface & readability | ×1 | rambling | usable but verbose | tight, structured, scannable |
| Assumptions & docs | ×1 | fallback unstated | partial | cockpit-absent + unknown-provider + failure-reasons all spelled out |

## Out of scope

- Reviewing or merging the PR/MR — Deferred to future review/merge skills.
- Posting inline review comments — Deferred. v1 only opens the request.
