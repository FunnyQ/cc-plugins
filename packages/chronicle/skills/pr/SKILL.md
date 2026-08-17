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

Spawn ONE **Storykeeper**. The Storykeeper owns the whole flow. It spawns a skald
to analyze the branch and synthesize a reviewer-legible body. It then spawns a
messenger to open the request. This keeps all branch/diff/`gh` output out of the
main conversation, and it preserves the "why" behind the change. This skill is
human-invoked only. Do not auto-trigger it from incidental PR/MR mentions.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:storykeeper   (subagent_type — a nested custom agent, NOT a fork)
       ├─ chronicle:skald    (sonnet) — analyze-branch.ts → harvest cockpit → title + 4-section body (+ overview diagram)
       └─ chronicle:messenger  (haiku)  — request-creator.ts → opens the PR/MR, returns the URL
```

Spawn via `subagent_type`, never fork. Spawn exactly one Storykeeper, in one
`Agent` call, with no `name`. This chain is nested and sequential, not a team:
never spawn the skald or the messenger yourself, and never put two agents in one
message. The Storykeeper must be able to spawn its children. It does not inherit
the main conversation.

There is **no final creation confirmation gate**. Invoking the skill is the
consent. The flow auto-creates after any first-run config interview. `draft`
defaults to `true`. A draft PR is the safe default for an auto-open. The main
agent may pass `draft:false` to open it ready.

The three agents live at `packages/chronicle/agents/{storykeeper,skald,messenger}.md`.
They auto-register as `chronicle:storykeeper` / `chronicle:skald` /
`chronicle:messenger`. Their full procedures — the four-section body spec, the
optional Mermaid overview diagram, and the `CreateInput`/`CreateResult` contract —
live in those files.

## The main agent's job (thin)

1. **Resolve the base branch before spawning.** Run the config resolver:

   ```bash
   bun "{SKILL_DIR}/scripts/pr-config.ts"
   ```

   Parse its status:

   - `status === "configured"` → use its `base`. Do not ask again.
   - `status === "needs-setup"` → this is the first run. Use the harness's interactive
     question tool to ask whether the repository uses GitHub Flow or Git Flow. Always
     offer both workflows. Use the returned `suggestions` only to prefill and recommend
     branch names detected from the repository. In Claude Code, use `AskUserQuestion`. In
     Codex, use `request_user_input` when available. If no structured question tool is
     available, ask directly and resume only after the answer. State in the question
     that the selection will create and commit `.chronicle/pr.json` on the current branch.
     - GitHub Flow: confirm its PR base. Then run
       `bun "{SKILL_DIR}/scripts/pr-config.ts" save github-flow "{base}"`.
     - Git Flow: confirm its production and development branches. Then run
       `bun "{SKILL_DIR}/scripts/pr-config.ts" save git-flow "{production}" "{development}"`.
     - Parse the saved result and use its `base`. The save command only writes
       `.chronicle/pr.json`. It never stages or commits.
     - Compare the current branch with the selected GitHub Flow `base` or Git Flow
       `production`. Apply the existing protected-branch confirmation when they match.
       Then run this as a visible shell command. This lets the PreToolUse guard inspect
       the literal `git commit` before anything is staged:

       ```bash
       git add -- .chronicle/pr.json && git commit --only \
         -m "🔧 chore: Configure Chronicle PR workflow" -- .chronicle/pr.json
       ```

       The config-only pathspec preserves unrelated staged changes. If the guard
       refuses or the commit fails, report it and stop. Never hide the commit inside
       `pr-config.ts`.
   - `status === "error"` or invalid config → report the error and stop. Never ignore a
     broken committed config and fall back to guessing.

   A base explicitly named in the user's current request overrides the resolved base for
   this invocation only. It does not rewrite config. See
   [references/pr-config.md](references/pr-config.md) for the schema and routing rules.

2. **Distill the `contextBrief`** — a tight summary of *why* this branch exists,
   drawn from this conversation (the Storykeeper and its children can't see the chat).
   This is the only "why" they get beyond the cockpit trail and commits.
3. **Spawn the Storykeeper** (`subagent_type: "chronicle:storykeeper"`), passing:
   - the **skill directory** — the skill's load-time "Base directory for this
     skill" banner value (so the children resolve `<skill dir>/scripts/analyze-branch.ts`
     and `<skill dir>/scripts/request-creator.ts`). Do not hard-code a
     repo-relative path or rely on `${CLAUDE_PLUGIN_ROOT}`.
     Pass it as a **literal absolute path**, never as a `$`-prefixed token —
     nothing sets that variable in a child's shell, so its command silently
     runs against `/`.
   - `contextBrief` (from step 2).
   - `base` — the explicit branch selected in step 1. Never pass `auto`.
   - `branch` — the current branch. If it is a protected branch, defer to the user's
     existing git-flow guard before spawning.
   - `draft` — optional. Default `true`. Pass `false` only if the user asked to open
     the PR ready rather than as a draft.

**Verify before reporting:**

- URL returned: confirm with `gh pr view "{url}"` or `glab mr view "{id-or-url}"`. A
  non-zero check means treat it as no URL.
- No URL (or failed check): before reporting failure, look for a request that already
  exists for `<branch>` — the creation may have landed before the error:

  ```bash
  gh pr list --repo "{repo-if-cross-fork}" --head "{qualified-head-or-branch}" \
    --state open --json url --jq '.[0].url'
  glab mr list --source-branch "{branch}" --state opened -F json \
    | jq -r '.[0].web_url // empty'
  ```

  A hit is the result. Report it as pre-existing/recovered, not newly created.
  Empty output or a non-zero exit → report no PR/MR plus Storykeeper's reason.
  Never infer a URL.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_storykeeper`, passing the literal skill directory, `contextBrief`,
   `base`, `branch`, and `draft`.
2. **Generic sub-agent API only**: first verify the stable role files exist under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   exactly one non-fork generic agent with task name `chronicle_storykeeper` and no
   inherited turns. Tell it to read and obey the `developer_instructions` in
   `storykeeper.toml` before it handles the same five inputs. Its stable instructions
   delegate sequentially to generic Skald and Messenger children that self-load their
   own TOMLs. Do not paste or improvise the role instructions in the spawn prompt.

If the registered role and stable TOMLs are both unavailable, tell the user to run
`chronicle:install` and start a new Codex thread. Do not silently replace the
Storykeeper → Skald → Messenger boundary with an inline flow.

Apply the same verification after Codex returns. Check with `gh pr view "{url}"` or
`glab mr view "{id-or-url}"`. On a no or failed URL, run the `--head`/`--source-branch`
lookup above before reporting failure. Never trust an unverified URL.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/pr/references/opencode.md` instead of the
spawn instructions above — bare agent names, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

## Edge Cases

- **No commits**: skald reports it. The Storykeeper returns `nothing to propose` and
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
