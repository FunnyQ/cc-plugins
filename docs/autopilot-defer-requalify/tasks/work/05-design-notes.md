# WORK-05: Design notes for the restore ban and the defer gate

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/orchestrator-anatomy.md`
>
> **Depends on**: work/03
> **Blocks**: work/06
> **Status**: done

## Goal

A later reader of the orchestrator can tell why the destructive-git ban reaches every prompt
that gives its agent discretion over what commands to run — rather than only the source writers,
and rather than every prompt whose agent merely holds Bash — and why the verifier is allowed to
postpone a verdict but never to waive one.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — add two entries to
  the `## Notes / gotchas` section. Documentation only: everything this task writes lives
  **outside** the fenced ` ```javascript ` block.

## Implementation notes

### Where this goes, and what must not move

`## Notes / gotchas` is the prose section that begins after the fenced script closes. Its
entries are the design record for every non-obvious choice in the script.

**This task changes no code.** The fence is the program, and it is edited by other work in this
plan; a stray character inside it breaks the deterministic fixture. Add prose after the closing
fence and nothing else.

### Match the section's register — read it first

Before writing a word, read at least four existing entries in that section end to end. They
share a shape that the two new entries must follow:

- A **bolded lede sentence** that states the rule or the failure outright.
- Then dense prose that names the *concrete* failure, explains why the obvious alternative is
  wrong, and — where one exists — cites the live run where the failure was observed, by its run
  id or by what the agent actually did.
- No bullet-within-bullet decomposition, no headings, no restating what the code does. The
  house rule is *why, never what*.

Two neighbouring entries are especially close in subject and are the best models: the one
beginning "Only the commit agents commit", including its indented follow-on paragraph about the
restore family, and the one beginning "Do NOT give the dev agent `isolation: 'worktree'`".

Place the new entries adjacent to that commit-agent entry, since they extend the same argument.

### Entry one — the ban is scoped by command discretion, not by role

Lede: the destructive-git ban belongs to every prompt that lets its agent choose what to run,
not only to the ones whose agents write source.

Be precise about the boundary, because the obvious phrasing is wrong: Bash access cannot be the
line, since every Workflow agent has Bash. The line is whether the prompt hands the agent a
decision about which commands to issue. The two task-status transitions and the wave scout each
perform one fixed scripted step, so they are excluded on purpose — say so, or a later reader
will read the entry as describing a rule the code does not follow.

Substance to carry:

- The restore-family ban originally reached only the three prompts whose agents write source,
  because it was scoped to the idea of a "writer". Universal Bash access is what breaks that
  proxy: the verifier, the rubric judge, the review lenses and the commit agents all hold Bash
  too, so role never bounded who *could* run the command.
- But Bash access is not the replacement boundary either, and the entry must say so — every
  Workflow agent has it, including three prompts that are excluded on purpose. The boundary is
  **command discretion**: whether the prompt hands the agent a decision about what to run. The
  two task-status transitions and the wave scout each perform one fixed scripted step, so they
  get nothing.
- **The run identifier to cite**, since the neighbouring entries all name theirs: the
  `tab-layout-selector` flightplan run in the `herdr-workbench` repository, on 2026-08-03, whose
  trail is `docs/tab-layout-selector/.flightlog/run.jsonl` there. That wave dispatched two tasks
  together at 06:17Z — a module-extraction task and a config task — and the extraction task's
  verifier attempted the reset between 06:26Z and 06:33Z while the config task was still editing
  a shared source file. That run predates any workflow-id in the trail, so the repo, slug and
  date are the stable reference — use them rather than inventing a `wf_`-style id.
- Observed live: a verify agent attempted `git reset --hard` during a parallel wave, and a
  human denied it. The trigger was structural rather than a model going rogue — a sibling task
  was mid-edit of a shared config file, the whole-suite test command went red because of it,
  and the verifier owed a binary verdict with no sanctioned way to handle red output it had
  not caused. Wiping the tree is the locally rational move from inside that position.
- Why the commit agents are included even though committing is their job: committing needs
  `add`, `commit`, `status`, `diff` and `log`, and never the restore family. Their instructions
  already contemplate a blocking hook and a merge conflict — precisely the moments when an
  agent reaches for `reset` to tidy up before trying again.
- Why this is defense-in-depth and not enforcement, stated plainly so nobody mistakes it for a
  guarantee: Workflow `agent()` accepts no tool allowlist, and agent-frontmatter tool lists do
  not constrain Workflow subagents. A `git` wrapper on `PATH` is bypassed by an absolute path.
  Comparing the tree before and after only *detects* damage that `reset --hard` has already
  made unrecoverable. Worktree isolation would blind the verifier to the uncommitted edits it
  exists to verify. The prompt is the only lever the script has.

### Entry two — the verifier postpones, it never waives

Lede: a verifier may delay a judgement; it may never avoid one.

Substance to carry:

- Both obvious fixes are wrong, and the entry should say why each fails. Letting the verifier
  attribute failures to a sibling and judge only its own criteria contradicts the gate's own
  rule that every verification command must succeed — and the "files this task declares"
  boundary is not a causal boundary. A sibling editing a shared dependency surfaces as a
  failure inside this task's own files, while this task's genuine regression surfaces in a file
  it never declared. Failing strictly on every non-zero exit is safe, but it sends
  already-correct code back through a rewriter: it wastes an attempt and risks regressing work
  that was right.
- So the verifier defers instead. It postpones the verdict, waits for the tree to go quiet, and
  re-runs the same commands once, strictly. The re-run's verdict is final.
- Quiet is a zero-crossing of a live writer count, not a one-shot barrier. A task that fails
  its gate retries its dev step and writes again, so "every first write has finished" is not a
  stable notion of quiet.
- Waiting instead for siblings to reach a terminal state deadlocks on mutual deferral: two
  deferred tasks each wait for the other to terminate, and neither can terminate while it is
  waiting. Record this, because it is the more intuitive design and someone will propose it.
- The load-bearing guard: a deferral is refused unless another writer is active at that moment.
  Without it, a verifier whose siblings have all finished wins a free re-run of a red command,
  so a flaky failure — or its own real one — passes on the second roll. That would be weaker
  than simply failing, which is the whole thing this mechanism is supposed to beat.
- The residual race, stated honestly rather than glossed: a sibling can begin a retry the
  instant after a zero-crossing releases a waiter, so a re-run can still meet a dirty tree. It
  then fails strictly, which is the pre-existing behaviour — never worse.
- The failure mode being designed against, named concretely: in that same live run, the
  verifier went on to report `PASS` over two still-failing tests, attributing them to the
  sibling on its own initiative. A false positive is already in the wild; that is why no
  wording anywhere lets a verifier reclassify a red result as a pass.

## Acceptance criteria

- [x] Two new entries exist in the `## Notes / gotchas` section of
      `packages/dispatch/skills/autopilot/references/orchestrator.md`, both placed after the
      closing fence of the ` ```javascript ` block.
- [x] The first entry states that the ban is scoped by **command discretion** rather than by
      role or by Bash access, names the prompts excluded for running one fixed command, names
      the denied `git reset --hard` attempt by a verify agent as the observed failure, cites the
      originating run by repository, plan slug, date and trail path — there is no workflow id to
      quote, so do not invent one — gives the reason the commit agents are included, and states
      that the prompt is defense-in-depth rather than enforcement.
- [x] The second entry names both rejected alternatives — the sibling-attribution waiver and
      the unconditional strict fail — and says specifically why each is wrong.
- [x] The second entry records the terminal-state deadlock argument and the requirement that a
      deferral needs a live sibling writer, including what breaks without that requirement.
- [x] The second entry records the residual race in which a sibling starts writing again just
      after the tree goes quiet, and states that the outcome there is a strict failure.
- [x] Both entries follow the section's existing shape: a bolded lede sentence followed by
      prose, with no sub-bullets or headings introduced.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes. The fixture extracts and
      executes the fenced script, so any accidental edit inside the fence fails here.
- [x] Both entries sit outside the fenced script, in the notes section. The `## Notes / gotchas`
      heading is itself after the closing fence, so a match below that line is necessarily
      outside the script. Run this and confirm it prints a line for each new entry:
      `ANCHOR=$(grep -n '^## Notes / gotchas$' packages/dispatch/skills/autopilot/references/orchestrator.md | cut -d: -f1); grep -n -e 'tool access' -e 'postpone' packages/dispatch/skills/autopilot/references/orchestrator.md | awk -F: -v a="$ANCHOR" '$1 > a {print "IN NOTES SECTION line " $1}'`
- [x] Read the four entries surrounding the insertion point and confirm the two new ones match
      their register — bolded lede, dense prose, concrete failure named, no sub-bullets.
- [x] `git status --short -- packages/dispatch/skills/autopilot/references/orchestrator.md docs/autopilot-defer-requalify/tasks/work/05-design-notes.md`
      shows both paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | An entry misstates the mechanism — e.g. describes the defer as waiving a failure, or the quiet signal as a one-shot barrier — or edits land inside the fence | Both entries present and accurate, but one reads as a summary of what the code does rather than why, or drops a rejected alternative | Both entries accurate about the mechanism, each naming its concrete failure and its rejected alternative, in the section's own register |
| Test coverage | ×2 | The suite is left failing, or the placement check was never run | Suite green, but placement confirmed only by eye rather than by the command | Suite green **and** the fence-boundary command run and reported. This is a docs task: there are no new test cases to write, and adding some would be out of scope |
| Interface & readability | ×1 | Sub-bullets, headings, or a new formatting convention introduced into the section | Correct shape but padded — restates the code, or repeats a neighbouring entry | Bolded lede plus dense prose, matching the surrounding entries closely enough to be indistinguishable in style |
| Assumptions & docs | ×1 | The defense-in-depth limit or the residual race is omitted, leaving the reader with a false guarantee | Limits mentioned but vague about what they cost | Every limit stated plainly: what the ban cannot enforce, what a deferral cannot prove, and what happens when the tree is dirty again on the re-run |

## Out of scope

- Editing anything inside the fenced script. This task documents a mechanism that is already
  implemented by the time it runs; changing behaviour here would make the notes describe code
  that no gate reviewed.
- Rewriting or reflowing the existing entries in the section. Deferred. Reason: several tasks
  in this plan edit this file in sequence, and gratuitous reflow turns a small later edit into
  a conflict.
- The `SKILL.md` operator-facing documentation for the defer state. Deferred. Reason: the
  design record and the operator instructions are separate audiences, and only the design
  record is needed before the closing review.
