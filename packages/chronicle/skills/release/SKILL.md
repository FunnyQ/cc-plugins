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
**Oathkeeper** orchestrator owns the mechanical bump → changelog → finish, keeping all
git/script output out of this conversation.

## Modes (from the invocation)

- `/chronicle:release` → **prepare**: bump version files + write the CHANGELOG
  entry + verify, then STOP. You review and commit (`/chronicle:commit`) and tag.
- `/chronicle:release auto` → **finish, local only**: everything prepare does, then
  commit the bump, merge `develop → main`, annotated tag, merge back — **no push**.
- `/chronicle:release auto push` → **finish + push**: the above, then push both
  branches and the tag.
- A version token (`0.5.0`) or component token(s) (`chronicle`, or several like
  `chronicle monitor`) may follow any mode to skip that part of the gate. Naming
  more than one component cuts a **coordinated release** — one commit + one
  develop→main merge carrying N scoped tags (see the version gate).
- A bare version token disambiguates **only a single-unit release** (one component,
  or whole-repo). When two or more components are named there is no single target,
  so a trailing version token is ambiguous — ignore it and ask each component's bump
  at the gate (a per-component `chronicle@0.5.1` form is fine if the user writes it).

## Topology

```
main agent  (holds the "why"; the ONLY one that can prompt you)
  ├─ chronicle:seer   (Haiku) — runs analyze-release.ts → release facts (read-only)
  ├─ [first run only] interview the shape → assemble ReleaseConfig
  ├─ [version gate] which component(s)? which bump each? → releases[]
  └─ chronicle:oathkeeper   (subagent_type — nested custom agent, NOT a fork; no Bash)
       ├─ chronicle:smith      (Haiku)  — save config (first run) + --apply + --verify
       ├─ chronicle:annalist  (Sonnet) — git log → Keep-a-Changelog entry
       └─ chronicle:hammerbearer    (Haiku)  — auto only: commit + merge + tag + (push)
```

Spawn via `subagent_type`, never fork (a fork cannot spawn children); design
rationale lives in `packages/chronicle/DESIGN.md`. The five agents live at
`packages/chronicle/agents/{seer,oathkeeper,smith,annalist,hammerbearer}.md`.

## The main agent's job

### 1. Survey (spawn `chronicle:seer`)

Pass `$SKILL_DIR` (the skill's load-time "Base directory for this skill" banner —
do not hard-code a path or rely on `${CLAUDE_PLUGIN_ROOT}`). The seer returns
the facts you need: `hasConfig`, `config`, `suggested`, `branch`, and — for a
per-component repo — a `components[]` list each with `current`, `commitCount`, and
`bumps`; for whole-repo a single `current` + `bumps`.

### 2. First run only — interview the shape

If `hasConfig` is false, confirm/adjust `suggested` into a final `ReleaseConfig`
(schema in `references/release-config.md`). Ask only what the defaults can't settle:
confirm **mode** (whole-repo vs per-component), the **tag** template, which
**version files** to bump (add a capture-group `pattern` for odd locations like a
Rails `config/application.rb` — `suggested` won't include those), and the
`develop`/`main` **branch** names. Mark this config to be persisted (the smith
writes it, and it rides into the release commit / your `/chronicle:commit`).

If `hasConfig` is true, use `config` as-is and skip this step.

### 3. Version gate (always)

The gate resolves a **`releases[]`** list — one entry per unit being cut, each
`{ component, targetVersion, lastTag }` (whole-repo uses a single entry with
`component: null`). `lastTag` comes from the seer facts the main agent already
holds: per-component from `components[].lastTag`, whole-repo from top-level
`lastTag`, and it may be null on a first release. One component is just a length-1
list; two or more is a **coordinated release**.

- **per-component**: pick the component set, then a bump per component.
  - If component token(s) were given, use exactly those.
  - Else look at which components changed (`commitCount > 0`): if exactly one, default
    to it; if several, offer them all (pre-select the changed ones) and let the user
    release one, some, or all together — this is the coordinated path; if none
    changed, tell the user there's nothing to release and stop (unless they force an
    explicit component + version). If `commitCount` is null, treat the change count
    as unknown and do not infer that the component is unchanged.
  - For **each** selected component, ask its bump (`patch` / `minor` / `major` /
    explicit) using that component's own `bumps`. Resolve one
    `{ component, targetVersion, lastTag }` per selection.
- **whole-repo**: ask the bump using the top-level `bumps` → a single
  `{ component: null, targetVersion, lastTag }`. If `current` is null (first
  release, no prior tag), ask for an explicit starting version (offer `0.1.0`).

Resolve `releases[]`. Coordinated releases are per-component only — you never mix
whole-repo with per-component units.

> In an active **cockpit** session, hand the stick back with `needs_your_call` +
> `cockpit wait` for these gates instead of `AskUserQuestion` (see
> [[cockpit-needs-your-call-for-decision-gates]]).

### 4. Spawn `chronicle:oathkeeper`

Distill a tight `contextBrief` (the "why" of this release, from the conversation —
the Oathkeeper can't see the chat), then spawn it with: `$SKILL_DIR`, `mode`,
`config`, `persistConfig`, `releases[]` (each
`{ component, targetVersion, lastTag }`), `contextBrief`, and `branch`. The
Oathkeeper derives each unit's tag name, changelog header, and path scope from
`config` itself, and forwards each release's `lastTag` to the annalist. It returns
the final report; relay it to the user — the touched files + next steps (prepare),
or the tag(s) + push status (auto). Nothing else.

## Protected branches

Release operates on `develop`/`main`. Defer to the user's existing git-flow guard;
don't re-implement branch protection. In `auto` the hammerbearer verifies it ends on
`develop`.

## Codex

Chronicle does not currently define dedicated Codex roles for release. The main agent runs the flow inline:
survey → (first-run interview) → version gate → bump + changelog → (auto) finish,
honoring the same `.chronicle/release.json` contract and prepare-by-default.

## Edge cases

- **No config + can't detect** (no manifests, no tags): whole-repo, `versionFiles:
  []` — changelog + tag only. Confirm the starting version in the gate.
- **Nothing changed** since the last tag (`commitCount: 0` everywhere): tell the
  user there's nothing to release and stop, unless they force an explicit version.
- **Verify fails** after the bump (a file didn't move): the smith reports it; the
  Oathkeeper stops before any finish. Never tag a half-bumped tree.
