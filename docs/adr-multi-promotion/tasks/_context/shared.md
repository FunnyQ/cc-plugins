# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`cc-plugins` is a plugin marketplace for Claude Code and Codex. The `chronicle` plugin
lives at `packages/chronicle/`. Its `adr` skill triages the cockpit decision trail and
promotes decisions into Architecture Decision Records under `docs/adr/`.

This change makes one `triage` run promote up to 12 records instead of exactly one. Every
task edits instruction text. No task writes or changes TypeScript.

## The pipeline these files describe

The main agent owns two human gates. Between them it spawns `chronicle:lorekeeper` three
times, once per phase.

```
chronicle:adr  (the main agent; owns both gates)
  ├─ lorekeeper(collect) → gleaner, reckoner
  ├─ [GATE 1]  Q confirms the dispositions
  ├─ lorekeeper(draft)   → codifier
  ├─ [GATE 2]  Q confirms the drafts and their target paths
  └─ lorekeeper(commit)  → barrowkeeper
```

The lorekeeper spawns one child per phase, spawned once, never two at a time and never in
parallel. This change does not alter that protocol. One codifier drafts every group.

## Files in scope

Seven files. No task touches a file outside this list.

| File | Owning task family |
| --- | --- |
| `packages/chronicle/skills/adr/SKILL.md` | the two `contract` tasks, in order |
| `packages/chronicle/agents/codifier.md` | one `agents` task |
| `packages/chronicle/agents/lorekeeper.md` | one `agents` task |
| `packages/chronicle/agents/barrowkeeper.md` | one `agents` task |
| `packages/chronicle/agents-codex/codifier.toml` | one `codex` task |
| `packages/chronicle/agents-codex/lorekeeper.toml` | one `codex` task |
| `packages/chronicle/agents-codex/barrowkeeper.toml` | one `codex` task |

## Non-goals for every task

- Do not change `packages/chronicle/agents/gleaner.md` or
  `packages/chronicle/agents/reckoner.md`, or their TOML mirrors.
- Do not change any file under `packages/chronicle/skills/adr/scripts/`.
- Do not batch `supersede <adr-id>`. It still replaces one record per run.
- Do not batch `metadataUpdate`. It stays a single object.
- Do not add rollback or delete semantics. `Archive, never delete` still holds.
- Do not add renumbering. A dropped draft leaves a permanent number gap.
- Do not add a new script, a new flag, or a new entry point.

## Writing standard — STE-lite

Every edited file follows `docs/ste-rewrite/STE-RULES.md`. Inlined here so you do not have
to open it.

Rules to apply:

- **R1** One instruction per sentence. Keep a comparison ("prefer X over Y") as one
  sentence, because splitting it turns a preference into a prohibition.
- **R2** Start an instruction with the verb. Use the active voice.
- **R3** Instruction sentence: 20 words maximum. Descriptive sentence: 25 words maximum.
  Words inside code spans do not count.
- **R4** Put the condition before the action.
- **R5** Put the warning, the caveat, or the failure mode before the step it applies to.
- **R6** Break em-dash chains. Allow one short parenthetical per sentence.
- **R7** One term, one meaning. Do not rotate synonyms.
- **R8** Noun clusters: three words maximum.
- **R9** Do not use an `-ing` form where an imperative works.
- **R10** Keep the articles `a`, `an`, and `the`.
- **R11** Six sentences maximum per paragraph.
- **R12** Do not delete a sentence because it looks redundant. Rewrite it, or keep it.
- **R13** Do not exceed the original word count by more than 15%.

Hard constraints — a change here breaks the product:

1. **YAML frontmatter.** Do not edit any line between the opening `---` and the closing
   `---` of a Markdown agent file. `description` is the trigger surface.
2. **Code blocks.** Copy every fenced block verbatim unless the task tells you to change
   that exact block.
3. **Inline code.** Copy every backticked token verbatim. Never break a backticked span
   across a line wrap. A newline inside a token changes a copied command's argv.
4. **Heading structure.** Do not add, remove, merge, or re-level a heading unless the task
   says so. You may reword a heading's text.
5. **Protected vocabulary.** Never simplify these: `spawn`, `gate`, `orchestrate`,
   `distill`, `escalate`, `subagent`, `fork`, `Lorekeeper`, `Codifier`, `Barrowkeeper`,
   `Gleaner`, `Reckoner`, `cockpit`, `chronicle`.

## Codex TOML mirror conventions

Each file under `packages/chronicle/agents-codex/` is the Codex twin of a Markdown agent.
The format is fixed:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
developer_instructions = """
<one compressed prose brief, several paragraphs>
"""
```

Rules:

- Keep `model` and `model_reasoning_effort` exactly as they are. This change does not
  retune any agent.
- `developer_instructions` is one triple-quoted string. Keep that shape.
- The mirror is a compression, never a copy. It keeps every rule, every refusal, and every
  literal JSON shape, in dense prose paragraphs instead of headed sections.
- Keep the mirror's existing paragraph count and topic order where the contract allows it.
  A reader diffing the two files should see the contract change, not a reorganization.
- Every literal JSON shape in the mirror must match its Markdown source character for
  character in field names.
- The mirror is read by Codex, which has no `Artifact` tool and no Claude agent registry.
  Keep the Codex-specific spawn wording that is already there.

## Verification baseline

Commands any task can rely on:

- `bun test packages/chronicle/skills/adr/scripts/` — the ADR script suite. No task changes
  a script, so a failure means a task edited something out of scope.
- `bun test packages/chronicle/` — the whole chronicle suite. The closing review runs this.
- `grep -n "<string>" <file>` — the string checks each task declares.

There is no linter for these Markdown and TOML files, and no test asserts their content.
Grep and a careful read are the gate.

## Commit & branching style

- Branch off: `main`. This repo runs GitHub Flow.
- Do not commit. The executor of these tasks does not commit, tag, or push.
- Q commits with `/chronicle:commit` after the tree lands.

## Decisions frozen during interview

- **One codifier drafts all N.** It respects the lorekeeper's existing child protocol: one
  child per phase, spawned once, never in parallel.
- **The main agent pre-allocates ADR numbers** from `adrIndex.nextNumber`. The codifier
  never counts.
- **The batch cap is 12 groups per run.** Q ran 26 in one sitting and reports the limit was
  fatigue, not failure. 12 is a judgment call, not a measured ceiling.
- **A gate-2 `drop` forces its sessions to `watch`**, then the main agent re-runs
  `archive-plan.ts`. Without this the dropped decision archives to `done` and leaves
  triage forever.
- **`newAdr` is renamed `newAdrs`.** A stale caller gets an unknown-field refusal instead
  of a silent single write.
- **Gate 2 takes a per-draft verdict** and requires the complete set.
- **Gate 1 gains a `group` field** on disposition rows. The free-text `notes` workaround is
  removed.
- **Validation failure keeps every written record**, skips archive, and rolls nothing back.
