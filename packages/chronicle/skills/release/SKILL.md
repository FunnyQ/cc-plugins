---
name: release
description: >-
  Cut a release — bump version files, write the CHANGELOG entry, and (in auto
  mode) commit, merge, tag, and push.
when_to_use: >-
  When the user wants to cut/ship a release. Auto-detects whole-repo vs
  per-component monorepos, remembered in .chronicle/release.json.
  Human-invoked only — do NOT auto-fire from release planning or talk.
argument-hint: "[auto|auto push] [version|component...]"
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
  commit the bump and cut the annotated tag — **no push**. How it finishes follows
  the repo's `workflow` (`references/release-config.md`):
  - **git-flow** — commit on `develop`, merge `develop → main`, tag that merge
    commit, merge back, end on `develop`.
  - **github-flow** — commit on `main`, tag that bump commit, end on `main`. One
    long-lived branch, so there is nothing to merge.
- `/chronicle:release auto push` → **finish + push**: the above, then push the
  branch(es) and the tag.
- A version token (`0.5.0`) or component token(s) (`chronicle`, or several like
  `chronicle monitor`) may follow any mode to skip that part of the gate. Naming
  more than one component cuts a **coordinated release** — one bump commit carrying
  N scoped tags on a single commit (see the version gate).
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

Spawn via `subagent_type`, never fork: the Oathkeeper must be able to spawn its
children and does not inherit the main conversation. The five agents live at
`packages/chronicle/agents/{seer,oathkeeper,smith,annalist,hammerbearer}.md`.

## The main agent's job

### 1. Survey (spawn `chronicle:seer`)

Pass `$SKILL_DIR` (the skill's load-time "Base directory for this skill" banner —
do not hard-code a path or rely on `${CLAUDE_PLUGIN_ROOT}`). The seer returns
the facts you need: `hasConfig`, `config`, `suggested`, `workflow`, `workflowDrift`,
`branch`, and — for a per-component repo — a `components[]` list each with `current`,
`commitCount`, and `bumps`; for whole-repo a single `current` + `bumps`.

If `workflowDrift` is set, the committed config still says git-flow but its
`missingBranch` is gone — the repo moved to GitHub Flow. Say so **before the version
gate** and offer the one-time config edit (`"workflow": "github-flow"`, drop
`branches.develop`); with the user's yes, carry the corrected config into the release
as `persistConfig`. Never apply it silently, and never run `auto` against the drifted
config — the finish would look for a branch that no longer exists.

### 2. First run only — interview the shape

If `hasConfig` is false, confirm/adjust `suggested` into a final `ReleaseConfig`
(schema in `references/release-config.md`). Ask only what the defaults can't settle:
confirm **mode** (whole-repo vs per-component), the **workflow** (`git-flow` vs
`github-flow` — `suggested.workflow` is `github-flow` when the repo has no `develop`
branch), the **tag** template, which **version files** to bump (add a capture-group
`pattern` for odd locations like a Rails `config/application.rb` — `suggested` won't
include those), and the **branch** names (`main` alone for github-flow;
`develop` + `main` for git-flow). Mark this config to be persisted (the smith writes
it, and it rides into the release commit / your `/chronicle:commit`).

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
the final report.

**Verify ground truth before reporting:**

- **prepare** → read every configured version target and confirm `targetVersion`;
  confirm the changelog entry exists.
- **auto / auto push** → take `releaseCommit` from the Oathkeeper's report — the one
  commit every tag points at (git-flow: the develop→main merge SHA, also reported as
  `mergeCommit`; github-flow: the bump commit on `main`). A finished release without
  one is a failed release — stop and report it. Then for every tag require non-empty
  `git tag --list <tag>` output and `git rev-list -n1 <tag>` equal to that commit; when
  pushing, also require non-empty `git ls-remote --tags origin <tag>`.
  Relay only verified results.
- **Anything missing** → report partial progress. Never announce unverified tags or pushes.

## Protected branches

Release operates on the branches the config names — `develop` + `main` on git-flow,
`main` alone on github-flow. Defer to the user's existing branch guard; don't
re-implement branch protection. A github-flow release commits **on `main` by
design**, so Chronicle's own `check-branch.sh` exempts exactly that commit (a
`🔧 release:` subject on a `.chronicle/pr.json` github-flow base) and asks about
every other commit there as usual. A different host guard may still prompt — answer
it, don't work around it. In `auto` the hammerbearer verifies it ends on `develop`
(git-flow) or `main` (github-flow).

## Codex

Codex uses the same Seer → main-agent gates → Oathkeeper topology through one of two
role-loading paths:

1. **Named-role selector available**: spawn the registered `chronicle_seer`, run the
   first-run and version gates in the main agent, then spawn the registered
   `chronicle_oathkeeper` with the resolved payload.
2. **Generic sub-agent API only**: verify the corresponding stable files under
   `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`). Spawn
   non-fork generic agents named `chronicle_seer` and `chronicle_oathkeeper` at their
   normal points in the flow, with no inherited turns, and tell each to read and obey
   its stable TOML before handling the same payload. The Oathkeeper delegates
   sequentially to generic Smith, Annalist, and Hammerbearer children that self-load
   their TOMLs. Never paste or improvise role instructions in the spawn prompts.

If neither registered roles nor stable TOMLs are available, tell the user to run
`chronicle:install` and start a new Codex thread. Do not silently replace the role
boundaries with an inline release flow.

After Codex returns, apply the ground-truth checks above: configured version values in
prepare, each tag SHA against `releaseCommit` in auto modes, and remote tag presence
when pushing.

## Edge cases

- **No config + can't detect** (no manifests, no tags): whole-repo, `versionFiles:
  []` — changelog + tag only. Confirm the starting version in the gate.
- **Nothing changed** since the last tag (`commitCount: 0` everywhere): tell the
  user there's nothing to release and stop, unless they force an explicit version.
- **Verify fails** after the bump (a file didn't move): the smith reports it; the
  Oathkeeper stops before any finish. Never tag a half-bumped tree.
- **A repo that migrated to GitHub Flow** after its config was committed: the config
  predates `workflow`, so it still reads as git-flow and `auto` would look for a
  branch that's gone. The seer flags this as `workflowDrift`; fix it by setting
  `"workflow": "github-flow"` and dropping `branches.develop`
  (`references/release-config.md`). A missing field is never re-detected on its own,
  because guessing would change how existing repos release.
