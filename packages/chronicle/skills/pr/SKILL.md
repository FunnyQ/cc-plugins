---
name: pr
description: Open a PR (GitHub) or MR (GitLab) for the current branch, with a body a
  reviewer can actually understand — why the change exists, what changed, what to focus
  on, how to judge it — enriched by the cockpit decision trail when present. Triggers on
  "/chronicle:pr", "create a PR", "open a pull request", "open an MR", "幫我開 PR",
  "建立 merge request". Human-invoked only.
---

# Chronicle PR Skill

Open a GitHub PR or GitLab MR for the current branch with a reviewer-legible title and body. Use this only when a person invokes it; do not auto-trigger from incidental PR/MR mentions.

This skill runs in two phases:

1. A fork analyzes the branch and drafts the request material.
2. The main agent asks the user to confirm, edit, draft, or abort.
3. A fork creates the PR/MR only after confirmation.

Both forks are **context-inheriting**: on Claude Code, the Agent tool with `subagent_type: "fork"` (never omitted, never a fresh/named type); on Codex, a background sub-agent with `fork_context: true` (no `agent_type`). A fork inherits the conversation (so the **Why** section can draw on the intent discussed in-session, not only cockpit records and commit subjects) **and** keeps its own tool output (full branch diff, `gh`/`glab` spew) out of the main agent's context. Omitting `subagent_type` starts a fresh, context-less agent — the **Why** then collapses to whatever the scripts surface, which is exactly the thinning this skill's soft-cockpit fallback is meant to avoid.

## Script Resolution

Run the bundled scripts from this skill's installed location. Resolve paths from the load-time **"Base directory for this skill"** banner and guard that the files exist. Do not use repo-relative source paths, and do not rely on `${CLAUDE_PLUGIN_ROOT}` being set in agent shell commands.

```bash
SKILL_DIR="<BANNER_PATH>"
ANALYZER="$SKILL_DIR/scripts/analyze-branch.ts"
CREATOR="$SKILL_DIR/scripts/request-creator.ts"
test -f "$ANALYZER" || { echo "analyze-branch.ts not found at $ANALYZER" >&2; exit 1; }
test -f "$CREATOR" || { echo "request-creator.ts not found at $CREATOR" >&2; exit 1; }
```

Run all commands from the user's current repository so the scripts see the correct git branch, remotes, and cockpit project context.

## Phase A: Analyze in a Fork

Spawn a sub-agent to perform the analysis and synthesis work. Keep the judgment-heavy summarization inside the fork.

The fork must:

1. Run `scripts/analyze-branch.ts` via the resolved `$ANALYZER` path.
2. Parse the JSON it prints: `{ outputPath, provider, hasCockpit, commitCount }`.
3. If `commitCount === 0`, return "no commits to propose" and stop the flow.
4. Read the `BranchMaterial` JSON from `outputPath`. It contains `commits`, `diffStat`, `decisions`, `base`, `head`, and `provider`.
5. If `provider === "unknown"`, return the analyzed material and tell the main agent to stop before Phase B. Chronicle cannot choose between `gh` and `glab` without a recognizable remote.
6. Synthesize a concise title and a four-section body.
7. Return exactly this hand-off shape to the main agent: `{ title, body, base, head, provider }`.

The body must have exactly these four sections:

```markdown
## Why

## What changed

## What to focus on

## How to judge
```

Section guidance:

- **Why**: explain the motivation. Prefer cockpit `decision` and `reason` records, then commit bodies. If `hasCockpit` is false, derive intent from commit subjects and bodies alone.
- **What changed**: summarize commits and `diffStat` by area. Do not dump the raw commit log; group related changes into reviewer-readable bullets or short paragraphs.
  - **Optional overview diagram.** When the PR has a *shape* a picture carries better than prose — a flow, a before/after, a sequence, a dependency or architecture change — open **What changed** with a single Mermaid diagram in a ```mermaid fenced block (GitHub and GitLab render it natively). Synthesize **one** cohesive diagram for the whole PR: draw on the harvested `decisions[].diagram` and the commit/diff structure as raw material, but do **not** paste the per-decision diagrams in — distill them into one. This is diagram-first, not diagram-always: skip it for a flat change (a one-line fix, a config bump) where a diagram adds noise, not clarity. Keep it plain Mermaid (no theming — the host renders it, not the cockpit dashboard).
- **What to focus on**: turn cockpit `tradeoff` fields, `kind:"caveat"` records, and `needs_your_call:true` records into review guidance. Call out risky or important files from `decisions[].files`.
- **How to judge**: state acceptance and test notes: commands to run, behavior to verify, and any manual checks implied by the commits or decisions.

Soft cockpit dependency: absence of cockpit data is never an error. When `hasCockpit` is false, still produce all four sections from commits and diff data. The **Why** and **What to focus on** sections may be thinner, but they must be present.

Title guidance: propose a concise, imperative title based on the dominant branch change.

## Main Agent Gate

Present the proposed title and the complete four-section body to the user before creating anything.

Use the host's interactive confirmation prompt:

- Claude Code: `AskUserQuestion`
- Codex or other harnesses: the equivalent interactive confirmation prompt

Offer these options:

- `Create it (Recommended)`: proceed with `draft:false`.
- `Open as draft`: proceed with `draft:true`.
- `Edit title/body`: collect the user's edits, revise the title and/or body, then present the updated proposal and ask again.
- `Abort`: stop without creating a PR/MR.

If Phase A reported `provider === "unknown"`, tell the user Chronicle cannot pick `gh` or `glab` because there is no recognizable remote, and stop before this create gate.

## Phase B: Create in a Fork

After the user chooses create or draft, spawn a sub-agent to create the request.

The fork must:

1. Build a `CreateInput` JSON object:

   ```json
   {
     "provider": "github",
     "title": "<confirmed title>",
     "body": "<confirmed body>",
     "base": "<base branch>",
     "head": "<head branch>",
     "draft": false
   }
   ```

   `provider` must be `github` or `gitlab`. Never pass `unknown`.

2. Run `scripts/request-creator.ts` via the resolved `$CREATOR` path, passing the `CreateInput` JSON on stdin or as the first argument.
3. Parse the `CreateResult`.

Result handling:

- `{ ok: true, url }`: report the URL plainly.
- `{ ok: false, reason: "missing-cli", message }`: report the message and suggest installing the matching CLI (`gh` for GitHub, `glab` for GitLab).
- `{ ok: false, reason: "no-remote", message }`: report that no usable git remote is configured, including the message.
- `{ ok: false, reason: "cli-error", message }`: report the CLI error message.

Never pretend success. If creation fails, relay the reason plainly and stop.
