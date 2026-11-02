# SKILL-01: The deckplan authoring reference

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/03
> **Blocks**: skill/02
> **Status**: done

## Goal

A `dispatch:deckplan` skill that tells Claude how to write a Workflow script whose run can be watched on the dashboard — and nothing more.

## Files to create / modify

- `packages/dispatch/skills/deckplan/SKILL.md` (new) — frontmatter, the router, and the short-form rules
- `packages/dispatch/skills/deckplan/references/authoring.md` (new) — the long-form authoring guidance and the conformance checklist
- `packages/dispatch/.claude-plugin/plugin.json` (modify) — descriptive copy only; see "Manifest registration" below
- `packages/dispatch/.codex-plugin/plugin.json` (modify) — descriptive copy only; see "Manifest registration" below

All paths are from the repo root `/Users/funnyq/Projects/q-lab/cc-plugins`.

## Implementation notes

### What this skill is, and is not

It is a **reference skill**. A reader opens it, follows it, and writes a Workflow script by hand. It runs no interview, scaffolds nothing, generates nothing, and ships no `scripts/` directory.

State that in the skill's own opening lines. Every other skill in this plugin either interviews the user or generates artifacts, so an implementer reading the neighbours for house style will drift toward matching their behaviour. The frontmatter and the first paragraph both have to say plainly that this one only explains.

### The division with the specification document

The normative specification lives at `packages/dispatch/skills/autopilot/references/graph-contract.md`. It owns:

- the on-disk layout and the directory naming rule
- the graph file's shape, its field defaults, and its validation rules
- the three event-entry TypeScript types
- the node state resolution order
- the narrow node type

**This skill must not restate any of that.** It points at the specification and covers what the specification does not: how to actually write a conforming script. A skill that re-states the schema creates a second source, and the two drift the first time either is edited.

The boundary is narrower than it sounds, so make it explicit for the implementer:

- **Forbidden**: reproducing the JSON shape, the TypeScript entry types, the validation list, the field defaults, or the numbered resolution order.
- **Required**: reproducing the shell command shapes verbatim. Those are usage, not schema, and an author who has to cross-reference a second document mid-prompt will get a flag wrong.

### Manifest registration — the answer, so nobody has to guess

Neither manifest enumerates skills individually. Both discover them from the directory:

- `packages/dispatch/.claude-plugin/plugin.json` carries **no** `skills` key. Claude Code finds a skill by the presence of `packages/dispatch/skills/<name>/SKILL.md`.
- `packages/dispatch/.codex-plugin/plugin.json` carries `"skills": "./skills/"` — a directory pointer, not a list.

So **no functional registration is needed**. A new skill directory is picked up by both harnesses on its own.

What _is_ needed is the descriptive copy, which does enumerate the skills in human-readable prose and goes stale silently:

- both files' top-level `description` field, which names each skill and what it does
- both files' `keywords` array
- the codex manifest's `interface.longDescription`, which currently opens with a sentence stating how many skills the plugin holds — that count changes
- the codex manifest's `interface.defaultPrompt` array, if a deckplan-shaped prompt belongs there

Update those. Do not add a `skills` key to either file.

### Frontmatter

Match the house shape used by the neighbouring skills in this plugin: `name`, `version`, `description`, `when_to_use`, and `argument-hint` when the skill takes an argument. Note that the trigger logic lives in `when_to_use`, not in `description` — `description` states what the skill does, `when_to_use` states when to fire and carries an explicit do-NOT-fire clause.

Start `version` at `0.1.0`.

The `when_to_use` clause must keep this skill out of two territories it would otherwise collide with:

- The existing task-tree execution skill's territory. A request to run an existing task tree is not a request to author a workflow.
- A passing mention of a workflow. "The workflow returned an error" is not a request for authoring guidance.

### The nine rules the guidance must carry

Each one is written as a rule **plus the concrete failure it prevents**. A rule whose reason is missing gets ignored the first time it is inconvenient.

1. **Declare the graph before writing the script.** Nodes and edges are fixed at authoring time. _Failure prevented_: a workflow whose shape depends on runtime data cannot be drawn at all — the layout computes each node's depth from the whole node set, which does not exist until the run ends.

2. **The script cannot touch the filesystem and cannot import.** Its entire vocabulary is the workflow globals. Every write happens inside a spawned agent, over a shell command the prompt spells out in full. _Failure prevented_: a script that tries to write the trail itself does not fail loudly — it has no such capability, and the author discovers the panel is empty only after the run.

3. **Bake absolute paths into prompts.** Interpolate the resolved path when building the prompt string; never pass a shell variable through. _Failure prevented_: the child shell expands an unset variable to the empty string and reports the path as "not set". This has already cost a real run in this repo.

4. **Open every agent with its announce command and close it with its completion.** Give both command shapes verbatim. The flags in the prompt and the values in the entry the agent writes must carry the same node ref, role, and attempt number. _Failure prevented_: the token join is computed independently on the prompt side and the trail side and then paired — a mismatch on any of the three values produces a row with no spend attached, which looks identical to an agent that used no tokens.

5. **Declare a node's completion with a state entry, never by editing a file.** _Failure prevented_: parallel agents appending lines to one trail is safe; parallel agents rewriting one JSON object races and loses writes.

6. **One node per unit of work, not per agent call.** Roles and retries are attempts against a node, not new nodes. _Failure prevented_: a node per agent call makes the graph grow during the run, so the panel re-lays-out under the reader and the depth of every downstream node shifts.

7. **Follow the label convention the fleet table parses**, and know what degrades when a label does not match it. The entry's own role field still classifies the row, so a label that fails to parse costs display quality — the ref, attempt, and lens enrichment — not correctness. _Failure prevented_: an author assuming a bad label breaks the run, or assuming it costs nothing.

8. **Print the full command to watch the run.** There is deliberately no run-listing command and no default path, so the skill's closing step is to hand the reader the exact invocation pointing the dashboard at the run directory. _Failure prevented_: a reader with a conforming run and no way to find it.

9. **Reset the trail before a re-run, never during one.** The run directory is a fixed slug per workflow, so a second run would otherwise append to the first run's trail and inherit its completion declarations — every node the previous run finished reads as done before this run has touched it. So: confirm the previous run has stopped, ask the user, then move the trail aside or delete it, and only then start. The author does this before the run begins; no agent inside the run ever touches the trail except to append. Say both halves — a guidance that only says "ask before overwriting" reads as permission to rewrite mid-run. Then write a fresh run id beside the graph file and interpolate that same value into every prompt the script builds. Clearing the trail is not enough on its own: attribution matches a transcript to a run by text in its first message, and the run directory's path is identical on every run of a fixed slug, so last run's agents would land in this run's token figures with no symptom. The run id is what separates them, and an elapsed-time window cannot — a run that fails and is re-run immediately falls inside any usable window. _Failures prevented_: a run that shows last time's results as this time's, last run's spend counted against this run's nodes, two runs interleaved into one unreadable trail, and a silently destroyed audit record.

### The conformance checklist

Close `references/authoring.md` with a checklist an author walks before their first run. Keep it short enough that they actually do — one line per item, no more than about ten items, each phrased as a yes/no an author can answer by looking at what they wrote.

### Style

This repo's reference documents are prose-first: one instruction per sentence, the condition before the instruction, the warning before the step it affects. Use one term per thing. Copy identifiers, commands, and paths exactly.

## Acceptance criteria

- [x] `packages/dispatch/skills/deckplan/SKILL.md` and `packages/dispatch/skills/deckplan/references/authoring.md` both exist.
- [x] The skill states in its frontmatter and its opening paragraph that it is reference-only — no interview, no generation, no bundled scripts.
- [x] All nine authoring rules are present, and each one names the concrete failure it prevents.
- [x] A conformance checklist closes the authoring reference, at ten items or fewer.
- [x] Frontmatter carries `name`, `version`, `description`, and a `when_to_use` that includes an explicit do-NOT-trigger clause covering both the task-tree execution skill's territory and a passing mention of a workflow.
- [x] Neither manifest gains a `skills` key; both have their `description` and `keywords` updated, and the codex manifest's `interface` prose no longer states a stale skill count.
- [x] Neither new file reproduces the graph file's JSON shape, the entry TypeScript types, the validation list, or the numbered state-resolution order — each is referenced by pointing at `packages/dispatch/skills/autopilot/references/graph-contract.md`.
- [x] Every shell command shape in the authoring reference is character-identical to the one in that specification document.

## Verification

- [x] Run `ls packages/dispatch/skills/deckplan/SKILL.md packages/dispatch/skills/deckplan/references/authoring.md` and confirm both paths print.
- [x] Run `head -20 packages/dispatch/skills/deckplan/SKILL.md` and confirm the frontmatter block parses as YAML by eye and carries `name`, `version`, `description`, and `when_to_use`.
- [x] Run `grep -nE 'ScoreEntry|NoteEntry|StateEntry|"version": 1|"lanes"|"repoRoot"' packages/dispatch/skills/deckplan/SKILL.md packages/dispatch/skills/deckplan/references/authoring.md` and confirm every hit is a prose mention or a pointer, and that no hit is a type or JSON definition.
- [x] Run `grep -c 'flightlog.ts' packages/dispatch/skills/deckplan/references/authoring.md` and confirm the command shapes are present, then diff each one by eye against `packages/dispatch/skills/autopilot/references/graph-contract.md` and confirm they match character for character.
- [x] Run `grep -n 'graph-contract.md' packages/dispatch/skills/deckplan/SKILL.md packages/dispatch/skills/deckplan/references/authoring.md` and confirm the specification is pointed at from both files.
- [x] Run `bunx --bun tsc --noEmit | grep packages/dispatch` and confirm it prints nothing. This task adds no TypeScript, so any output means a manifest edit broke something. The repo-wide typecheck is not green — 86 pre-existing errors sit elsewhere — so a zero total is not the bar.
- [x] Run `node -e 'JSON.parse(require("fs").readFileSync("packages/dispatch/.claude-plugin/plugin.json","utf8"));JSON.parse(require("fs").readFileSync("packages/dispatch/.codex-plugin/plugin.json","utf8"));console.log("ok")'` and confirm it prints `ok`, so neither manifest was left as invalid JSON.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                 | 2–3 (below bar)                                                                                                                      | 4–5 (pass)                                                                                                                                                     |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | An instruction contradicts the specification, or following the guidance produces a non-conforming workflow | The rules are right but a command shape drifts from the specification, or the schema is partly restated                              | Every instruction produces a conforming workflow, nothing contradicts the specification, and the schema is pointed at rather than copied                       |
| Backward compatibility  | ×2     | A manifest edit breaks a harness, or the trigger clause fires on the task-tree execution skill's territory | Manifests valid but their prose still states a stale skill count, or the do-NOT-trigger clause covers only one of the two collisions | Both manifests valid and their prose current, no `skills` key added, and the trigger clause keeps clear of both neighbouring territories                       |
| Test coverage           | ×2     | Rules are asserted with no reasons given                                                                   | Some rules name the failure they prevent, others only assert                                                                         | All nine rules name the concrete failure they prevent, and the conformance checklist covers each of them                                                       |
| Interface & readability | ×1     | The reader cannot tell what to do first, or the two files duplicate each other                             | Readable but the split between the router and the long-form guidance is arbitrary                                                    | One instruction per sentence, condition before instruction, and a clear reason for what lives in which of the two files                                        |
| Assumptions & docs      | ×1     | The reference-only nature is left implicit                                                                 | Stated once, in a place a skimming reader misses                                                                                     | Stated in the frontmatter and the opening paragraph, and the division with the specification document is explained where a reader would otherwise duplicate it |

## Out of scope

- The runnable example workflow and its fixture — Deferred to a later task in this bucket, which needs the loader working before it can render anything.
- Any interview or generation behaviour — Deferred permanently. This was decided during the interview: the authoring rules are the scarce thing, not another interviewer.
- Editing the specification document — Deferred. It is already written by the time this task starts, and a skill that edits its own source of truth defeats the point of having one.
- A command that lists runs under the data directory — Deferred. The skill prints the full watch command instead, which was chosen over a listing command during the interview.
