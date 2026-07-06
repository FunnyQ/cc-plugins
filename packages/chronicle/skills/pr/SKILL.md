---
name: pr
description: Open a PR (GitHub) or MR (GitLab) for the current branch, with a body a
  reviewer can actually understand — why the change exists, what changed, what to focus
  on, how to judge it — enriched by the cockpit decision trail when present. Triggers on
  "/chronicle:pr", "create a PR", "open a pull request", "open an MR", "幫我開 PR",
  "建立 merge request". Human-invoked only.
---

# Chronicle PR Skill

Spawn ONE **Editor** that owns the whole flow: it spawns a drafter to analyze the
branch + synthesize a reviewer-legible body, then a publisher to open the request —
keeping all branch/diff/`gh` output out of the main conversation while preserving
the "why" behind the change. Human-invoked only; do not auto-trigger from incidental
PR/MR mentions.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:editor   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:drafter    (sonnet) — analyze-branch.ts → harvest cockpit → title + 4-section body (+ overview diagram)
       └─ chronicle:publisher  (haiku)  — request-creator.ts → opens the PR/MR, returns the URL
```

Spawn via `subagent_type`, never fork (a fork cannot spawn children); design
rationale lives in `packages/chronicle/DESIGN.md`.

There is **no human confirmation gate** — invoking the skill is the consent, and the
flow auto-creates. `draft` defaults to `true` (a draft PR is the safe default for an
auto-open; the main agent may pass `draft:false` to open it ready).

The three agents live at `packages/chronicle/agents/{editor,drafter,publisher}.md`
and auto-register as `chronicle:editor` / `chronicle:drafter` /
`chronicle:publisher`. Their full procedures (the four-section body spec, the
optional Mermaid overview diagram, the `CreateInput`/`CreateResult` contract) live
in those files.

## The main agent's job (thin)

1. **Distill the `contextBrief`** — a tight summary of *why* this branch exists,
   drawn from this conversation (the Editor and its children can't see the chat).
   This is the only "why" they get beyond the cockpit trail and commits.
2. **Spawn the Editor** (`subagent_type: "chronicle:editor"`), passing:
   - `$SKILL_DIR` — the skill's load-time "Base directory for this skill" banner
     value (so the children resolve `$SKILL_DIR/scripts/analyze-branch.ts` and
     `$SKILL_DIR/scripts/request-creator.ts`). Do not hard-code a repo-relative path
     or rely on `${CLAUDE_PLUGIN_ROOT}`.
   - `contextBrief` (from step 1).
   - `branch` — the current branch. If it is a protected branch, defer to the user's
     existing git-flow guard before spawning.
   - `draft` — optional; default `true`. Pass `false` only if the user asked to open
     the PR ready rather than as a draft.

The Editor returns the final result; the main agent relays it to the user (the PR/MR
URL, noting draft vs ready, or the failure reason) and nothing else.

## What the Editor does (reference)

Full procedure in `agents/editor.md`. In brief: spawn `chronicle:drafter` → if there
are commits and a known provider, spawn `chronicle:publisher` with the confirmed
`CreateInput` → relay the `CreateResult` up. Stops without creating when there are
no commits or the provider is `unknown`.

## Codex

Codex has no named-agent registry. There the main agent runs the same flow inline:
distill the why → analyze + draft → create, honoring the same auto-create +
`draft:true`-default behavior.

## Edge Cases

- **No commits**: drafter reports it; the Editor returns `nothing to propose` and
  stops.
- **Unknown provider** (no recognizable `github`/`gitlab` remote): the Editor stops
  before creation — there is nothing it can open.
- **Creation failure** (missing CLI / no remote / CLI error): the publisher returns
  `{ ok:false, reason, message }`; the Editor relays it plainly. Never pretend
  success.
