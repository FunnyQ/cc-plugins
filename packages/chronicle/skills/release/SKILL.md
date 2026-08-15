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

A release is a short list of stages, run by `scripts/release.ts`. Each stage knows
whether it has already happened by looking at the repo, so a run picks up wherever
the last one stopped and re-running one is a no-op rather than an error.

You own the two things a script cannot do: **asking which version to cut**, and —
on a first run — **interviewing the repo's shape**. The changelog entry needs
judgment too, so one agent writes it.

You never run the scripts yourself. **Skirnir** runs them and returns only the
distilled result, so analyzer blobs, git output, and stack traces stay out of this
conversation. Spawn it with `subagent_type: "chronicle:skirnir"`, one call at a
time, no `name`, **never a fork** — a fork inherits this whole conversation, which
is the opposite of what it is for.

## Stages

```
save-config?  bump  entry  commit  [merge]  tag  [back-merge]  push
                            ▲                                   ▲
                            └─ prepare stops here      auto push ┘
                                        auto stops at tag
```

`merge` / `back-merge` exist only on git-flow. `save-config` only on a first run.

## Modes → `--through`

- `/chronicle:release` → `--through entry`. Bump and write the entry, then stop.
  You review and commit.
- `/chronicle:release auto` → `--through tag`. Everything above, then commit and
  tag locally.
- `/chronicle:release auto push` → `--through push`.

Run after a prepare, `auto` finishes it: `bump` and `entry` already read as done,
so it commits what is there and tags that commit. It never writes a second bump or
a second entry.

A version token (`0.5.0`) or component token(s) (`chronicle`, or `chronicle monitor`)
may follow any mode to skip that part of the gate. Naming two or more components
cuts a coordinated release: one commit, N scoped tags. A bare version token only
disambiguates a single-unit release — with several components named, ignore it and
ask each bump. A per-component `chronicle@0.5.1` form is fine if the user writes it.

## Your job

### 1. Facts

Spawn Skirnir with `command: "facts"` and `$SKILL_DIR` — the skill's load-time
"Base directory for this skill" banner. Do not hard-code a path or rely on
`${CLAUDE_PLUGIN_ROOT}`.

You get back `hasConfig`, `config`, `suggested`, `workflow`, `workflowDrift`, `branch`,
and either a whole-repo `current`/`bumps`/`lastTag` or a `components[]` list with
each unit's `current`, `lastTag`, `commitCount`, and `fileVersion`.

If `workflowDrift` is set, the committed config still says git-flow but its
`missingBranch` is gone. Say so **before** the gate and offer the one-time edit
(`"workflow": "github-flow"`, drop `branches.develop`). Never apply it silently, and
never run `auto` against the drifted config.

### 2. First run only — interview the shape

If `hasConfig` is false, turn `suggested` into a final `ReleaseConfig`
(`references/release-config.md`). Ask only what the defaults cannot settle: whole-repo
vs per-component, git-flow vs github-flow, the tag template, the version files, the
branch names. Add a capture-group `pattern` for odd locations like a Rails
`config/application.rb` — `suggested` will not include those.

Tell Skirnir to pass `--persist-config` on the first `run`, which adds the
`save-config` stage.

### 3. Version gate

Resolve one `{ component, targetVersion, lastTag }` per unit being cut. Whole-repo
uses `component: null`.

- **per-component**: if component tokens were given, use those. Otherwise look at
  `commitCount > 0`. Exactly one changed → default to it. Several → offer them all,
  pre-selecting the changed ones. None changed → say there is nothing to release and
  stop, unless the user forces a component and version. `commitCount: null` means
  unknown, not unchanged.
- **whole-repo**: ask the bump from the top-level `bumps`. If `current` is null,
  ask for a starting version (offer `0.1.0`).

**When `fileVersion` already leads `lastTag`,** a previous prepare run — or a bump
merged from a feature branch — already chose the version. Offer `fileVersion` as the
target instead of asking for a bump. Confirm it; do not bump on top of it.

> In an active **cockpit** session, hand the stick back with `needs_your_call` +
> `cockpit wait` for these gates instead of `AskUserQuestion` (see
> [[cockpit-needs-your-call-for-decision-gates]]).

### 4. Plan

Spawn Skirnir with `command: "plan"` and `units`. Read `stages[]`. Exit 1 means something is **blocked** — report the `note` and stop.
A blocked stage is always a state the user must resolve (a tag already on another
commit, a `main` behind its remote); never work around it.

### 5. Entry, if pending

If the `entry` stage is pending, spawn the annalist **once**, with
`subagent_type: "chronicle:annalist"`, never a fork, no `name`:

```
Agent({
  subagent_type: "chronicle:annalist",
  prompt: "$SKILL_DIR=<...>. Write a CHANGELOG entry per release. changelogPath=<the plan's changelogPath>; entries=<[{headerLabel,tagName,pathScope,lastTag}, ...] JSON>. Read references/changelog-template.md. Prepend all entries as one contiguous newest-first block at the top. Return the entry text + the changelog path."
})
```

`changelogPath` and each entry's `headerLabel`, `tagName`, `pathScope`, and
`lastTag` all come from the plan — you never need the raw config for this. Skip this
whenever `entry` already reads done — the entry exists, and a second one for the
same version is a duplicate heading.

### 6. Run

Spawn Skirnir with `command: "run"`, `units`, and `through`. The result names `executed[]`, `skipped[]`, `releaseCommit`, `tags[]`, and `branch`.
A stage that runs without taking effect aborts the release — the engine will not
report a tag it did not cut.

### 7. Verify before reporting

- **prepare** → confirm the version files read `targetVersion` and the changelog
  holds the entry.
- **auto / auto push** → for every tag, require non-empty `git tag --list <tag>` and
  `git rev-list -n1 <tag>` equal to `releaseCommit`. When pushing, also require
  non-empty `git ls-remote --tags origin <tag>`.
- Relay only verified results. Never announce an unverified tag or push.

## Protected branches

Release operates on the branches the config names. Defer to the user's existing
branch guard; don't re-implement branch protection. A github-flow release commits
**on `main` by design** — chronicle's `check-branch.sh` exempts exactly that commit
(a `🔧 release:` subject on a `.chronicle/pr.json` github-flow base). A different
host guard may still prompt. Answer it; don't work around it.

## Codex

Same flow, same two roles. Spawn the registered `chronicle_skirnir` for each script
call and the registered `chronicle_annalist` for the entry — or — with a generic sub-agent API only —
non-fork generic agents named `chronicle_skirnir` and `chronicle_annalist`, each
told to read and obey its own TOML under `$CODEX_HOME/agents/chronicle/` (default
`$CODEX_HOME` to `~/.codex`).
Never paste or improvise the role instructions. If it is missing, tell the user to
run `chronicle:install`.

## OpenCode

Under OpenCode, release is FLAT: the main skill spawns the leaf agents Skirnir and
Annalist directly. It only spawns one level, so release itself does NOT need
`subagent_depth >= 2`.

Under OpenCode, skills are installed at `~/.config/opencode/skills/<name>/` (symlinked by `opencode/install.ts`). Resolve scripts from there: `bun ~/.config/opencode/skills/<name>/scripts/…`. `CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it.

Spawn the leaf agents with their bare OpenCode names:

```text
subagent_type: "skirnir"
subagent_type: "annalist"
```

OpenCode task-tool subagents do NOT inherit parent context. Pass the literal
OpenCode skill path and every command-specific parameter explicitly on each spawn.
The release-subject exemption in the branch guard applies under OpenCode in the
same way.

## Edge cases

- **No config + can't detect**: whole-repo, `versionFiles: []` — changelog + tag
  only. Confirm the starting version in the gate. `bump` reads done because there is
  nothing to bump, and `commit` then rests on the entry alone.
- **Nothing changed** since the last tag: say so and stop, unless the user forces a
  version.
- **`bump` done but `entry` pending** on a tree you did not just bump: the version
  files moved without an entry behind them. Ask before writing one — either half
  could be the mistake, and only the user knows which.
- **A version file that didn't move**: `bump` will not read done afterwards and the
  run aborts there. Never tag a half-bumped tree.
- **A repo that migrated to GitHub Flow** after its config was committed: see
  `workflowDrift` above. A missing field is never re-detected on its own.
