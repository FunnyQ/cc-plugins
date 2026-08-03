# WORK-01: Restore-family ban across every command-discretion prompt

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/orchestrator-anatomy.md`
>
> **Depends on**: none — foundation task
> **Blocks**: work/02
> **Status**: done

## Goal

Every agent whose prompt lets it choose its own shell commands is told never to run
`git checkout`, `git restore`, `git reset` or `git clean` — not just the three whose agents
write source.

**The boundary is command discretion, not Bash access.** Every Workflow agent holds Bash, so
that cannot be the line. The line is whether the prompt hands the agent a decision about what
to run. Seven prompts do: the three writers, the verifier (it runs whatever the task file's
Verification section lists), the judge, the review lenses, and the commit instructions. Three
do not: the mark-done and mark-blocked prompts each perform one scripted transition against
their own task file, and the wave scout runs a single fixed readiness command and returns its
stdout. Those three receive nothing new.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — extract the
  restore-family ban into its own constant inside the fenced script, then inject it into the
  four prompt builders that currently lack it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — assert
  that the composed rule still reaches the three writer prompts unchanged, and that it now
  reaches the four new ones.

## Implementation notes

This task changes **prompt text only**. No control flow, no schema, no new behaviour. Every
edit lands inside the single ` ```javascript ` fence.

### Why this is needed

`NO_COMMIT_RULE` already carries a restore-family ban, written precisely because tasks run in
parallel in one shared working tree. It is injected into `devPrompt`, `devExternalPrompt` and
`fixPrompt` — the three prompts whose agents write source. The ban was scoped by **role**, and
universal Bash access is what makes that proxy invalid: the verifier, the judge, the review
lenses and the commit agents all hold Bash too, so "writer" never bounded who *could* run the
command.

Bash access is not the replacement boundary either — every Workflow agent has it, including the
three prompts excluded below. The boundary is **command discretion**: whether the prompt hands
the agent a decision about what to run.

This was observed live. A verifier met test failures caused by a sibling task still writing the
tree, and attempted `git reset --hard` to get a clean run. A human denied it.

### Step 1 — extract `NO_RESTORE_RULE`

`NO_COMMIT_RULE` (~line 242) is currently three paragraphs inside one template literal:

1. the commit ban (`git commit` / `git add` / `git push` / `git stash`),
2. the restore-family ban, opening `Never run \`git checkout\`, \`git restore\`, \`git reset\`,
   or \`git clean\` either.` and containing the sentence `do not reason your way past this one`,
3. the narrow rule that editing a shared source file is fine but another task's file under the
   `tasks/` tree is never yours to touch.

Move paragraphs **2 and 3** into a new `const NO_RESTORE_RULE`, placed immediately before
`NO_COMMIT_RULE`. **Copy the text verbatim.** Do not reword, re-wrap, or "improve" a sentence —
these paragraphs were tuned against observed model behaviour, and the second one opens by
warning the reader not to reason past it for exactly that reason.

Paragraph 2 begins with `Never run ... either.` — the word `either` refers back to the commit
ban. That reads correctly in both places it now appears, so leave it.

### Step 2 — recompose `NO_COMMIT_RULE`

Redefine it as its surviving first paragraph plus an interpolation of the new constant:

```js
const NO_COMMIT_RULE = `Never run \`git commit\`, ... into its commit.
${NO_RESTORE_RULE}`
```

`devPrompt`, `devExternalPrompt` and `fixPrompt` each interpolate `${NO_COMMIT_RULE}` and must
render **byte-identical** text to today. This step is a pure refactor for them; if their output
changes at all, the extraction was done wrong.

Keep the existing explanatory comment above `NO_COMMIT_RULE` with the constant it describes,
and give `NO_RESTORE_RULE` its own short comment saying *why* it is separate: the ban belongs to
every prompt that lets its agent choose what to run, not only to the writers, so it has to be
injectable on its own. Do not write "every agent with Bash" — every Workflow agent has Bash, and
three prompts are excluded precisely because they run one fixed command.

### Step 3 — inject into the four builders that lack it

| Builder | ~line | Idiom |
|---|---|---|
| `reviewPrompt` | 330 | template literal — add `${NO_RESTORE_RULE}` near the closing REVIEWER line |
| `verifyPrompt` | 380 | template literal |
| `judgePrompt` | 395 | template literal |
| `commitInstructions` | 616 | **string concatenation**, `+ '...\n'` per line — match that style, e.g. `+ NO_RESTORE_RULE + '\n'` |

`commitInstructions` is one builder shared by two call sites (the inter-wave commit agent and
the post-loop commit agent), so a single injection covers both.

**Why the commit agents need it even though committing is their job.** Committing requires
`git add`, `git commit`, `git status`, `git diff` and `git log` — never `checkout`, `restore`,
`reset` or `clean`. Its step 8 already contemplates a hook blocking the commit and a merge
conflict, which is exactly the moment an agent reaches for `reset` to tidy up before retrying.

Place each injection where the prompt's other standing rules live, not at the very top — these
prompts open with a flightlog announce instruction that must stay first.

### Step 4 — propagate the ban to the external review CLI

`reviewPrompt` branches on `lens.external`. In that branch a cheap driver agent writes an
instruction file and hands it to the codex or opencode CLI. On the live path that CLI is invoked
with `--dangerous`.

**Constraining the driver's own prompt does not constrain the delegate.** Add an instruction in
the external branch telling the driver to include the restore-family ban in the instruction it
writes for the CLI. `devExternalPrompt` already does exactly this for the commit rule — its
step 3 says to include the no-commit rule in that instruction, in the driver's own words but
with the same force. Mirror that shape and that reasoning.

### Step 5 — tests

The fixture at `orchestrator-script.test.ts` extracts the fence and runs it with stubbed
`agent` / `parallel` / `log` / `phase`, capturing every prompt string the script passes to
`agent()`. Assert against that capture:

- the dev prompt still contains **both** a distinctive sentence from the commit paragraph and
  one from the restore paragraph — this is what proves the recomposition dropped nothing;
- the verify, judge and review prompts each now contain the restore-paragraph sentence;
- the commit agent's instruction contains it too.

Pick a distinctive substring for the assertion, such as `do not reason your way past this one`.
Match the file's existing test style rather than introducing a new helper.

**Substring assertions cannot prove byte-identity, and this task claims it.** They still pass
after a whitespace change, a re-wrap, or a reordered paragraph. Prove it exactly, once, with a
throwaway check rather than a committed test:

1. `git show HEAD:packages/dispatch/skills/autopilot/references/orchestrator.md > <scratch>/before.md`
   — read-only, and the only git this task runs.
2. Write a temporary bun script that extracts the fence from both `before.md` and the working
   copy, evaluates each with the same stub set the fixture uses, and captures the prompt string
   passed to `agent()` for the dev, external-dev and fixer calls.
3. Assert the three pairs are `===`. Quote the result in your summary.
4. Delete the temporary script. Do not commit it: after this change lands, `HEAD` becomes the
   new text and the comparison would silently degrade to comparing a file with itself.

Do not reach for `git stash` or any other command that rewrites the tree — sibling tasks may be
running beside you.

## Acceptance criteria

- [x] `NO_RESTORE_RULE` exists in the fenced script, defined immediately before
      `NO_COMMIT_RULE`, and contains both the restore-family paragraph and the
      another-task's-file paragraph.
- [x] Both paragraphs are byte-identical to the text they were moved from — no rewording,
      no re-wrapping.
- [x] `NO_COMMIT_RULE` retains only its commit-ban paragraph and interpolates
      `NO_RESTORE_RULE`, so the text it renders is unchanged from before this task.
- [x] `verifyPrompt`, `judgePrompt` and `reviewPrompt` each interpolate `NO_RESTORE_RULE`.
- [x] `commitInstructions` includes `NO_RESTORE_RULE`, written in that builder's own
      string-concatenation style rather than as a template literal.
- [x] The external-lens branch of `reviewPrompt` instructs the driver to write the
      restore-family ban into the instruction file it hands the external CLI.
- [x] `markDonePrompt`, `markBlockedPrompt` and the inline wave-scout prompt are unchanged.
- [x] The test fixture asserts the rule reaches the dev prompt, the verify prompt, the judge
      prompt, the review prompt and the commit instructions.
- [x] The byte-identity of the three writer prompts is proved by an exact string comparison
      against the pre-change revision, not inferred from substring assertions.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes with no failures — the
      baseline before this task is 198 pass, 0 fail, and the new assertions add to that.
- [x] `grep -n 'NO_RESTORE_RULE' packages/dispatch/skills/autopilot/references/orchestrator.md`
      prints at least 6 lines: the definition, the interpolation inside `NO_COMMIT_RULE`, and
      one in each of `verifyPrompt`, `judgePrompt`, `reviewPrompt` and `commitInstructions`.
- [x] `grep -c 'do not reason your way past this one' packages/dispatch/skills/autopilot/references/orchestrator.md`
      prints `1` — the sentence lives in exactly one constant now, not copy-pasted per builder.
- [x] `grep -c '\${NO_COMMIT_RULE}' packages/dispatch/skills/autopilot/references/orchestrator.md`
      prints `3`, confirming the three writer prompts still take the composed rule and were not
      switched to the narrower constant.
- [x] `git status --short -- packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts docs/autopilot-defer-requalify/tasks/work/01-restore-family-ban.md`
      shows all three paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A writer prompt's rendered text changed, or a moved paragraph was reworded or re-wrapped | All four injections present, but one builder's idiom was broken or the external CLI instruction was skipped | Verbatim extraction, writer prompts byte-identical, all four injections plus the external CLI propagation |
| Test coverage | ×2 | No test asserts prompt content | Only the dev prompt is asserted, so a dropped injection would pass | Composition and each new injection site asserted; the suite fails if any one is reverted |
| Interface & readability | ×1 | New constant placed far from the one it was split out of, or named inconsistently with it | Placed well, but the concatenation builder was given template-literal syntax | Constant sits immediately before `NO_COMMIT_RULE`; every builder keeps its own idiom |
| Assumptions & docs | ×1 | No comment explains why the constant was split | Comment narrates what the constant contains | Comment explains why the ban is scoped by tool access rather than by role |

## Out of scope

- `markDonePrompt` and `markBlockedPrompt` — Deferred. Reason: each runs one scripted
  transition against its own task file and issues no git command, so the ban would be noise.
- The inline wave-scout prompt — Deferred. Reason: it runs exactly one command,
  `next-ready.ts --summary`, and returns its stdout verbatim.
- Giving the verifier anything to do *instead* of wiping the tree — Deferred to a follow-up
  task in the same bucket. This task removes the permission; it does not yet remove the motive.
- Any change to control flow, schemas, the wave loop, or the dashboard.
