# `tasks/README.md` Template

`tasks/README.md` is the entry point for any executor, human or sub-agent. An executor that finds it incomplete will guess, which is the failure flightplan exists to prevent.

**Most of this file is generated.** `scripts/build-readme.ts` parses every task header and regenerates, between the markers below, the status conventions, the task index (Bucket / NN / Title / Status / **Pass line** / Depends on), one dependency graph for the whole tree, and — for multi-bucket plans — a cross-bucket dependency table. The Pass line column shows each task's Eval-rubric pass threshold, for example `> 4`, or `—` if the rubric is unparseable. Do not hand-write any of these.

```
<!-- flightplan:generated:start -->
... generated content ...
<!-- flightplan:generated:end -->
```

The prologue (above the markers) and epilogue (`## Known gaps`, below them) are human-authored, and regeneration preserves both. On first run the script writes a skeleton with every prologue section already filled in except the two placeholders you own. Rerun `build-readme.ts` whenever a task's header changes (status, deps, title).

## Template

```markdown
# <Topic> — Task System

## Purpose
## Directory layout
## Reading order for executors
## Naming convention
(these four ship pre-filled in the skeleton; edit only to add topic-specific detail)

## Where to start

<First task to execute, by path. Usually the foundation task in the earliest bucket.>

<!-- flightplan:generated:start -->
<!-- flightplan:generated:end -->

## Known gaps

Decisions or design questions that surfaced during planning but weren't resolved. Each entry is a blocker waiting to be addressed; resolving it may add or change task files.

1. **<Gap title>** (<scope: which task affected>)
   <Context, what needs to happen, who can decide.>
```

## Tailoring rules

- **Cross-bucket rationale**: when the reason a task needs another bucket's work would help executors, explain it under `## Where to start`. Anything written between the markers is lost on the next regeneration.
- **No open gaps**: verify that none exist before leaving `## Known gaps` empty, rather than hiding them.
