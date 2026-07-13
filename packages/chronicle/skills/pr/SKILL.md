---
name: pr
description: Open a PR (GitHub) or MR (GitLab) for the current branch, with a body a
  reviewer can actually understand — why the change exists, what changed, what to focus
  on, how to judge it — enriched by the cockpit decision trail when present. Triggers on
  "/chronicle:pr", "create a PR", "open a pull request", "open an MR", "幫我開 PR",
  "建立 merge request". Human-invoked only.
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
       `bun "$SKILL_DIR/scripts/pr-config.ts" save github-flow <base> --commit`.
     - Git Flow: confirm its production and development branches, then run
       `bun "$SKILL_DIR/scripts/pr-config.ts" save git-flow <production> <development> --commit`.
     - Parse the saved result and use its `base`. The command creates the committed
       `.chronicle/pr.json`, stages only that file, and commits it with Chronicle's
       config commit format so later runs do not ask again. Apply the existing protected
       branch guard before running the save command; stop if that guard refuses a commit.
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

The Storykeeper returns the final result; the main agent relays it to the user (the PR/MR
URL, noting draft vs ready, or the failure reason) and nothing else.

## What the Storykeeper does (reference)

Full procedure in `agents/storykeeper.md`. In brief: spawn `chronicle:skald` → if there
are commits and a known provider, spawn `chronicle:messenger` with the confirmed
`CreateInput` → relay the `CreateResult` up. Stops without creating when there are
no commits or the provider is `unknown`.

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
