---
name: release
description: >-
  Cut a release — bump version files, write the CHANGELOG entry, then commit,
  merge, tag, and push. Stops earlier with `local` or `prepare`.
when_to_use: >-
  When the user wants to cut/ship a release. Auto-detects whole-repo vs
  per-component monorepos, remembered in .chronicle/release.json.
  Human-invoked only — do NOT auto-fire from release planning or talk.
argument-hint: "[local|prepare] [version|component...]"
---

# Chronicle Release

A release is a short list of stages, run by `scripts/release.ts`. Each stage knows
whether it has already happened by looking at the repo, so a run picks up wherever
the last one stopped and re-running one is a no-op rather than an error.

You own the two things a script cannot do: **asking which version to cut**, and —
on a first run — **interviewing the repo's shape**. The changelog entry needs
judgment too, so one agent writes it.

Run the scripts yourself, with Bash. Each prints four or five lines — the gate's
own questions, answered — so relaying them through an errand-runner would put a
model between you and a version number to save nothing. The full analysis stays on
disk at `outputPath`, and `--json` prints it instead when you need a field the
digest leaves out. Only the changelog entry goes to an agent, because only it reads
a whole range of commits.

## Stages

```
save-config?  bump  [artifacts]  entry  commit  [merge]  tag  [back-merge]  push
                                    ▲                     ▲                  ▲
                          prepare ──┘             local ──┘       default ───┘
```

`merge` / `back-merge` exist only on git-flow. `save-config` only on a first run.
`artifacts` only when the config declares a committed build output.

## Modes → `--through`

- `/chronicle:release` → `--through push`. The default: bump, entry, commit, tag,
  and publish.
- `/chronicle:release local` → `--through tag`. Everything except the push.
- `/chronicle:release prepare` → `--through entry`. Bump and write the entry, then
  stop. You review and commit.

`auto` and `auto push` are older names for the default; treat both as `--through
push`. `auto` used to stop at `tag`, so a user reaching for it out of habit is
asking for a run that now reaches the remote — the push confirmation below is what
tells them.

**A `push` run needs the user's explicit go-ahead before step 6.** Name the remote,
the branches, and every tag, and get a yes. Nothing else in the flow waives this:
not a version token, not a mode word, not a resumed run. Downgrade to `local` when
the user declines the push but wants the rest.

Run after a `prepare`, the default finishes it: `bump` and `entry` already read as
done, so it commits what is there and tags that commit. It never writes a second
bump or a second entry.

A version token (`0.5.0`) or component token(s) (`chronicle`, or `chronicle monitor`)
may follow any mode to skip **the version question only** — never the push
confirmation. Naming two or more components
cuts a coordinated release: one commit, N scoped tags. A bare version token only
disambiguates a single-unit release — with several components named, ignore it and
ask each bump. A per-component `chronicle@0.5.1` form is fine if the user writes it.

## Running the scripts

Run each command **once per step**. `plan` then `run` are two different commands, not
a rerun, and re-running `run` after an artifact rebuild is the documented fix, not a
retry. What is forbidden is reaching for a *different* command after one fails: never
rerun a failed command with changed flags, never substitute another script, and never
hand-roll the git a stage would have done.

Read the exit code, not just stdout. `plan`'s exit 1 is the one non-zero that carries
a usable result — the blocked stage in step 4. **Every other non-zero exit ends the
release**: report the exit code and the last meaningful line of stderr, summarizing a
stack trace to its message rather than pasting it, and stop. Exit 2 means the script
refused before doing anything — no config, malformed `units`, a missing `--through` —
so there is no digest to read and nothing to carry forward. A script that exits 0
but prints nothing is a failure too, and say so instead of guessing what it meant.

Each command prints a digest for you to act on, never for a machine to parse. Quote a
line back to the user when it matters; do not paste the whole block into your reply.

## Your job

### 1. Facts

```bash
bun "{SKILL_DIR}/scripts/analyze-release.ts"
```

`{SKILL_DIR}` is the skill's load-time "Base directory for this skill" banner.
Substitute the literal absolute path before running. Do not hard-code a path, do
not rely on `${CLAUDE_PLUGIN_ROOT}`, and never leave a `$`-prefixed token in the
command — nothing sets that variable, so it expands to empty and the command runs
against `/`.

You get one line per changed unit, one collapsing the unchanged ones, the config
and branch, and the payload path:

```
chronicle  0.15.1 → patch 0.15.2 · minor 0.16.0 · major 1.0.0   6 commits since chronicle-v0.15.1
unchanged  dispatch guard herdr monitor relay
config     github-flow · branch main · no drift
payload    /tmp/chronicle/release/analysis-….json
```

`[files already at X]` on a unit's line is the `fileVersion` case in step 3.
Either drift prints in capitals on the `config` line — read the payload for its
details, and handle it before the gate. `--json` prints the digest's source, and
`--full` adds `tags`, `config`, and `suggested` back; a first run needs `suggested`,
so use `--full` there or read the payload.

If `workflowDrift` is set, the committed config still says git-flow but its
`missingBranch` is gone. Say so **before** the gate and offer the one-time edit
(`"workflow": "github-flow"`, drop `branches.develop`). Never apply it silently, and
never run `auto` against the drifted config.

If `versionFileDrift` is non-empty, the config bumps a `manifest` but not the
companion file carrying the same version — a `Cargo.toml` without its `Cargo.lock`
block. Say so **before** the gate and offer to add each `missing` entry to that unit's
`versionFiles`. Never add it silently. Release without it and the lock keeps the old
version, so the next unrelated `cargo build` rewrites it and drags the version change
into a foreign commit.

### 2. First run only — interview the shape

If `hasConfig` is false, turn `suggested` into a final `ReleaseConfig`
(`references/release-config.md`). Ask only what the defaults cannot settle: whole-repo
vs per-component, git-flow vs github-flow, the tag template, the version files, the
branch names. Add a capture-group `pattern` for odd locations like a Rails
`config/application.rb` — `suggested` will not include those.

Pass `--persist-config` on the first `run`, which adds the `save-config` stage.

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

```bash
bun "{SKILL_DIR}/scripts/release.ts" plan --units '{units}'
```

The `stages` line lists them in order, a done one marked `✓`. The `entry` line
carries everything step 5 hands the annalist. Exit 1 means something is
**blocked** — a `BLOCKED` line names the stage and the reason. Report it and stop.
A blocked stage is always a state the user must resolve (a tag already on another
commit, a `main` behind its remote); never work around it.

### 5. Entry, if pending

If the `entry` stage is pending, spawn the annalist **once**, with
`subagent_type: "chronicle:annalist"`, never a fork, no `name`:

```
Agent({
  subagent_type: "chronicle:annalist",
  prompt: "skill directory (absolute, literal): <the base-directory banner value>. Write a CHANGELOG entry per release. changelogPath=<the plan's changelogPath>; entries=<[{headerLabel,tagName,pathScope,lastTag}, ...] JSON>. Read references/changelog-template.md. Prepend all entries as one contiguous newest-first block at the top. Return the entry text + the changelog path."
})
```

`changelogPath` and each entry's `headerLabel`, `pathScope`, and `lastTag` are the
plan's `entry` line, and `tagName` is its `plan` line — you never need the raw config
for this. Skip this whenever `entry` reads `entry✓` — the entry exists, and a second
one for the same version is a duplicate heading.

### 6. Run

On a `push` run, confirm the publish first — the remote, the branches, and the tag
names, as one question. Ask it even when the version gate never ran, and treat a
decline as `--through tag` rather than a stop.

```bash
bun "{SKILL_DIR}/scripts/release.ts" run --units '{units}' --through "{stage}"
```

The result names what executed, what it skipped, the release commit, and the tags.
A stage that runs without taking effect aborts the release — the engine will not
report a tag it did not cut. `executed   nothing` on a resumed run means every
stage was already done, not that the run failed.

### 7. Verify before reporting

- **prepare** → confirm the version files read `targetVersion` and the changelog
  holds the entry.
- **local / default** → for every tag, require non-empty `git tag --list "{tag}"` and
  `git rev-list -n1 "{tag}"` equal to `releaseCommit`. When pushing, also require
  non-empty `git ls-remote --tags origin "{tag}"`.
- Relay only verified results. Never announce an unverified tag or push.

## Committed build outputs

A repo that commits a build output — a compiled binary, a bundled script — carries a
version no bump can rewrite. Declare those as `artifacts` and the `artifacts` stage
asks each one for its version after the bump, and stops the release while one still
reports the old number. It sits before `tag` because everything after a pushed tag is
a force-push.

When the run aborts there, the note names the artifact and what it reported. Rebuild
it and re-run. Give the artifact a `build` command and the stage rebuilds it itself.
Either way the rebuilt file is staged with the release commit.

## Protected branches

Release operates on the branches the config names. Defer to the user's existing
branch guard; don't re-implement branch protection. A github-flow release commits
**on `main` by design** — chronicle's `check-branch.sh` exempts exactly that commit
(a `🔧 release:` subject on a `.chronicle/pr.json` github-flow base). A different
host guard may still prompt. Answer it; don't work around it.

## Codex

Same flow, one role. Run the scripts yourself and spawn the registered
`chronicle_annalist` for the entry — or — with a generic sub-agent API only — a
non-fork generic agent named `chronicle_annalist`, told to read and obey its TOML
under `$CODEX_HOME/agents/chronicle/` (default `$CODEX_HOME` to `~/.codex`).
Never paste or improvise the role instructions. If it is missing, tell the user to
run `chronicle:install`.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/release/references/opencode.md` instead of the
spawn instructions above — bare agent names, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

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
- **An artifact whose version command cannot run** — missing file, wrong flag — reads
  as stale, never as current. Fix the `command`; never drop the artifact to get past
  the stage.
