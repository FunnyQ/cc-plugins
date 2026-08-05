# PROMOTE-02: Write the skill and wire it into the repo docs

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: triage/03, triage/04, triage/05, promote/01
> **Blocks**: promote/03
> **Status**: done

## Goal

The thin router that turns the scripts and agents into an invokable skill, with both confirmation gates in the main agent where the rest of chronicle keeps them.

## Files to create / modify

- `packages/chronicle/skills/adr/SKILL.md` (new) — the router
- `CLAUDE.md` (modify) — name the adr skill in the plugin table, the chronicle summary, and the architecture tree

## Implementation notes

### Shape

Match the sibling chronicle skill files. `packages/chronicle/skills/pr/SKILL.md` runs 154 lines and `packages/chronicle/skills/release/SKILL.md` runs 201 — aim between them, roughly 150–200. The structure they share:

1. YAML frontmatter with `name`, `description`, `when_to_use`, and `argument-hint`.
2. A one-paragraph statement of what the main agent owns versus what the orchestrator owns.
3. A `## Topology` fenced block.
4. One section per mode.
5. A `## Codex` section covering the two role-loading paths.
6. A closing constraints / edge-cases section.

Frontmatter to write:

```yaml
---
name: adr
description: >-
  Triage the cockpit decision trail as an inbox and promote the decisions that
  mattered into Architecture Decision Records under docs/adr/.
when_to_use: >-
  When the user wants to review the decision trail, record an architecture
  decision, or replace one. Human-invoked only — do NOT auto-fire from a Stop
  hook, a scribe run, or an incidental mention of a decision.
argument-hint: "triage | promote <candidate-or-topic> | supersede <adr-id>"
---
```

It **routes**. It does not restate what the agent definitions already say — their input contracts, output shapes, and per-role procedures live in their own files. A skill file that duplicates them is too fat, not thorough.

### Both confirmation gates live here, in the main agent

This is the single most important structural fact in the task, and it is a deliberate departure from an earlier sketch that put the gates in the orchestrator.

Every other chronicle flow gates in the main agent before spawning its orchestrator. The release skill's own topology block is explicit about it — the main agent is annotated as "the ONLY one that can prompt you", and its orchestrator is spawned *after* the version gate resolves. A nested subagent asking the user is unverified behaviour, and the orchestrator here holds no Bash and no `Write`, so it has nothing to gate on anyway.

Use `cockpit wait` for both gates rather than `AskUserQuestion`, the way the release skill already specifies for its version gate.

Reproduce this topology in the file:

```text
chronicle:adr  (this skill — the main agent; owns both gates)
  ├─ lorekeeper(collect) → gleaner, reckoner   skeletons → clusters → dispositions + assignments
  ├─ [GATE 1]  Q confirms the dispositions
  ├─ lorekeeper(draft)   → codifier            draft the ADR from the confirmed candidates
  ├─ [GATE 2]  Q confirms the draft and its target path
  └─ lorekeeper(commit)  → barrowkeeper        write, apply any link update, validate, archive
```

**Three invocations, not one.** A subagent invocation ends the moment it returns, so an orchestrator cannot both run the whole flow and hand control back at each gate — the first return would end the run and the flow would stop after gate 1. So the skill spawns the orchestrator once per phase and **holds the state between them itself**: the confirmed candidate ids across gate 1, and the approved draft, its target path, and the archive-plan path across gate 2. Write out what each phase must be handed, because an orchestrator spawned without its carry-over cannot recover it, and re-running collection to reconstruct an approved candidate list would silently substitute a different one.

**A triage run that promotes nothing still has work to do.** When every disposition comes back `skip` or `watch` there is no draft to confirm, so gate 2 has nothing to gate — but the stale sessions still have to be archived, and leaving them means the next run re-judges the same backlog and the inbox never empties. Spell the branch out rather than leaving it to be improvised:

- After gate 1, if no candidate is dispositioned `promote`, **skip the draft phase and gate 2 entirely** and go straight to the commit phase with only the approved plan path — no `newAdr`, no `metadataUpdate`. The writing agent's input already makes both optional, so this is a supported shape, not a special case.
- Say so at gate 1, so the user knows what they are approving: with no promotions, approving the dispositions *is* the last decision in the run.
- The reverse also holds — a promotion whose sessions all turned out live yields a draft with an empty archive plan. Both halves are independently optional; a run that produces neither is a no-op and should say so rather than spawning a commit phase with nothing to do.

**The archive plan is produced before gate 1, and never regenerated.** The `collect` phase emits a serialized plan alongside the dispositions, computed from the same assignments the user is about to see; the archiver refuses `--apply` without a plan and refuses to recompute one from raw assignments, so a plan built after approval would be an object nobody reviewed. Both gates carry that one path through unchanged, and the writing agent executes exactly it. Staleness introduced by the delay is not the skill's problem to solve — the archiver re-stats every source immediately before moving it and skips anything that went live in the meantime.

Spawn the orchestrator via `subagent_type`, never as a fork — it has to be able to spawn its own children, and it must not inherit this conversation. Pass it `$SKILL_DIR`, taken from the skill's load-time "Base directory for this skill" banner, so the children resolve absolute script paths instead of guessing repo-relative ones.

### The three modes

- **`triage`** — the primary entry point. Process the inbox: scan unarchived logs and the watched bucket, cluster **by decision rather than by session**, and assign every candidate `promote`, `watch`, or `skip` with a reason. Scanning and judging are strictly read-only. Archiving happens only after the first gate. Say what "done" means, because the obvious answer is wrong: a run succeeds when every stale session was dispositioned and every retained one is named, **not** when the inbox is empty. Sessions written in the last ten minutes are deliberately left behind, and the archiver refuses more of them at apply time if any went live during the gate — so report those explicitly rather than treating a non-empty inbox as a failed run.
- **`promote <candidate-or-topic>`** — the escape hatch when the target is already known. Reconstruct the decision across relevant sessions, including archived ones. Ask only for material information the logs cannot establish. Present the complete draft and the proposed path before writing anything.
- **`supersede <adr-id>`** — draft a replacement for an accepted record. Create the replacement first, then update the old record's successor link. Never rewrite the old decision's context or consequences; only its lifecycle metadata changes. Say plainly that this is **two writes with no transaction**: if the link update fails after the replacement landed, nothing rolls back — the new record is valid alone and the back-link is repairable by hand — but archiving is skipped, because archiving a session whose record is half-written removes the evidence needed to finish it.

Also specify, once, how per-candidate dispositions become per-session archive targets, since judgment is per candidate but archiving moves whole session files and one session routinely feeds candidates that disagree. **`watch` wins**: a session goes to the watched bucket if any candidate drawn from it is `watch`, otherwise to `done`. A session wrongly sent to `done` is gone from triage forever; one wrongly sent to `watch` costs a single extra look. A session that fed no candidate still gets an assignment, targeting `done`.

### The promotion threshold, in full

Require **at least one** of:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

**Plus at least one** of:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

State why a flat "any two of five" was rejected: almost any non-trivial decision hits "affects multiple modules" and "someone may undo it", so the flat form would promote nearly everything — contradicting the skill's own non-goal of not treating every implementation choice as architecture.

Reject promotion when the material is a local implementation detail, a temporary workaround, a mechanical convention, or a caveat that belongs in code or operational documentation.

### The wake condition for the watched bucket

Without this rule the watched bucket is just `skip` with a nicer name, so it has to be stated explicitly: during a triage run, when a fresh candidate cluster matches something already sitting in the watched bucket, pull those entries back in and re-judge the combined evidence. Watched items never re-queue on their own.

### Constraints section

These rules are invisible from the code and silent when broken. Carry all six:

- **Read the log directory, never the registry**, for the session list. The registry reaps entries past 14 days on every write — measured 63 log files against 27 registry entries in this repository — and the lost tail is the only part that shows whether a decision held up.
- **Never archive a live session.** Cockpit resolves the log path on every write, so moving an active log makes the very next write recreate it at the original path and split one session across two files, silently. The archiver enforces a 10-minute mtime guard. Do not work around it.
- **Archive, never delete.** Reconstruction reaches back into the archive, and a wrong record has to be correctable.
- **Status comes from the decision's implementation state**, never from the skill's confidence. A promoted record is `Accepted` because the code already works that way.
- **Evidence embeds a stable summary** plus session id, entry id, and date. It never cites a `.cockpit` path — those logs can be deleted by hand and never enter git, so a path reference is guaranteed to rot.
- **Exclude secrets, credentials, personal data, and raw transcript text** from evidence.

### Edge cases to specify

- **No trail at all** — the collector reports it; say plainly that there is nothing to triage and stop. Do not create the directory.
- **A candidate matches an existing record** — disposition it `skip` and name the record it belongs to, rather than drafting a near-duplicate.
- **Conflicting evidence** — surface the conflict for Q's judgment at the first gate. Never silently take the newest entry as the winner.

### The `CLAUDE.md` edits

Three places, all of them concrete:

1. **The plugin table**, currently line 14 — the chronicle row lists `` `commit`, `pr`, `release`, `install` ``. Add `adr`.
2. **The chronicle paragraph under "Plugin summaries"**, currently line 25 — it opens "all four skills use one topology". Update the count and add one clause for what the adr skill does.
3. **The architecture tree's `packages/chronicle/` block**, currently lines 82–86 — add `shared/scripts/`, `skills/adr/`, and the five new agent names, and extend the `skills/{commit,pr,release,install}/` brace list.

**A pre-existing defect you will run into.** That same architecture tree comments the agents directory as `manager+analyst+writer / editor+drafter+publisher / releaser+surveyor+bumper+chronicler+finisher`. None of those names exist. The live roster is `lawspeaker+watcher+runesmith` (commit), `storykeeper+skald+messenger` (PR), and `oathkeeper+seer+smith+annalist+hammerbearer` (release). Since this task edits that exact comment to add the new roles, correct it in the same edit rather than propagating a wrong list.

## Acceptance criteria

- [x] `packages/chronicle/skills/adr/SKILL.md` exists with `name`, `description`, `when_to_use`, and `argument-hint` frontmatter, matching the shape of the sibling chronicle skill files.
- [x] It documents all three modes — triage, promote, supersede — each with its own section, including the no-promotion branch: skip the draft phase and the second gate, and go straight to commit with only the approved plan.
- [x] The topology block places both confirmation gates in the main agent, not in the orchestrator.
- [x] Both gates specify `cockpit wait`; `AskUserQuestion` is not used as the gating mechanism.
- [x] The promotion threshold appears in full, with its one-mandatory-plus-one-more structure and the reason a flat "any two of five" was rejected.
- [x] The wake condition for the watched bucket is specified, including that watched items never re-queue on their own.
- [x] The constraints section carries all six rules: read-the-directory, never-archive-live, archive-never-delete, status-from-implementation-state, evidence-never-cites-a-path, and the exclusion list.
- [x] `CLAUDE.md` names the adr skill in the plugin table, the chronicle summary paragraph, and the architecture tree, and its chronicle agent comment lists the live roster instead of the stale names.

## Verification

- [x] `grep -c 'cockpit wait' packages/chronicle/skills/adr/SKILL.md` returns at least 2 — one per gate.
- [x] `grep -n 'AskUserQuestion' packages/chronicle/skills/adr/SKILL.md` returns nothing, or only a line explaining why it is not used for the gates.
- [x] `grep -nE 'releaser|surveyor|bumper|chronicler' CLAUDE.md` returns nothing — the stale agent comment is gone.
- [x] `grep -n 'adr' CLAUDE.md` shows the skill named in all three places: the plugin table row, the chronicle summary paragraph, and the architecture tree block.
- [x] `wc -l packages/chronicle/skills/adr/SKILL.md` reports between 150 and 200 lines.
- [x] Run `git status --short -- packages/chronicle/skills/adr/SKILL.md CLAUDE.md` and confirm both paths are dirty.
- [x] `grep -nE 'collect|draft|commit' packages/chronicle/skills/adr/SKILL.md` shows all three modes named in the skill's own description frontmatter.

**Do not verify by starting a session and checking that `/chronicle:adr` resolves.** A session loads chronicle's skills from the version-pinned plugin cache, populated from a git clone tracking `main`. An uncommitted skill in this working tree does not resolve in any session, fresh or not, and committing and releasing are both outside this tree's scope. The greps above are the real gate; live resolution is confirmed once, after release.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Either gate is placed inside the orchestrator, or a gate uses `AskUserQuestion` instead of `cockpit wait`, or a mode is missing | All three modes present and the gates are in the main agent, but the promotion threshold is paraphrased loosely or the wake condition is omitted | All three modes, both gates in the main agent using `cockpit wait`, the threshold reproduced with its one-plus-one structure, and the wake condition stated |
| Test coverage | ×2 | Only the happy path is described — no behaviour stated for a repository with no trail | The no-trail case is covered but a candidate matching an existing record, or conflicting evidence, is left unspecified | All three edge cases specified: no trail, a candidate matching an existing record, and conflicting evidence surfaced rather than auto-resolved |
| Interface & readability | ×1 | The file restates the agent definitions' input contracts and per-role procedures, ballooning past 200 lines | Routing is clear but padded with detail that already lives in the agent files | Stays a router: the topology, the modes, the threshold, and the constraints — nothing an agent file already owns |
| Assumptions & docs | ×1 | The six constraints are listed with no reason attached, so a later reader can safely "simplify" one away | Constraints are stated but the measured evidence behind them is dropped | Each constraint carries why it exists, including the log-file-versus-registry counts and the split-session failure mode |

## Out of scope

- Making the pull-request flow cite accepted records — Deferred. Reason: it needs a real record to cite, and none exists until this skill has been run for the first time.
- Marketplace and plugin-registry documentation — Deferred, for the same reason.
- Bumping the chronicle version or writing a changelog entry — Deferred. Reason: releasing is a separate human-invoked flow, and nothing in this plan may commit.
- Writing the agent definitions or the scripts the skill routes to — Deferred. Reason: they already exist by the time this runs; this file only wires them together.
