# TRIAGE-05: Ship the Codex half of the ADR roles

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: triage/03, triage/04
> **Blocks**: promote/02
> **Status**: done

## Goal

The same five ADR roles are installable on Codex, so the skill does not become the first part of chronicle that only works on one harness.

## Files to create / modify

- `packages/chronicle/agents-codex/lorekeeper.toml` (new) — Codex definition of the ADR orchestrator
- `packages/chronicle/agents-codex/gleaner.toml` (new) — Codex definition of the read-only collector
- `packages/chronicle/agents-codex/reckoner.toml` (new) — Codex definition of the clustering judge
- `packages/chronicle/agents-codex/codifier.toml` (new) — Codex definition of the ADR drafter
- `packages/chronicle/agents-codex/barrowkeeper.toml` (new) — Codex definition of the sole writer
- `packages/chronicle/skills/install/scripts/setup-codex-agents.ts` (modify) — add the five roles to the registry array and the descriptions map
- `packages/chronicle/skills/install/scripts/setup-codex-agents.test.ts` (modify) — assert the new roles install
- `packages/chronicle/skills/install/SKILL.md` (modify) — name the new roles in the list it already carries

## Implementation notes

Every chronicle agent ships twice: a Markdown definition for Claude Code under `packages/chronicle/agents/`, and a TOML definition for Codex under `packages/chronicle/agents-codex/`. The Claude half of these five roles already exists on disk by the time this task runs. This task writes the Codex half and registers it.

### The registry is a hardcoded array, not a directory scan

`packages/chronicle/skills/install/scripts/setup-codex-agents.ts` holds a literal `ROLES` array and a `descriptions` object beside it. Dropping `.toml` files into the directory changes nothing on its own — an unlisted role is simply never copied and never written into `$CODEX_HOME/config.toml`.

Three things must move together:

1. The `ROLES` array — append the five new role names.
2. The `descriptions` map — one entry per new role, keyed by the same bare name.
3. The five `.toml` source files themselves.

The script validates the third against the first before it writes anything: it loops over `ROLES`, checks `existsSync` on `<pluginRoot>/agents-codex/<role>.toml`, and calls `process.exit(1)` with `setup-codex-agents: missing <path>` on the first absent file. That guard must keep working — a listed role with no source file is still a hard error, not a silent skip.

### TOML shape

Each role file is three top-level keys and nothing else:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
developer_instructions = """
<the agent's instructions, as one prose block>
"""
```

### Model tiers

Mirror the tier chosen in each role's Claude definition. Read `packages/chronicle/agents/<role>.md` for the `model:` frontmatter value, then map it:

- The two haiku roles — `gleaner` and `barrowkeeper` — take the cheaper model with `model_reasoning_effort = "low"`, matching how the existing cheap roles such as `watcher` and `messenger` are configured.
- The three sonnet roles — `lorekeeper`, `reckoner`, and `codifier` — take the stronger model, matching how `storykeeper`, `skald`, and `oathkeeper` are configured.

Read the exact model strings out of the existing files in `packages/chronicle/agents-codex/` rather than inventing them. Quoting the current values in this task file would go stale the next time the tiers are re-pinned.

### Descriptions to add

One line each, matching the terse imperative style of the entries already in the map:

- `lorekeeper` — `"Orchestrate Chronicle ADR triage, promotion, and supersession."`
- `gleaner` — `"Collect cockpit decision-trail skeletons without writing."`
- `reckoner` — `"Cluster trail entries and assign ADR dispositions."`
- `codifier` — `"Draft an Architecture Decision Record from confirmed evidence."`
- `barrowkeeper` — `"Write the confirmed ADR and archive its source sessions."`

### Compress the instructions, keep the refusals

The Codex instruction blocks are compressed rewrites, not copies. Where a Claude agent definition runs to a hundred lines of headed sections and worked examples, the existing Codex blocks are two or three dense paragraphs. Carry the inputs, the output shape, and the refusals. Drop the examples and the prose scaffolding.

**Refusals compress but never drop.** Prose gets shorter; the list of things a role will not do stays the same length. Aim for field-for-field parity with the Claude definitions — every refusal in a `.md` file appears in its `.toml` counterpart, in fewer words. The enumeration, so nothing is quietly lost:

| Role | Refusals that must appear |
|---|---|
| `lorekeeper` | Holds no confirmation gate — it orchestrates and returns; the human gates live one layer up in the skill file, and an orchestrator that stops to ask will hang. Runs one phase per invocation. A phase arriving without its carry-over stops and reports rather than re-running the previous phase. |
| `gleaner` | Runs the trail collector and nothing else — no redirection, no `mv`, no `mkdir`, no `--apply`. Never opens entry bodies. Returns `hasTrail: false` and stops when there is no trail, rather than erroring. |
| `reckoner` | Runs the body fetch and the archiver in planning mode only — **never** `--apply`. Nothing else. Surfaces conflicting evidence rather than resolving it by taking the newest entry. |
| `codifier` | Runs no mutating command at all. Returns draft text; does not save it. Never invokes the archiver. Sets status from implementation state, not from its own confidence. Evidence never cites a `.cockpit` path, and excludes secrets, credentials, personal data, and raw transcript text. |
| `barrowkeeper` | Never deletes. Refuses a new-record target path that already exists rather than overwriting. Requires an existing target for a lifecycle-metadata update and touches only lifecycle fields. Takes an approved plan path, never raw assignments. On partial failure: does not roll back, and skips archiving. |

A role whose `.toml` carries the happy path but drops a refusal will pass this task's own checks and then fail the closing review, which requires the two harnesses to agree field for field. Catch it here.

Where a role's block needs to reference a sibling, follow the pattern the existing orchestrators use: name the registered role (`chronicle_gleaner`), and for a generic sub-agent runtime, tell the child to read and obey the `developer_instructions` in `$CODEX_HOME/agents/chronicle/<role>.toml`, resolving `CODEX_HOME` from the environment with a `~/.codex` default.

### Count check

The registry currently carries eleven roles. It ends this task carrying sixteen.

### Codex does not hot-reload roles

Applying the config does not affect a thread that is already running. The setup script writes `$CODEX_HOME/config.toml` and copies the files into `$CODEX_HOME/agents/chronicle/`, but the role registry is read when a thread starts. Any report of this change landing must tell the user to start a new Codex thread.

## Acceptance criteria

- [x] All five new `.toml` files exist under `packages/chronicle/agents-codex/`, each with a `model` key, a `model_reasoning_effort` key, and a `developer_instructions` block.
- [x] The `ROLES` array in `setup-codex-agents.ts` lists sixteen roles — the original eleven plus the five new ones.
- [x] Every new role has a matching entry in the `descriptions` map, so the generated config block carries a description line for each.
- [x] `setup-codex-agents.test.ts` asserts, for each of the five new roles, both that it appears as an `[agents.chronicle_<role>]` section in the written config and that its `.toml` was copied into the target agents directory.
- [x] The Codex role list in `packages/chronicle/skills/install/SKILL.md` names all five new roles.
- [x] Each new `.toml`'s model tier matches the `model:` frontmatter of the same role's Claude definition under `packages/chronicle/agents/`.
- [x] Every refusal listed in the parity table above appears in the matching `.toml` — checked role by role, not just for the writing role. Read each `.md` and its `.toml` side by side and confirm nothing on the refusal side was lost to compression.
- [x] The setup script still exits non-zero with a `missing` message when a role listed in `ROLES` has no source `.toml`.

## Verification

- [x] `bun test packages/chronicle/skills/install/scripts/setup-codex-agents.test.ts` passes with zero failures.
- [x] `CODEX_HOME=$(mktemp -d) bun packages/chronicle/skills/install/scripts/setup-codex-agents.ts --plugin-root packages/chronicle --dry-run | grep -c '^\[agents\.chronicle_'` prints `16`.
- [x] `CODEX_HOME=$(mktemp -d) bun packages/chronicle/skills/install/scripts/setup-codex-agents.ts --plugin-root packages/chronicle --dry-run | grep -E 'chronicle_(lorekeeper|gleaner|reckoner|codifier|barrowkeeper)'` prints all five role sections.
- [x] `grep -c 'developer_instructions' packages/chronicle/agents-codex/lorekeeper.toml packages/chronicle/agents-codex/gleaner.toml packages/chronicle/agents-codex/reckoner.toml packages/chronicle/agents-codex/codifier.toml packages/chronicle/agents-codex/barrowkeeper.toml` prints `1` for each file.
- [x] `bun test packages/chronicle/` reports zero failures.
- [x] `git status --short -- packages/chronicle/agents-codex packages/chronicle/skills/install` shows the five new files and the three modified ones as dirty.
- [x] Do not run `bunx tsc --noEmit`; it floods with pre-existing unrelated errors in this repository.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Fewer than five role files written, or the setup script no longer runs | The `.toml` files exist but the registry array or the descriptions map was not updated, so nothing installs; or a model tier contradicts the role's Claude definition | Sixteen roles install cleanly from a temporary Codex home, every tier mirrors its Claude counterpart, and the missing-source-file guard still exits non-zero |
| Test coverage | ×2 | No new assertions added to the install test | The new roles are asserted in the config block only, or only as copied files — one half of the pair | Both halves asserted for all five roles, matching how the existing eleven are covered, plus the idempotency case still passing |
| Interface & readability | ×1 | Instructions copied verbatim from the Claude definitions, or left as placeholders | Compressed but a stated refusal was lost — the never-delete rule, the refuse-on-existing-target rule, or the no-gate rule | Two or three dense paragraphs per role in the house style, with every refusal and the output shape intact |
| Assumptions & docs | ×1 | Model strings invented rather than read from the existing role files | Tiers chosen without stating why, or the new-thread requirement omitted from the install skill's guidance | Tier choices traceable to the Claude definitions, and the "start a new Codex thread" requirement stated where a reader will hit it |

## Out of scope

- Changing the eleven existing roles, their instructions, or their model tiers — Deferred. Reason: this task only adds; touching the shipped roles would put an unrelated regression inside an additive change.
- Running the installer against the developer's real Codex home — Deferred. Reason: every verification step uses a throwaway `CODEX_HOME` so nothing on the machine is modified; applying for real is the user's call, after approval.
- The skill's routing instructions, mode definitions, and confirmation gates — Deferred. Reason: the skill file is written later in the promote bucket, and it is the layer that owns the gates these agents deliberately do not hold.
- Converting the role registry from a hardcoded array to a directory scan — Deferred. Reason: the explicit list is what makes a missing source file a hard error instead of a silent omission.
