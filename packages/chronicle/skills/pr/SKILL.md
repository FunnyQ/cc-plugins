---
name: pr
description: >-
  Open a PR (GitHub) or MR (GitLab) for the current branch, with a
  reviewer-legible body enriched by the cockpit decision trail when present.
when_to_use: >-
  When the user wants a PR/MR opened for the current branch. Human-invoked
  only — do NOT auto-fire from an incidental mention of a PR.
---

# Chronicle PR Skill

Spawn ONE **Storykeeper** that owns the whole flow: it spawns a skald to analyze the
branch + synthesize a reviewer-legible body, then a messenger to open the request —
keeping all branch/diff/`gh` output out of the main conversation while preserving
the "why" behind the change. Human-invoked only; do not auto-trigger from incidental
PR/MR mentions.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:storykeeper   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:skald    (sonnet) — analyze-branch.ts → harvest cockpit → title + 4-section body (+ overview diagram)
       └─ chronicle:messenger  (haiku)  — request-creator.ts → opens the PR/MR, returns the URL
```

Spawn via `subagent_type`, never fork: the Storykeeper must be able to spawn its
children and does not inherit the main conversation.

There is **no final creation confirmation gate** — invoking the skill is the consent,
and the flow auto-creates after any first-run config interview. `draft` defaults to
`true` (a draft PR is the safe default for an auto-open; the main agent may pass
`draft:false` to open it ready).

The three agents live at `packages/chronicle/agents/{storykeeper,skald,messenger}.md`
and auto-register as `chronicle:storykeeper` / `chronicle:skald` /
`chronicle:messenger`. Their full procedures (the four-section body spec, the
optional Mermaid overview diagram, the `CreateInput`/`CreateResult` contract) live
in those files.

## The main agent's job (thin)

1. **Resolve the base branch before spawning.** Run the config resolver:

   ```bash
   bun "$SKILL_DIR/scripts/pr-config.ts"
   ```

   Parse its status:

   - `status === "configured"` → use its `base`. Do not ask again.
   - `status === "needs-setup"` → this is the first run. Use the harness's interactive
     question tool to ask whether the repository uses GitHub Flow or Git Flow. Always
     offer both workflows; use the returned `suggestions` only to prefill and recommend
     branch names detected from the repository. In Claude Code use `AskUserQuestion`; in Codex use
     `request_user_input` when available. If no structured question tool is available,
     ask directly and resume only after the answer. State in the question that the
     selection will create and commit `.chronicle/pr.json` on the current branch.
     - GitHub Flow: confirm its PR base, then run
       `bun "$SKILL_DIR/scripts/pr-config.ts" save github-flow <base>`.
     - Git Flow: confirm its production and development branches, then run
       `bun "$SKILL_DIR/scripts/pr-config.ts" save git-flow <production> <development>`.
     - Parse the saved result and use its `base`. The save command only writes
       `.chronicle/pr.json`; it never stages or commits.
     - Compare the current branch with the selected GitHub Flow `base` or Git Flow
       `production`. Apply the existing protected-branch confirmation when they match,
       then run this as a visible shell command so the PreToolUse guard can inspect the
       literal `git commit` before anything is staged:

       ```bash
       git add -- .chronicle/pr.json && git commit --only \
         -m "🔧 chore: Configure Chronicle PR workflow" -- .chronicle/pr.json
       ```

       The config-only pathspec preserves unrelated staged changes. If the guard
       refuses or the commit fails, report it and stop; never hide the commit inside
       `pr-config.ts`.
   - `status === "error"` or invalid config → report the error and stop. Never ignore a
     broken committed config and fall back to guessing.

   A base explicitly named in the user's current request overrides the resolved base for
   this invocation only; it does not rewrite config. See
   [references/pr-config.md](references/pr-config.md) for the schema and routing rules.

2. **Distill the `contextBrief`** — a tight summary of *why* this branch exists,
   drawn from this conversation (the Storykeeper and its children can't see the chat).
   This is the only "why" they get beyond the cockpit trail and commits.
3. **Spawn the Storykeeper** (`subagent_type: "chronicle:storykeeper"`), passing:
   - `$SKILL_DIR` — the skill's load-time "Base directory for this skill" banner
     value (so the children resolve `$SKILL_DIR/scripts/analyze-branch.ts` and
     `$SKILL_DIR/scripts/request-creator.ts`). Do not hard-code a repo-relative path
     or rely on `${CLAUDE_PLUGIN_ROOT}`.
   - `contextBrief` (from step 2).
   - `base` — the explicit branch selected in step 1. Never pass `auto`.
   - `branch` — the current branch. If it is a protected branch, defer to the user's
     existing git-flow guard before spawning.
   - `draft` — optional; default `true`. Pass `false` only if the user asked to open
     the PR ready rather than as a draft.

**Verify before reporting:**

- URL returned: confirm with `gh pr view <url>` or `glab mr view <id-or-url>`; a
  non-zero check means treat it as no URL.
- No URL (or failed check): before reporting failure, look for a request that already
  exists for `<branch>` — the creation may have landed before the error:

  ```bash
  gh pr list --repo <repo-if-cross-fork> --head <qualified-head-or-branch> \
    --state open --json url --jq '.[0].url'
  glab mr list --source-branch <branch> --state opened -F json \
    | jq -r '.[0].web_url // empty'
  ```

  A hit is the result — report it as pre-existing/recovered, not newly created.
  Empty output or a non-zero exit → report no PR/MR plus Storykeeper's reason.
  Never infer a URL.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_storykeeper`, passing `$SKILL_DIR`, `contextBrief`, `base`, `branch`,
   and `draft`.
2. **Generic sub-agent API only**: first verify the stable role files exist under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   exactly one non-fork generic agent with task name `chronicle_storykeeper`, no
   inherited turns, and tell it to read and obey the `developer_instructions` in
   `storykeeper.toml` before handling the same five inputs. Its stable instructions
   delegate sequentially to generic Skald and Messenger children that self-load their
   own TOMLs. Do not paste or improvise the role instructions in the spawn prompt.

If the registered role and stable TOMLs are both unavailable, tell the user to run
`chronicle:install` and start a new Codex thread. Do not silently replace the
Storykeeper → Skald → Messenger boundary with an inline flow.

Apply the same verification after Codex returns: `gh pr view <url>` / `glab mr view
<id-or-url>`, and on no/failed URL the `--head`/`--source-branch` lookup above before
reporting failure. Never trust an unverified URL.

## Edge Cases

- **No commits**: skald reports it; the Storykeeper returns `nothing to propose` and
  stops.
- **No `.chronicle/pr.json`**: run the first-use workflow interview and commit the
  generated config with the current branch.
- **Invalid `.chronicle/pr.json`**: report the validation error and stop; committed
  intent must be fixed explicitly.
- **Unknown provider** (no recognizable `github`/`gitlab` remote): the Storykeeper stops
  before creation — there is nothing it can open.
- **Creation failure** (missing CLI / no remote / CLI error): the messenger returns
  `{ ok:false, reason, message }`; the Storykeeper relays it plainly. Never pretend
  success.
