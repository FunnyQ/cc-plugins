# KERNEL-03: /cockpit-start skill

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
>
> **Depends on**: kernel/02
> **Blocks**: —
> **Status**: done

## Goal

A `/cockpit-start` skill that, at session open, has Claude **propose** a project goal + session goal, lets Q **confirm or edit** (the human gate), then calls `cockpit start` to write the meta + goal record and register the session.

## Files to create / modify

- `cockpit/skills/cockpit/SKILL.md` (new) — the skill definition + instructions.

## Implementation notes

This is a skill (markdown instructions), not code. It orchestrates the already-built `cockpit.ts` CLI.

### Frontmatter / trigger

Mirror the structure of other skills in this ecosystem (e.g. token-atlas `dashboard/SKILL.md`). Trigger phrases: `/cockpit-start`, "start cockpit", "set session goal", "開始 cockpit", "設定這次的目標". The skill is **explicitly invoked** — do not auto-fire on every session.

### Procedure the skill instructs Claude to follow

1. **Determine the session id** — use the current Claude Code session uuid (the value used in `~/.claude/projects/**/<id>.jsonl`). If unavailable, generate one and note it.
2. **Propose goals**: Claude drafts a one-line `project_goal` (persistent destination — reuse the existing `.cockpit/project-meta.md` frontmatter if present) and a `session_goal` (this leg of the journey), based on the conversation / repo state.
3. **Human gate**: present both to Q with `AskUserQuestion` (or plainly ask) — Q confirms, edits, or rejects. **Do not write anything until Q confirms.** This mirrors `needs_your_call`: the human holds the stick at goal-setting too.
4. **Write**: on confirmation, run
   ```bash
   bun cockpit/skills/cockpit/scripts/cockpit.ts start \
     --session <id> --session-goal "<confirmed>" --project-goal "<confirmed>"
   ```
   (resolve the script via the installed plugin path).
5. **Tell Claude how to log afterward**: include a short note that during implementation Claude should append decisions a diff can't explain via `cockpit log --session <id> --decision ... --reason ... [--tradeoff ...] [--file path ...] [--needs-call --option "A" --option "B"]`.
   - `--file` and `--option` are repeatable.
   - For a genuine handoff (`--needs-call`), supply the choices via `--option`, **then immediately run `cockpit wait <id>`** (as a background task) to park for Q's answer — the harness wakes Claude when Q picks an option or types a reply in the cockpit UI. `cockpit wait`/`cockpit send` live in the bridge bucket.

### Tone / scope notes for the SKILL.md body

- Keep the proposal short — one line each. Q reacts; he doesn't write from scratch.
- Not every session deserves a goal; the skill is opt-in.
- The skill's job ends once the goal record is written + session registered. Display is the dashboard's job.

## Acceptance criteria

- [x] `cockpit/skills/cockpit/SKILL.md` exists with valid frontmatter (name, description, trigger phrases) consistent with other skills in the repo.
- [x] The instructions make Claude propose goals and **wait for Q's confirmation** before writing (human gate is explicit).
- [x] The instructions invoke `cockpit.ts start` with `--session`, `--session-goal`, `--project-goal`.
- [x] The instructions explain post-start `cockpit log` usage including `--needs-call` for handoff moments.
- [x] The skill does not auto-trigger on every session (opt-in wording).

## Verification

- [x] Read SKILL.md back: confirm the propose→confirm→write order and that no write happens before confirmation.
- [x] Dry-run the documented `cockpit.ts start` command from a scratch dir → verifies the skill's command matches the cockpit CLI's actual `start` flags.

## Out of scope

- Auto goal-capture via a SessionStart hook — Deferred. Reason: hooks fire on every session and can't run the interactive propose→confirm gate.
- The `cockpit log` writer itself — already built (the cockpit CLI); this skill only documents its use.
