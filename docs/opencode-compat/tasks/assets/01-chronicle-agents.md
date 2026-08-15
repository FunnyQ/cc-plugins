# ASSETS-01: Chronicle agents in OpenCode format

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: runtime/02, skills/04
> **Status**: done

## Goal

Chronicle's 13 agent roles exist as OpenCode subagent definitions under `opencode/agents/`, so an OpenCode session can spawn them through the task tool.

## Files to create / modify

- `opencode/agents/lawspeaker.md` (new) — commit orchestrator, spawns children
- `opencode/agents/watcher.md` (new) — reads the diff, proposes commit groups
- `opencode/agents/runesmith.md` (new) — runs `commit.ts apply`
- `opencode/agents/storykeeper.md` (new) — PR/MR orchestrator, spawns children
- `opencode/agents/skald.md` (new) — drafts PR/MR title and body
- `opencode/agents/messenger.md` (new) — opens the PR/MR
- `opencode/agents/lorekeeper.md` (new) — ADR orchestrator, spawns children
- `opencode/agents/gleaner.md` (new) — runs the ADR trail collector
- `opencode/agents/reckoner.md` (new) — clusters and dispositions ADR candidates
- `opencode/agents/codifier.md` (new) — drafts ADR record text
- `opencode/agents/barrowkeeper.md` (new) — writes and archives ADR records
- `opencode/agents/skirnir.md` (new) — runs the release scripts
- `opencode/agents/annalist.md` (new) — writes the CHANGELOG entry

**Nothing else.** In particular `packages/chronicle/agents/*.md` are the live Claude Code definitions and must end this task byte-identical. Read them; never edit them.

## Implementation notes

Each new file is a conversion of the same-named file in `packages/chronicle/agents/`. Work from the frontmatter table in `../_context/repo-state.md` and verify each row against its source file before converting — the table is a summary, the source is the truth.

### Frontmatter mapping

Claude source shape:

```yaml
---
name: lawspeaker
description: "Chronicle's Lawspeaker. Owns the commit flow — …"
model: sonnet
effort: medium
tools: ["Agent", "Read", "Write"]
maxTurns: 15
---
```

OpenCode target shape:

```yaml
---
description: "Chronicle's Lawspeaker. Owns the commit flow — …"
mode: subagent
hidden: true
steps: 15
permission:
  task: allow
  read: allow
  edit: allow
---
```

Field by field:

| Source field | Target | Rule |
|---|---|---|
| `name` | *(dropped)* | OpenCode derives the agent name from the filename. Keep the filename identical to the source `name`. |
| `description` | `description` | **Verbatim.** Do not reword, retitle, or shorten. It is what a caller matches on. |
| `model` | *(omitted)* | Agents inherit the session model. Do not translate `sonnet`/`haiku` into a provider-prefixed id. |
| `effort` | *(omitted)* | No OpenCode equivalent; do not invent one. |
| `maxTurns: 15` | `steps: 15` | Only on `lawspeaker`, `lorekeeper`, `storykeeper` — the three that carry it. The other ten get no `steps` key at all. |
| `tools: [...]` | `permission:` map | See below. |
| — | `mode: subagent` | On all 13. |
| — | `hidden: true` | On all 13. |

### The tools → permission map

| Source tool | Permission key |
|---|---|
| `Bash` | `bash: allow` |
| `Read` | `read: allow` |
| `Edit` **or** `Write` | `edit: allow` |
| `Agent` | `task: allow` |

`Edit` and `Write` both map to the single `edit` key — an agent carrying both still gets one `edit: allow` line, not two.

Emit only the keys the source tools imply. An agent whose `tools` is `["Bash", "Read"]` gets `bash: allow` and `read: allow` and nothing else; do not add `deny` entries for the rest.

**`task: allow` is load-bearing on exactly three agents** — `lawspeaker`, `lorekeeper`, `storykeeper`. Their whole job is spawning children. Without it they cannot spawn at all, and the symptom is an orchestrator that quietly stops rather than an error naming the permission. These are the same three that carry `steps: 15`.

### Body conversion

Copy the body verbatim, then make only these adjustments:

1. **"Agent tool" → "task tool"**, and "After each `Agent()` call" → "After each task-tool call".
2. **Spawn blocks.** The Claude bodies contain literal spawn snippets, for example:

   ```
   Agent({
     subagent_type: "chronicle:watcher",
     prompt: "$SKILL_DIR=<...>. $PROPOSAL_PATH=<...>. mode=<auto|simple>. Follow your agent instructions fully."
   })
   ```

   Restate these as a task-tool spawn. **Drop the `chronicle:` prefix** — OpenCode resolves an agent by its bare filename, so the target is `subagent_type: "watcher"`, not `"chronicle:watcher"`. Keep the prompt text itself unchanged; it carries the child's real inputs.

3. **Claude-only spawn parameters.** Lines such as "Never pass a child a `name`" describe a Claude Agent-tool parameter. Keep the underlying intent (these are nested subagents, not a named team) but do not instruct the executor to pass a parameter OpenCode may not have. Flag any such line in the report.

4. **Leave `$SKILL_DIR` handling alone.** Agent bodies receive `$SKILL_DIR` from the caller's spawn prompt and resolve scripts under it. That indirection already works on any harness; do not rewrite it to a hard-coded install path.

5. **Leave capability statements alone.** A line like "You have no Bash" stays true — it now describes the absence of `bash: allow` in the permission map.

Every file whose body needed any adjustment beyond a pure copy goes in the executor's report by name, so a human can review that diff specifically.

### Runtime facts this depends on

Both live in `../_context/runtime-facts.md`. If either is still `UNRESOLVED` when this task starts, set `> **Status**: blocked` and stop — do not guess.

- **S9 (task-subagent context inheritance).** The orchestrator bodies contain async hand-off semantics — "Result payload: validate and continue / Launch receipt: end the turn without prose; resume from the completion notification". That protocol assumes Claude's Agent-tool return shape. Reflect what S9 actually observed rather than copying the Claude wording unchanged, and say plainly in the body which shape the executor should expect.
- **S14 (`subagent_depth`).** The orchestrators cannot spawn children when `subagent_depth` is below 2 in `~/.config/opencode/opencode.json`. This is the OpenCode equivalent of Claude's spawn-depth env var, and it fails silently. Add one line to each of the three orchestrator bodies naming that setting, so whoever debugs a silent stop looks at the config instead of at the agent.

## Acceptance criteria

- [x] Exactly 13 files exist under `opencode/agents/`, named for the 13 chronicle agents.
- [x] Every file's YAML frontmatter parses.
- [x] No file contains a `model` field or an `effort` field.
- [x] Every file carries `mode: subagent` and `hidden: true`.
- [x] `steps: 15` appears on exactly three files: `lawspeaker.md`, `lorekeeper.md`, `storykeeper.md`.
- [x] `task: allow` appears on exactly those same three files, and on no other.
- [x] Each file's `permission` map matches its source `tools` array under the mapping table above, with `Edit`/`Write` collapsed to one `edit` key.
- [x] Each `description` is byte-identical to its source.
- [x] All 13 names a chronicle skill spawns are present: `lawspeaker`, `watcher`, `runesmith`, `storykeeper`, `skald`, `messenger`, `lorekeeper`, `gleaner`, `reckoner`, `codifier`, `barrowkeeper`, `skirnir`, `annalist`.
- [x] No body contains `subagent_type: "chronicle:<name>"` — the prefix is dropped.
- [x] `git diff --quiet -- packages/chronicle/agents/` exits 0, proving the Claude definitions are unchanged.

## Verification

- [x] Parse the frontmatter of all 13 files and print `name → keys present`; confirm no `model`/`effort` anywhere and `steps`/`task` on exactly the three orchestrators.
- [x] Diff each new body against its source and read the differences; confirm every one is a listed adjustment and nothing else drifted.
- [x] `grep -rn 'chronicle:' opencode/agents/` returns no `subagent_type` hit.
- [x] Run `git diff --quiet -- packages/chronicle/agents/ && echo UNCHANGED` and confirm it prints `UNCHANGED`.
- [x] Run `git status --short -- opencode/agents docs/opencode-compat/tasks/assets/01-chronicle-agents.md` and confirm both paths are dirty. Other paths in the working tree belong to work running alongside this task; make no claim about them.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong file count, a source file edited, or a description reworded | All 13 exist but a `steps`/`model`/`effort` rule is misapplied, or a body drifted beyond the listed adjustments | 13 files, every frontmatter rule applied exactly, bodies changed only where the adjustment list allows, sources byte-identical |
| Permission-map accuracy | ×2 | An orchestrator is missing `task: allow`, or a leaf agent was granted it | Keys present but `Edit`+`Write` duplicated, or an unrequested key added | Every map derives exactly from its source `tools`, orchestrators carry `task: allow` and nothing else does |
| Uniform structure | ×1 | Files differ in key order and shape with no pattern | Mostly consistent, one or two outliers | All 13 share one frontmatter key order and one body layout, so a reviewer can diff them side by side |
| Assumptions & docs | ×1 | An unresolved runtime fact was guessed at and written in as settled | Adjusted bodies not reported, so the human review has nothing to target | Every adjusted body named in the report, spawn-depth note present on the three orchestrators, unresolved facts either resolved or the task blocked |

## Out of scope

- Installing the agents into `~/.config/opencode/agents/` — the installer owns every symlink and is specified separately. Deferred. Reason: this task produces committed source files only.
- Provider-prefixed model mapping — deliberately deferred; v1 agents inherit the session model, so no `model` field is written at all.
- Editing the chronicle `SKILL.md` files to name these agents as task-tool spawn targets — that is documentation work with its own scope. Deferred.
