---
name: commit
description: >-
  Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split.
when_to_use: >-
  When you want to commit the current changes now. The `simple` argument
  forces one commit instead of the auto-decided atomic split. Human-invoked
  only — do NOT auto-fire from an incidental mention of committing.
argument-hint: "[simple] [only <path>...] [exclude <path>...]"
---

# Chronicle Commit

A commit run is one agent, one file, and two script calls.
`scripts/analyze-changes.ts` hands back the changeset, the recent commits and the
message template as one digest. `scripts/commit.ts apply` reads the plan file the
agent writes from it, decides the shape, checks the plan covers the changeset,
stages, commits, and verifies. Re-running `apply` finishes an interrupted run
instead of duplicating it.

Spawn one **Lawspeaker** and let it run the whole flow. That keeps every diff and
every line of git output out of the main conversation, which is the only reason
this work happens in a subagent at all.

## Topology

```
main agent  (holds the conversation = the "why")
  └─ chronicle:lawspeaker   (subagent_type — a custom agent, NOT a fork)
       1. bun analyze-changes.ts   → the digest: files, diffs, template
       2. group, order, write the plan file (both shapes' prose)
       3. bun commit.ts apply      → shape decided, committed, verified
```

Spawn via `subagent_type`, never a fork. Spawn exactly one Lawspeaker, in one
`Agent` call, with no `name`. It spawns nobody.

The role lives at `packages/chronicle/agents/lawspeaker.md` and auto-registers as
`chronicle:lawspeaker`.

## The main agent's job (thin)

1. **Parse the mode**. `mode: "simple"` if the argument is `simple`
   (case-insensitive) or the user's phrasing clearly asks for one commit ("one
   commit", "快速 commit", "single commit"). Otherwise `mode: "auto"`.
   **Collect `exclude`**: the repo-root-relative paths that follow the `exclude` argument, or
   the ones the user explicitly asks to leave out ("don't commit X", "X 先不要 commit").
   Never exclude a path on your own judgement. Omit `exclude` when there are none.
   **Collect `only`**: the repo-root-relative paths that follow the `only` argument, or
   the ones the user explicitly limits the commit to ("only commit X", "just commit what you
   changed"). When the user asks for this conversation's work, list the paths this
   conversation edited. Never limit the commit on your own judgement. Omit `only` when the
   user set no limit.
   **Collect `upgrade`**: when the user or the change asks for an upgrade note, write
   each action a downstream or generated project must take on upgrade as one line,
   such as `Run midgard pull, then bin/setup`. Omit `upgrade` when there is none.
   Pass it as its own input, never only inside `contextBrief`: a note buried in the
   brief has landed as a paragraph after the trailer, and in `simple` mode not at all.
2. **Distill `contextBrief`** — terse intent and non-obvious rationale from this
   chat. The Lawspeaker sees the diff but not the conversation, so this is the only
   source of _why_ for every commit body it writes. Everything the reader of a
   commit would need to know, and nothing else.
3. **Spawn the Lawspeaker** (`subagent_type: "chronicle:lawspeaker"`), passing:
   - the **skill directory** — the skill's load-time "Base directory for this
     skill" banner value, so it can resolve `<skill dir>/scripts/`. Do not
     hard-code a repo-relative path.
     Pass it as a **literal absolute path**, never as a `$`-prefixed token —
     nothing sets that variable in the agent's shell, so its command silently
     runs against `/`.
   - `contextBrief` (from step 2).
   - `branch` — the current branch. If it is protected, defer to the user's existing
     branch guard before spawning; do not re-implement branch protection.
   - `mode` (from step 1).
   - `exclude` (from step 1), only when it holds paths.
   - `only` (from step 1), only when it holds paths.
   - `upgrade` (from step 1), only when it holds actions.
4. **Verify against git, not against the report.** The Lawspeaker returns `base`.
   Run `git log --oneline {base}..HEAD` and report that.
   - No `base`, or the range is empty → report no commit plus the Lawspeaker's
     reason. Do not respawn.
   - If you passed `upgrade`, check the trailer with
     `git log --format='%h %(trailers:key=Upgrade,valueonly)' {base}..HEAD`.
   - If you passed `exclude` or `only`, relay the Lawspeaker's `warning` line to the user.
     An excluded file the committed code needs leaves a HEAD that does not build, and only the
     user can judge that.
   - If you passed `only`, list the Lawspeaker's `untouched` paths to the user, so no
     changed path drops out of sight.
   - Relay every `[TypeSafe grouping …]` line to the user: how long the call took,
     or why it did not run — no key, a key that is failing, `simple` mode, or a
     changeset under 2 or over 20 files. Nothing else surfaces either.

There is no baseline to record before the spawn: `apply` computes `base` from the
log itself, so a second `rev-parse` here would only re-derive it at the most
expensive context in the flow.

Never report success the Lawspeaker did not report. `ok: false` is a failure even
when commits exist.

## Codex

Codex uses the same topology through one of two role-loading paths:

1. **Named-role selector available**: spawn exactly one registered
   `chronicle_lawspeaker` and pass the literal skill directory, `contextBrief`,
   `branch`, `mode`, and any `exclude`, `only` and `upgrade`.
2. **Generic sub-agent API only**: first verify the stable role file exists at
   `$CODEX_HOME/agents/chronicle/lawspeaker.toml` (default `$CODEX_HOME` to
   `~/.codex`). Spawn exactly one non-fork generic agent with task name
   `chronicle_lawspeaker` and no inherited turns. Tell it to read and obey the
   `developer_instructions` in `lawspeaker.toml` before it handles the same
   inputs. Do not paste or improvise the role instructions.

Both paths return only the final log. After Codex returns, apply the `base` check
above and report only commits that actually landed.

If neither path is available, do not pretend the agent flow ran. If the role file
is missing, tell the user to invoke `chronicle:install` and start a new Codex
thread. The main agent may run `analyze-changes.ts` and `commit.ts` inline only when
the user explicitly asks to continue without agents.

## OpenCode only — skip on Claude Code and Codex

Follow `~/.config/opencode/skills/commit/references/opencode.md` instead of the
spawn instructions above — a bare agent name, no context inheritance, a literal
skill directory. The path is absolute because OpenCode prints no skill
base-directory banner.

## Edge cases

- **Nothing to commit**: `analyze-changes.ts` says so on its first line; the
  Lawspeaker reports `nothing to commit` and stops.
- **Pre-staged files**: no extra prompt — the script stages the plan's files either way.
- **Single file with mixed concerns**: the whole file goes into one commit. There is
  no hunk splitting.
- **Merge or cherry-pick in progress**: git demands the whole index, so only one
  commit is possible. `apply` refuses an atomic plan there rather than letting the
  first commit swallow the rest. For the same reason, `apply` refuses any `exclude` there, and any `only` that leaves a changed path out.
- **Leaving files out**: `exclude` is whole-file and opt-in. A path ending in `/` excludes every changed path under that directory, read when `apply` runs, so files added there after the plan is written stay out too. A changed path that is neither
  planned nor excluded still fails the coverage check. Hunk-level exclusion does not exist.
- **Committing a subset**: `only` is whole-file and opt-in, the inverse of `exclude`. A path ending in `/` covers every changed path under that directory, and a rename counts as inside when either half is. `analyze-changes.ts --only` digests only those paths and lists the rest. `apply` skips the coverage check for every changed path outside `only`, refuses a plan that commits one, and returns them as `untouched`. An `exclude` inside `only` still leaves its paths out.
- **Trailers**: `commit.ts` writes the 繁中 summary as a `zh-summary:` trailer and
  each upgrade action as an `Upgrade: <action>` trailer, and `apply` fails with
  `verify.trailerMissing` when git does not read one back as written.
  `references/commit-template.md` holds the rules. `chronicle:release` turns
  every commit with an `Upgrade` trailer into a `**Upgrade:** ` bullet.
- **A re-run after any failure**: safe. `apply` reads how much of the plan is already
  at HEAD off the log, not off a stored flag.
- **A changeset too wide for one digest**: `analyze-changes.ts` holds back the
  largest diffs, names them, and keeps the payload path. The file table, the stats
  and the template always survive; only diff detail is budgeted.
