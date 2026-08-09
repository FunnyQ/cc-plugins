---
name: commit
description: >-
  Craft git commit(s) for the current changes — auto-decides between one
  simple commit and an atomic split.
when_to_use: >-
  When you want to commit the current changes now. The `simple` argument
  forces one commit instead of the auto-decided atomic split. Human-invoked
  only — do NOT auto-fire from an incidental mention of committing.
argument-hint: "[simple]"
---

# Chronicle Commit

A commit run is a plan file and one script. `scripts/commit.ts` decides the shape,
checks the plan covers the changeset, stages, commits, and verifies — in one
process, off one artifact on disk. Re-running it finishes an interrupted run
instead of duplicating it.

Two things a script cannot do. **Grouping the diff** needs judgment, so the
**watcher** reads it — and it is the only party that does, which is what keeps the
diff out of this conversation. **Writing the prose** needs the "why", which lives
here, in this conversation, and nowhere else. So you write the bodies yourself.

You never run `commit.ts apply`. The **runesmith** runs it and returns only the
distilled result, so staging output, git errors, and stack traces stay out of this
conversation.

## Topology

```
main agent  (holds the conversation = the "why")
  ├─ chronicle:watcher   (Haiku) — reads the diff, returns groups + the script's shape
  ├─ you write the plan file: bodies + 繁中 summaries
  └─ chronicle:runesmith (Haiku) — runs commit.ts apply, returns the distilled result
```

Spawn each with `subagent_type`, never a fork — a fork inherits this whole
conversation, which is the opposite of what these are for. One at a time, no `name`,
and never two in one message. Neither spawns children.

## Your job

### 0. Baseline and mode

Run `git rev-parse HEAD 2>/dev/null || true`. An empty baseline means an unborn
branch.

Set `mode: "simple"` if the argument is `simple` (case-insensitive) or the user's
phrasing clearly asks for one commit ("one commit", "快速 commit", "single commit").
Otherwise `mode: "auto"`.

If the branch is protected, defer to the user's existing branch guard before
spawning. Do not re-implement branch protection.

### 1. Watcher

```
Agent({
  subagent_type: "chronicle:watcher",
  prompt: "$SKILL_DIR=<...>. mode=<auto|simple>. Follow your agent instructions fully."
})
```

`$SKILL_DIR` is the skill's load-time "Base directory for this skill" banner value.
Do not hard-code a repo-relative path or rely on `${CLAUDE_PLUGIN_ROOT}`.

You get back `shape`, `reasons`, `groups`, `totalFiles`, `elidedFiles`,
`moduleSpread`, `promptPath`, and `notes`. `nothingToCommit` means stop and say so.

The shape came from the script. Do not second-guess it.

### 2. Write the plan file

Read `promptPath` — the commit template, which the user may have overridden.

Write the plan to an absolute path **outside the repo**
(`/tmp/chronicle/commit/plan-<timestamp>.json`). A plan file inside the repo is
itself an unassigned change, and `apply` refuses it.

```ts
type PlanFile = {
  shape: "simple" | "atomic";
  commits: {
    emoji: string;
    type: string;
    subject: string;
    files: string[];      // repo-root-relative, exactly as the watcher gave them
    body?: string;        // English markdown bullets
    summary?: string;     // 繁體中文摘要
  }[];
};
```

- **atomic** → one entry per watcher group, its `files` copied verbatim.
- **simple** → one entry holding every file from every group, with a subject you
  write yourself. You have more context than the watcher did; use it.

Then write each `body` and `summary` from **this conversation**. This is the whole
reason the prose is yours: you know why the change was made and the watcher does
not. Never invent rationale the conversation does not support.

Be terse on purpose. About 3–4 one-line bullets say *why*, not what the diff already
shows. The 繁中摘要 is 1–3 sentences that summarize — if it reads like the English
body translated, cut it. A trivial one-liner (a typo, a version bump) may omit both.
If `elidedFiles > 0`, mention the incomplete diff once in the relevant body.

### 3. Runesmith

```
Agent({
  subagent_type: "chronicle:runesmith",
  prompt: "$SKILL_DIR=<...>. planPath=<absolute path>. Follow your agent instructions fully."
})
```

### 4. Report what landed

Run `git rev-parse HEAD 2>/dev/null || true` and compare with the baseline.

- **Changed** → report `git log --oneline <baseline>..HEAD` (or `git log --oneline`
  for an empty baseline), prefixed with `simple commit (forced)`, `simple commit`, or
  `atomic split — N commits`. Add the `verify` counts as one line of evidence.
- **Unchanged** → report no commit plus the runesmith's `error`. Do not respawn.

Never report success the runesmith did not report. `ok: false` is a failure even
when commits exist.

## Failure

The script's exit code says what state the repo is in, and the runesmith relays it:

- **`ok: false` with `missing` / `duplicated` / `unknown` / `splitRenames`** — the
  plan did not cover the changeset. Nothing was staged. Fix the plan file and spawn
  the runesmith again. `splitRenames` means a rename's two paths landed in different
  commits, or its old path was dropped — both halves must sit in one commit, or the
  commit adds the new file while the deletion stays behind.
- **`ok: false` with `executed: N`** — the first N commits stand and one failed. The
  plan file is still valid; a second run resumes at commit N+1. Say what failed
  before re-running.
- **`ok: false` with `verify.missing` / `verify.leftover`** — commits were written
  but the changeset did not land intact. Do not commit again, amend, or retry.
  Report the paths and stop:

  ```
  COMMIT FAILED: verification found files the commits did not carry.
  missing: <paths>   leftover: <paths>
  Commits were created but the changeset is incomplete. Inspect before pushing.
  ```

## Codex

Same flow, same two roles. Spawn the registered `chronicle_watcher` for the diff and
the registered `chronicle_runesmith` for the apply — or, with a generic sub-agent API
only, non-fork generic agents named `chronicle_watcher` and `chronicle_runesmith`,
each told to read and obey its own TOML under `$CODEX_HOME/agents/chronicle/`
(default `$CODEX_HOME` to `~/.codex`). Never paste or improvise the role
instructions. If the role files are missing, tell the user to run `chronicle:install`
and start a new Codex thread.

You still write the plan file between the two, exactly as above. Apply the baseline
HEAD check afterwards and report only commits that actually landed.

If neither path is available, do not pretend the agent flow ran. The main agent may
run `analyze-changes.ts` and `commit.ts` inline only when the user explicitly asks to
continue without agents.

## Edge cases

- **Nothing to commit**: the watcher returns `nothingToCommit`. Say so and stop.
- **Pre-staged files**: no extra prompt — the script stages the plan's files either way.
- **Single file with mixed concerns**: the whole file goes into one commit. There is
  no hunk splitting.
- **Merge or cherry-pick in progress**: git demands the whole index, so only one
  commit is possible. `apply` refuses an atomic plan there rather than letting the
  first commit swallow the rest.
- **A re-run after any failure**: safe. `apply` reads how much of the plan is already
  at HEAD off the log, not off a stored flag.
