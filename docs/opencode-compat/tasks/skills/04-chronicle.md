# SKILLS-04: Chronicle skills — OpenCode branches

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02, assets/01
> **Status**: todo

## Goal

Chronicle's five skills carry an OpenCode branch, so an OpenCode session resolves their scripts, spawns their orchestrators through the task tool, and is told the real `subagent_depth` prerequisite.

## Files to create / modify

- `packages/chronicle/skills/commit/SKILL.md` (modify) — OpenCode spawn lines for the commit topology, root rule in the plugin-root paragraph
- `packages/chronicle/skills/pr/SKILL.md` (modify) — same for the PR topology
- `packages/chronicle/skills/adr/SKILL.md` (modify) — same for the three-phase ADR topology
- `packages/chronicle/skills/release/SKILL.md` (modify) — same for the two flat leaf spawns; confirm the release-subject wording
- `packages/chronicle/skills/install/SKILL.md` (modify) — a new OpenCode section beside the existing Claude Code and Codex ones

Nothing else changes. No new files.

## Implementation notes

### The additive rule, and why it is absolute

Every edit **adds** a clearly fenced OpenCode block. Never rewrite, reorder, condense, or delete an existing Claude Code or Codex instruction, and never "tidy up" surrounding prose while you are in the file. These five files are live instructions for two shipping harnesses; a reworded sentence is a silent regression that no test catches.

Keep each OpenCode block self-contained and visually skippable — its own subsection heading, or a single fenced paragraph that opens by naming OpenCode. A Claude Code reader must be able to skip it in one glance. Diluting an existing instruction is a regression even when nothing was deleted.

Absolutely off-limits in this task:

- Any `.ts` file under `packages/chronicle/`.
- Every file under `packages/chronicle/agents/`. The OpenCode versions are separate new files; the originals stay byte-identical.
- `packages/chronicle/hooks/check-branch.sh`. The OpenCode plugin module **invokes** that script exactly as it stands — it is the live hook path for Claude Code and Codex at the same time. Changing its stdin contract, exit codes, or output shape breaks both.
- `packages/chronicle/.claude-plugin/plugin.json` and anything under `packages/chronicle/.codex-plugin/`.

### The skill root rule

Apply the rule quoted in `../_context/shared.md` wherever a skill currently warns about `${CLAUDE_PLUGIN_ROOT}` or tells the reader to resolve a script through it. Known sites: `commit/SKILL.md` around line 60, `pr/SKILL.md` around line 96, `release/SKILL.md` around line 64. Re-grep rather than trusting those line numbers — the files may have moved.

`install/SKILL.md` uses `$PLUGIN_ROOT` (the Codex variable, lines 63 and 69) rather than the Claude one. Leave those lines alone; they belong to the Codex section.

### Agent names are namespaced on Claude, bare on OpenCode

This is the detail most likely to be got wrong. The existing skills spawn `subagent_type: "chronicle:lawspeaker"` — plugin-namespaced. OpenCode resolves an agent by its **filename**, so the converted files register under bare names:

| Claude Code | OpenCode |
|---|---|
| `chronicle:lawspeaker` | `lawspeaker` |
| `chronicle:watcher` | `watcher` |
| `chronicle:runesmith` | `runesmith` |
| `chronicle:storykeeper` | `storykeeper` |
| `chronicle:skald` | `skald` |
| `chronicle:messenger` | `messenger` |
| `chronicle:lorekeeper` | `lorekeeper` |
| `chronicle:gleaner` | `gleaner` |
| `chronicle:reckoner` | `reckoner` |
| `chronicle:codifier` | `codifier` |
| `chronicle:barrowkeeper` | `barrowkeeper` |
| `chronicle:skirnir` | `skirnir` |
| `chronicle:annalist` | `annalist` |

Write the bare name in every OpenCode line. Verify each one against the converted OpenCode agent files on disk before writing it — a name that does not resolve produces a spawn failure at runtime with nothing pointing back here.

### Spawn points to annotate

Each site gets one added line of the form: *under OpenCode, spawn via the task tool with `subagent_type: <bare-name>`*.

- **commit** — the topology block (around lines 30–43) and the spawn step (around line 56). The chain is: the skill spawns the Lawspeaker, which itself spawns the watcher and the runesmith. Two levels of nesting.
- **pr** — the topology block (around lines 23–41) and the spawn step (around line 92). The skill spawns the Storykeeper, which spawns the skald and then the messenger. Two levels.
- **adr** — the phase diagram (around lines 26–36) and the collect-phase spawn (around line 178). The skill spawns one Lorekeeper per phase; the Lorekeeper spawns the gleaner and reckoner in collect, the codifier in draft, and the barrowkeeper in commit. Two levels. Preserve the existing rule that the main agent never spawns those four itself.
- **release** — the skirnir spawn (around line 25) and the annalist spawn (around lines 116–120). Release is **flat**: it spawns leaf agents directly, one level only. Say so, because it means release keeps working below the depth the other three need.

### The `subagent_depth` prerequisite is real — do not deny it

An earlier draft of this work claimed OpenCode has no spawn-depth gate. That was wrong, and the correction is the whole point of the install-skill edit.

OpenCode gates nested spawning with `subagent_depth`, a plain number in `~/.config/opencode/opencode.json`. Chronicle needs **at least 2**, for the same reason it needs `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` on Claude Code: its deepest chain is skill → orchestrator → child.

The difference is *who sets it*. On Claude Code a `SessionStart` hook self-heals it. OpenCode has no session-start hook, so the repo's OpenCode installer raises the value under its apply flag instead — raise-only, preserving every other key. Point the reader at that installer.

State the failure signature explicitly, because it is the reason this section exists: **below the required depth the orchestrator simply stops.** No error names the config. It reads as a plugin bug, exactly as Claude Code 2.1.217 behaved when it shipped nested spawning off by default.

Mirror the existing Claude Code section's structure and note the same nuance it already carries: `release` is flat and does not need the raised depth.

### Context inheritance shapes the spawn wording

Runtime fact **S9** — whether a task-tool subagent inherits the caller's conversation context — changes what these instructions must say. An orchestrator that inherits context can be handed a short brief; one that starts clean needs every parameter passed explicitly, the way the existing skills already pass `contextBrief`, `branch`, and `mode`.

Do not guess. If S9 is `UNRESOLVED` in `../_context/runtime-facts.md`, set this task's `> **Status**: blocked` and stop. Guessing wrong produces spawn instructions that silently drop the orchestrator's inputs.

### The release-subject exemption

The branch guard exempts a commit whose subject contains `🔧 release:` on the base branch, and it behaves the same way under OpenCode because the same shell script runs. Confirm the release skill's own wording still matches that behavior; if it already does, change nothing — this is a read-and-confirm step, not an edit.

## Acceptance criteria

- [ ] All five chronicle `SKILL.md` files carry an OpenCode branch.
- [ ] No OpenCode-facing instruction in any of the five files uses `CLAUDE_PLUGIN_ROOT`.
- [ ] Every `subagent_type` name written into an OpenCode line is a bare name that resolves to an existing converted OpenCode agent file.
- [ ] The install skill states the `subagent_depth ≥ 2` prerequisite and its silent failure signature — it does not claim the step is unnecessary under OpenCode.
- [ ] The install skill's OpenCode section preserves the existing nuance that `release` is flat and does not need the raised depth.
- [ ] Every edit is additive: no existing Claude Code or Codex sentence is reworded, reordered, or removed.
- [ ] Only `.md` files changed under `packages/chronicle/`.
- [ ] `git diff --quiet -- packages/chronicle/agents packages/chronicle/hooks` exits 0.
- [ ] `git diff --quiet -- packages/chronicle/.claude-plugin packages/chronicle/.codex-plugin` exits 0.

## Verification

- [ ] `git diff --name-only -- packages/chronicle` lists only `skills/*/SKILL.md` paths.
- [ ] `git diff --quiet -- packages/chronicle/agents packages/chronicle/hooks packages/chronicle/.claude-plugin packages/chronicle/.codex-plugin && echo CLEAN` prints `CLEAN`.
- [ ] `grep -rn 'CLAUDE_PLUGIN_ROOT' packages/chronicle/skills/*/SKILL.md` — every remaining hit sits in a Claude Code paragraph, none in an OpenCode block.
- [ ] `grep -rn 'subagent_type' packages/chronicle/skills/*/SKILL.md` — every OpenCode-block name is bare, and each one has a matching file in `opencode/agents/`.
- [ ] `git diff -- packages/chronicle` read end to end: confirm every hunk is an addition, with no modified or deleted line outside the added blocks.
- [ ] `git status --short -- packages/chronicle docs/opencode-compat/tasks/skills/04-chronicle.md` shows the five skill files and this task file as dirty.
- [ ] `bun test packages/` passes.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Denies the `subagent_depth` prerequisite, or writes namespaced names into OpenCode lines | All five files touched but a spawn point missed, or the depth failure signature left unstated | Every spawn point annotated with a resolving bare name; the depth prerequisite, its owner, and its silent failure signature all stated |
| Non-regression | ×2 | A `.ts`, a hook script, an agent file, or a manifest under `packages/` changed | Only `.md` changed, but an existing sentence was reworded or a section reordered | Diff is purely additive; every Claude Code and Codex instruction byte-identical |
| Spawn-map accuracy | ×1 | A child attributed to the wrong orchestrator | Map correct but nesting depth per skill unstated | Every parent-child edge correct, and release identified as flat rather than nested |
| Assumptions & docs | ×1 | Guesses an unresolved runtime fact | Cites the fact but hedges the instruction both ways | Blocks on an unresolved fact, or cites the resolved value and writes one unambiguous instruction |

## Out of scope

- Converting the agent definitions themselves — those are separate new files under `opencode/agents/`, produced elsewhere. Deferred. Reason: this task only references their names; creating them here would duplicate work and risk editing the Claude originals.
- Building or changing the OpenCode installer. Deferred. Reason: this task points readers at it; its flags and behavior are specified elsewhere.
- README and CLAUDE.md updates. Deferred. Reason: repo-level docs are written once, after all five plugins' skills settle, so the phrasing stays consistent.
- Any change to `check-branch.sh` to make it "more reusable" from the OpenCode module. Deferred permanently. Reason: it is the live hook path for two other harnesses.
