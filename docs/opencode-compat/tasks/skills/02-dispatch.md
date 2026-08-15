# SKILLS-02: Dispatch skills — OpenCode branches

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/02
> **Status**: todo

## Goal

A person running dispatch's planning skills under OpenCode can resolve every script path, without a Claude Code or Codex reader noticing any change to their own instructions.

## Files to create / modify

- `packages/dispatch/skills/preflight/SKILL.md` (audit) — expected to need **no change**; confirm and record why.
- `packages/dispatch/skills/flightplan/SKILL.md` (modify) — OpenCode script-root branch.
- `packages/dispatch/skills/waypoints/SKILL.md` (modify) — OpenCode script-root branch.

Autopilot is deliberately **not** in this task's file list. Its OpenCode branch is a much heavier piece of work — a whole manual wave-loop story plus a qualifier on a ~1200-line reference — and it is specified separately so neither half starves the other. Do not edit `packages/dispatch/skills/autopilot/` here.

Nothing else under `packages/dispatch` is touched. In particular `packages/dispatch/hooks/flightplan-lint.sh` is **never** edited: the OpenCode plugin module invokes it as-is, and it is simultaneously the live `PostToolUse` hook for Claude Code and Codex. Changing its stdin contract, exit codes, or output shape breaks those harnesses silently.

## Implementation notes

### The additive rule (this is the task's hardest constraint)

Every edit **adds** a self-contained, clearly fenced OpenCode block. Never rewrite, reorder, condense, or delete an existing Claude or Codex instruction — not even to "make room" or "tighten" the surrounding prose. A Claude Code reader must be able to skip the new block in one glance and find their own instructions byte-identical.

Use a consistent fence across all four skills so the blocks are greppable, for example a heading of the form `#### Under OpenCode` or a `> **Under OpenCode**` callout. Pick one shape and use it everywhere.

Touching any `.ts` file, any `plugin.json`, or any hook script under `packages/` is an automatic Correctness 0 for this task.

### These skills do not use `CLAUDE_PLUGIN_ROOT` — check before you write

This is the most likely place to write a wrong instruction. All three script-bearing skills **already** avoid `CLAUDE_PLUGIN_ROOT` and resolve scripts from the skill's load-time *"Base directory for this skill"* banner instead:

- `packages/dispatch/skills/flightplan/SKILL.md:34` — "`CLAUDE_PLUGIN_ROOT` is **not** reliably set in Bash. Take the skill's load-time *"Base directory for this skill"* banner and set `SCRIPTS="<base-dir>/scripts"`."
- `packages/dispatch/skills/waypoints/SKILL.md:38` — the same instruction.

So the OpenCode branch is **not** "replace `CLAUDE_PLUGIN_ROOT`" — there is nothing to replace. It is: state the OpenCode install root as the concrete value the banner resolves to, so a reader whose harness prints no banner can still find the scripts. The rule to reproduce is quoted in `../_context/shared.md` under "The OpenCode skill root rule".

**S16 is resolved: OpenCode prints no banner.** Invoking a skill returns `# Skill: <name>` followed by the SKILL.md body and nothing else. So the OpenCode block must state the literal `~/.config/opencode/skills/<name>/scripts/` path outright. Do **not** hedge it as "the value the banner resolves to" or "if your harness prints one" — under OpenCode it never does, and a conditional instruction leaves the reader with no path at all.

### preflight — audit only

`packages/dispatch/skills/preflight/SKILL.md` contains no `CLAUDE_PLUGIN_ROOT` reference, no `SCRIPTS=` resolution, and no bundled-script invocation. It plans and executes in conversation. The expected outcome is **no edit**.

Confirm this by grep rather than by assumption, and record the confirmation in the task report. If a script reference does turn up, apply the same root rule as the other skills.

### flightplan and waypoints — the script-root branch

Add the OpenCode block next to each skill's existing script-resolution paragraph (near `SKILL.md:34` for flightplan, `SKILL.md:38` for waypoints). The block states where the skill is installed under OpenCode and how to resolve `scripts/` from there.

Keep it short. These two skills need nothing else — their behavior does not otherwise change across harnesses.

### Blocking runtime facts

Runtime fact **S16** is resolved — OpenCode prints no base-directory banner — and it is the only fact this task needs. Nothing blocks it.

If a fact you decide you need is still marked `UNRESOLVED`, set this file's header to `> **Status**: blocked` and stop. Blocking is the correct outcome, not a failure.

## Acceptance criteria

- [ ] No OpenCode-facing instruction added by this task uses `CLAUDE_PLUGIN_ROOT`.
- [ ] Both the flightplan and waypoints skills carry an OpenCode block naming the concrete install root and how to resolve `scripts/` from it.
- [ ] The preflight audit is recorded — either "no change needed, confirmed by grep" or the change applied.
- [ ] Nothing under `packages/dispatch/skills/autopilot/` is modified by this task.
- [ ] Every file changed under `packages/dispatch` is a `.md` file.
- [ ] Every pre-existing Claude and Codex instruction survives unmodified; the diff contains additions only, no rewritten or reordered lines.

## Verification

- [ ] Run `grep -rn "CLAUDE_PLUGIN_ROOT" packages/dispatch/skills/flightplan packages/dispatch/skills/waypoints packages/dispatch/skills/preflight` and confirm every hit is a pre-existing Claude-facing warning, none of them inside a block added by this task.
- [ ] Run `grep -c "opencode" packages/dispatch/skills/preflight/SKILL.md` and confirm the audit outcome matches what the task reported.
- [ ] Run `git diff --name-only -- packages/dispatch/skills/preflight packages/dispatch/skills/flightplan packages/dispatch/skills/waypoints` and confirm every listed path ends in `.md`. Scope it to those three directories — the autopilot skill is another task's territory and may be dirty in the same working tree.
- [ ] Run `git diff --stat -- packages/dispatch/skills/preflight packages/dispatch/skills/flightplan packages/dispatch/skills/waypoints` and confirm the deleted-line count is zero.
- [ ] Run `git status --short -- packages/dispatch/skills/flightplan packages/dispatch/skills/waypoints docs/opencode-compat/tasks/skills/02-dispatch.md` and confirm the paths this task edited are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Touches a `.ts`, a `plugin.json`, the lint hook script, or the autopilot skill | A block is present but names the wrong install root, or hedges the path conditionally instead of stating it | Both script-bearing skills carry a correct, concrete OpenCode root block; the preflight audit is recorded with evidence |
| Non-regression | ×2 | Existing Claude or Codex instructions rewritten, reordered, or deleted | Additions dilute a neighbouring instruction, or blocks are unfenced and hard to skip | Diff is purely additive, every block clearly fenced and consistently shaped, a Claude reader's path is untouched |
| Phrasing consistency | ×1 | Each skill invents its own wording and fence shape | Wording is close but the fence shape or path form drifts between the two skills | One fence shape, one path form, wording that would read identically in any of the five plugins |
| Assumptions & docs | ×1 | Invents banner behavior not observed | Facts cited loosely | Every runtime-dependent claim names its fact, and provisional wording is flagged as provisional |

## Out of scope

- Autopilot's OpenCode branch and its orchestrator reference — Deferred to a separate task, because the wave-loop story and a ~1200-line reference are a different weight class from adding a path line.
- Editing `packages/dispatch/hooks/flightplan-lint.sh` in any way — permanently out of scope. The OpenCode module invokes it unchanged, and it is the live hook for two other harnesses.
