# SKILLS-06: Autopilot — OpenCode parity

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02
> **Status**: done

## Goal

A person invoking autopilot under OpenCode knows exactly how it behaves there — a hand-driven wave loop, not the Claude Code Workflow flight — and is never misled into expecting unattended parallel scheduling.

## Files to create / modify

- `packages/dispatch/skills/autopilot/SKILL.md` (modify) — OpenCode script-root branch **plus** the manual wave-loop section.
- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — one fenced qualifier near the top; the script itself is not ported.

Nothing else under `packages/dispatch` is touched. In particular `packages/dispatch/hooks/flightplan-lint.sh` is **never** edited: the OpenCode plugin module invokes it as-is, and it is simultaneously the live `PostToolUse` hook for Claude Code and Codex. Changing its stdin contract, exit codes, or output shape breaks those harnesses silently.

## Implementation notes

### The additive rule (this task's hardest constraint)

Every edit **adds** a self-contained, clearly fenced OpenCode block. Never rewrite, reorder, condense, or delete an existing Claude or Codex instruction — not even to "make room" or "tighten" the surrounding prose. A Claude Code reader must be able to skip the new block in one glance and find their own instructions byte-identical.

Use the same fence shape the other dispatch skills use, so the blocks stay greppable across the plugin: a heading of the form `#### Under OpenCode`, or a `> **Under OpenCode**` callout. One shape, everywhere.

Touching any `.ts` file, any `plugin.json`, or any hook script under `packages/` is an automatic Correctness 0 for this task.

### The script-root branch

`packages/dispatch/skills/autopilot/SKILL.md:47` resolves two paths — `<base>/../flightplan/scripts` as `$SCRIPTS` and `<base>/scripts` as `$OWN` — and warns that `CLAUDE_PLUGIN_ROOT` is unreliable, telling the reader to take `<base>` from the skill's load-time *"Base directory for this skill"* banner.

So the OpenCode branch is **not** "replace `CLAUDE_PLUGIN_ROOT`" — there is nothing to replace. It states the OpenCode install root outright. The rule to reproduce is quoted in `../_context/shared.md` under "The OpenCode skill root rule".

**S16 is resolved: OpenCode prints no banner.** Invoking a skill returns `# Skill: <name>` followed by the SKILL.md body and nothing else. State the literal `~/.config/opencode/skills/autopilot/` path outright for `$OWN`, and `~/.config/opencode/skills/flightplan/scripts` for `$SCRIPTS`. Do not hedge it as "if your harness prints one" — under OpenCode it never does.

The sibling-relative path survives the install layout, and this is worth stating in the branch: with each skill symlinked separately into the OpenCode skills root, `<base>/../flightplan/scripts` resolves to the flightplan skill either way — through the symlink root, where both siblings are installed, or through the realpath, where both siblings live in the repo.

### The manual wave loop — the substance of this task

`packages/dispatch/skills/autopilot/SKILL.md:33` currently opens with "Autopilot uses the **Workflow tool**. A skill whose instructions tell the agent to call Workflow is a *sanctioned opt-in*." Under OpenCode there is no Workflow tool (runtime fact S10). Autopilot therefore runs as a **hand-driven wave loop over the task tool**, and the branch must document it step by step:

1. Run the ready-task lister (`next-ready.ts`, from the flightplan skill's `scripts/`) against the tasks directory to get the current wave.
2. For each ready task in the wave, spawn a subagent through the task tool in the **dev role**, giving it the task file path.
3. Run that task's own `## Verification` commands.
4. Spawn a second subagent through the task tool in the **judge role**, to score the task against its `## Eval rubric`.
5. Run the scoring script (`score-task.ts`) with its JSON and logging flags, and gate on the printed verdict object. Do not re-derive the weighted average by hand — there is exactly one scoring implementation.
6. Retry the task until its rubric passes or the attempt cap is reached; park and escalate a capped task rather than silently skipping it.
7. Make one atomic commit **between** waves, never inside one — the tasks of a wave share a working tree.
8. Run the closing review task last, after every other task is done.

**State the parity caveat plainly, in the skill itself, not only here.** This is behaviorally close to the Claude Code flight but **not identical**: there is no automatic parallel-wave scheduling and no orchestrator process. The waves are driven by hand, one at a time, by whoever invoked the skill. A reader must not come away believing autopilot under OpenCode is the same unattended flight.

**S17 is resolved. Both roles spawn `subagent_type: general` with an inline role prompt.** There is no `dev` agent and no `judge` agent in this build and none is needed: `general` is a built-in subagent, and both roles are leaves that never spawn anything themselves. Write `general` in the skill, with the role carried entirely by the prompt.

One caveat to record in the branch: **the built-in `general` subagent has no `task` tool** and cannot spawn further, at any `subagent_depth`. That is fine for the dev and judge roles, but it means the wave loop's driver — the person or agent invoking the skill — must stay the one doing the spawning. There is no way to delegate the loop itself to a `general` subagent.

The wave loop spawns subagents through the task tool, so the driver needs `subagent_depth` at or above the installed value — see `../_context/shared.md` and runtime fact S14. Note this in the branch: below the required depth a spawn fails with no error naming the config, which reads as a plugin bug.

### Do not confuse the two meanings of "OpenCode" in this skill

`packages/dispatch/skills/autopilot/SKILL.md` **already** mentions OpenCode, at lines 80, 81, 91, 153, and 180. Every one of those is OpenCode as an **external engine autopilot delegates out to** — `CFG.devEngine: 'opencode'` and `CFG.reviewEngine`, driven through `opencode-run.ts`, giving a cross-vendor dev-versus-judge split while autopilot itself runs under Claude Code.

That is a completely different thing from autopilot **running under** OpenCode, which is what this task adds. Do not edit, "unify", or cross-reference the existing engine text, and make sure the new block cannot be misread as describing it. If the distinction is not obvious from placement alone, say so explicitly in one sentence.

### orchestrator.md — qualify, do not port

`packages/dispatch/skills/autopilot/references/orchestrator.md` is the canonical Workflow script (about 1200 lines), written entirely in Workflow terms: an orchestrator JS layer calling `agent()`, with claims that only hold there. Line 314 is the clearest example — "a Workflow agent has no Agent tool, so it can't spawn reviewers itself, but the orchestrator can."

Under the manual loop there is no orchestrator JS layer at all, so that claim has no OpenCode counterpart. Add a short fenced note near the top of the file stating that the script describes the Claude Code Workflow path, that OpenCode has no Workflow tool, and that under OpenCode the person driving the skill performs the orchestrator's role by hand.

**Do not port, translate, or rewrite the script.** One note at the top is the whole edit. Do not leave any statement asserting a spawn path that has no OpenCode counterpart without that qualifier reachable from it.

### Blocking runtime facts

All four facts this task needs are resolved, so nothing blocks it:

- **S10** — confirmed absent. The primary agent's tool list is `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`. `task` is the only spawn mechanism.
- **S17** — `general` is a built-in subagent and carries the dev and judge roles by prompt; it has no `task` tool and cannot spawn further.
- **S16** — no banner exists; state the literal install path.
- **S14** — nested spawning works for a custom agent declaring `permission.task: allow`, which is chronicle's shape, not autopilot's.

If a blocking fact is still marked `UNRESOLVED`, set this file's header to `> **Status**: blocked` and stop. Blocking is the correct outcome, not a failure.

## Acceptance criteria

- [x] No OpenCode-facing instruction added by this task uses `CLAUDE_PLUGIN_ROOT`.
- [x] The OpenCode block names all eight steps of the manual wave loop, in order, and states the "behaviorally close, not identical — no automatic parallel-wave scheduling" caveat in the skill text itself.
- [x] Neither spawn step names a `subagent_type` value that has no corresponding agent definition or confirmed built-in type.
- [x] The OpenCode block cannot be confused with the pre-existing external-engine text; the distinction between running under OpenCode and delegating out to it is unambiguous.
- [x] `packages/dispatch/skills/autopilot/references/orchestrator.md` carries a note that it describes the Claude Code Workflow path, and the script body itself is otherwise unchanged.
- [x] Every file changed under `packages/dispatch` is a `.md` file.
- [x] Every pre-existing Claude and Codex instruction survives unmodified; the diff contains additions only, no rewritten or reordered lines.

## Verification

- [x] Run `grep -n "CLAUDE_PLUGIN_ROOT" packages/dispatch/skills/autopilot/SKILL.md` and confirm every hit is a pre-existing Claude-facing warning, none inside a block added by this task.
- [x] Run `grep -n "Workflow" packages/dispatch/skills/autopilot/SKILL.md` and confirm the new OpenCode block states the tool is absent there, without contradicting the existing Claude Code statements.
- [x] Run `git diff --name-only -- packages/dispatch` and confirm every listed path ends in `.md`.
- [x] Run `git diff --stat -- packages/dispatch/skills/autopilot/references/orchestrator.md` and confirm the change is an insertion only, with zero deleted lines.
- [x] Run `git status --short -- packages/dispatch/skills/autopilot docs/opencode-compat/tasks/skills/06-autopilot-parity.md` and confirm both paths are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Touches a `.ts`, a `plugin.json`, or the lint hook script; ports the orchestrator script; or names a spawn type that does not exist | Wave loop present but a step is vague, or the branch asserts a runtime fact still marked unresolved | Eight-step loop concrete and ordered, spawn steps honest about the unresolved type, orchestrator note added without touching the script |
| Non-regression | ×2 | Existing Claude or Codex instructions rewritten, reordered, or deleted | Additions dilute a neighbouring instruction, or blocks are unfenced and hard to skip | Diff is purely additive, every block clearly fenced, a Claude reader's path untouched |
| Honest parity caveat | ×1 | Implies OpenCode autopilot equals the Claude flight | Caveat present but buried or hedged | A reader learns before the loop steps that waves are hand-driven and unattended scheduling does not exist |
| Assumptions & docs | ×1 | Invents banner, Workflow, or spawn-type behavior not observed | Facts cited loosely, or the two meanings of OpenCode left ambiguous | Every runtime-dependent claim names its fact, the engine-versus-harness distinction stated outright |

## Out of scope

- Porting `references/orchestrator.md` into an OpenCode-native orchestration script — Deferred. The manual loop is the documented parity story for now; a native mechanism is a later project.
- Changing how autopilot delegates to the opencode CLI as a dev or review engine — Deferred. That path already works and is a different feature from running under OpenCode.
- Creating `dev` or `judge` agent definitions — Deferred. If the runtime turns out to require them, that is a change to the installer's target count and its tests, not something to smuggle in here.
- Editing `packages/dispatch/hooks/flightplan-lint.sh` in any way — permanently out of scope. The OpenCode module invokes it unchanged, and it is the live hook for two other harnesses.
