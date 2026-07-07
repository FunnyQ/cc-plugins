---
name: release
description: Cut a release — bump version files, write the CHANGELOG entry, and
  (in auto mode) commit, merge, tag, and push. Auto-detects whole-repo vs
  per-component monorepos and remembers the choice in .chronicle/release.json.
  Triggers on "/chronicle:release", "cut a release", "ship a release", "bump the
  version", "發版", "發布新版本", "release this". Human-invoked only.
---

# Chronicle Release

Cut a release for the current repo. Chronicle stores the repo's release shape once
in a committed `.chronicle/release.json`, then every later run reads it — no
re-guessing. The **main agent** owns the two things only it can do (asking you which
version to cut, and — on first run — interviewing the release shape); a nested
**Releaser** orchestrator owns the mechanical bump → changelog → finish, keeping all
git/script output out of this conversation.

## Modes (from the invocation)

- `/chronicle:release` → **prepare**: bump version files + write the CHANGELOG
  entry + verify, then STOP. You review and commit (`/chronicle:commit`) and tag.
- `/chronicle:release auto` → **finish, local only**: everything prepare does, then
  commit the bump, merge `develop → main`, annotated tag, merge back — **no push**.
- `/chronicle:release auto push` → **finish + push**: the above, then push both
  branches and the tag.
- A version token (`0.5.0`) or component token (`chronicle`) may follow any mode to
  skip that part of the gate.

## Topology

```
main agent  (holds the "why"; the ONLY one that can prompt you)
  ├─ chronicle:surveyor   (Haiku) — runs analyze-release.ts → release facts (read-only)
  ├─ [first run only] interview the shape → assemble ReleaseConfig
  ├─ [version gate] which component? which bump? → targetVersion
  └─ chronicle:releaser   (subagent_type — nested custom agent, NOT a fork; no Bash)
       ├─ chronicle:bumper      (Haiku)  — save config (first run) + --apply + --verify
       ├─ chronicle:chronicler  (Sonnet) — git log → Keep-a-Changelog entry
       └─ chronicle:finisher    (Haiku)  — auto only: commit + merge + tag + (push)
```

Spawn via `subagent_type`, never fork (a fork cannot spawn children); design
rationale lives in `packages/chronicle/DESIGN.md`. The five agents live at
`packages/chronicle/agents/{surveyor,releaser,bumper,chronicler,finisher}.md`.

## The main agent's job

### 1. Survey (spawn `chronicle:surveyor`)

Pass `$SKILL_DIR` (the skill's load-time "Base directory for this skill" banner —
do not hard-code a path or rely on `${CLAUDE_PLUGIN_ROOT}`). The surveyor returns
the facts you need: `hasConfig`, `config`, `suggested`, `branch`, and — for a
per-component repo — a `components[]` list each with `current`, `commitCount`, and
`bumps`; for whole-repo a single `current` + `bumps`.

### 2. First run only — interview the shape

If `hasConfig` is false, confirm/adjust `suggested` into a final `ReleaseConfig`
(schema in `references/release-config.md`). Ask only what the defaults can't settle:
confirm **mode** (whole-repo vs per-component), the **tag** template, which
**version files** to bump (add a capture-group `pattern` for odd locations like a
Rails `config/application.rb` — `suggested` won't include those), and the
`develop`/`main` **branch** names. Mark this config to be persisted (the bumper
writes it, and it rides into the release commit / your `/chronicle:commit`).

If `hasConfig` is true, use `config` as-is and skip this step.

### 3. Version gate (always)

- **per-component**: if a component token was given, use it; else if exactly one
  component has `commitCount > 0`, default to it; else ask which component to
  release. Then ask the bump (`patch` / `minor` / `major` / explicit) using that
  component's `bumps`.
- **whole-repo**: ask the bump using the top-level `bumps`. If `current` is null
  (first release, no prior tag), ask for an explicit starting version (offer
  `0.1.0`).

Resolve `targetVersion` and (per-component) the `component`.

> In an active **cockpit** session, hand the stick back with `needs_your_call` +
> `cockpit wait` for these gates instead of `AskUserQuestion` (see
> [[cockpit-needs-your-call-for-decision-gates]]).

### 4. Spawn `chronicle:releaser`

Distill a tight `contextBrief` (the "why" of this release, from the conversation —
the Releaser can't see the chat), then spawn it with: `$SKILL_DIR`, `mode`,
`config`, `persistConfig`, `component?`, `targetVersion`, `contextBrief`, and
`branch`. The Releaser derives the tag name, changelog header, and path scope from
`config` itself. It returns the final report; relay it to the user — the touched
files + next steps (prepare), or the tag + push status (auto). Nothing else.

## Protected branches

Release operates on `develop`/`main`. Defer to the user's existing git-flow guard;
don't re-implement branch protection. In `auto` the finisher verifies it ends on
`develop`.

## Codex

Codex has no named-agent registry. There the main agent runs the same flow inline:
survey → (first-run interview) → version gate → bump + changelog → (auto) finish,
honoring the same `.chronicle/release.json` contract and prepare-by-default.

## Edge cases

- **No config + can't detect** (no manifests, no tags): whole-repo, `versionFiles:
  []` — changelog + tag only. Confirm the starting version in the gate.
- **Nothing changed** since the last tag (`commitCount: 0` everywhere): tell the
  user there's nothing to release and stop, unless they force an explicit version.
- **Verify fails** after the bump (a file didn't move): the bumper reports it; the
  Releaser stops before any finish. Never tag a half-bumped tree.
