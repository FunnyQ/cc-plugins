# ADR-0007: Repo migrates to GitHub Flow with a single long-lived main branch

- Status: Accepted
- Date: 2026-07-27

## Context

The repo ran git-flow with a `develop` branch. Migration required, in order:
landing and verifying a five-component release on the old model, confirming
the plugin cache had actually updated to the version doing the migration
(checked by grepping cache file counts, not assumed), updating
`.chronicle/release.json` to add `"workflow": "github-flow"` and drop
`branches.develop`, rewriting CLAUDE.md's Releasing section for a single-branch
model, and only then deleting `develop`.

## Considered alternatives

- Delete `develop` immediately alongside the config change. Rejected in favor
  of a three-check safety sequence first, since deleting a branch is not
  something to reverse casually.

## Decision

Migrate to GitHub Flow: `main` becomes the sole long-lived branch; `develop`
is deleted, both locally and on the remote, only after three checks pass:
`git log --oneline --no-merges main..develop` returns 0 (the one commit
`develop` appears to lead by is git-flow's empty merge-back, carrying no
unique content — counting raw commits instead of non-merge commits would
wrongly show 1); GitHub's default branch was already `main`, so deletion
cannot orphan the default; and the pre-deletion SHA (`1f166ad`) is captured
for recovery before deletion runs. `.chronicle/pr.json` needed no change — it
was already GitHub Flow with base `main`; only `release.json` had drifted.

## Consequences

`/chronicle:release auto` now commits a version bump directly on `main` and
tags that commit, with no merge step. Post-migration, `analyze-release.ts`
reports `workflowDrift: null`, confirming config and branch structure agree.
CLAUDE.md's line describing `check-branch.sh` blocking commits on a
"git-flow repo's" main/master was deliberately left unchanged — it describes
the hook's general behavior, not this specific repo, and remains accurate;
it also explains why the migration commit on `main` was not itself blocked.
This three-check pattern (non-merge diff, default-branch check, recovery SHA)
is reusable for any future long-lived-branch deletion.

## Evidence

- **Non-merge commit count, not raw commit count, is the safety check** —
  `git log --oneline --no-merges main..develop` returned 0; the apparent
  1-commit lead was git-flow's empty merge-back (`1f166ad`), carrying no
  unique content. Five components' tags all landed on merge commit `df7216f`
  and were confirmed present on origin before deletion; plugin cache version
  was confirmed via grep counts (0.9.3 cache: 10/9/6/6 hits across four files;
  0.9.2 cache: 0 hits) rather than assumed from version number alone.
  Session `dba60e1c-d26b-49da-8627-bdb22ada1c7d`, entry `f6ea0894-6419-4075-abc3-54989f91275c`, 2026-07-27.
