# Handoff: `mark-done.ts` strands a whole task subtree without an error

> **Status**: open
> **Reporter**: Q (via Claude)
> **Found in**: dispatch 3.15.4, `skills/flightplan/scripts/`
> **Observed**: 2026-07-31, twice in one autopilot run of `herdr-workbench` `docs/rust-rewrite`
> **Severity**: high — an autopilot run reports success while silently skipping remaining work

## Summary

A dev agent appends a note to a task's `Status` line. `mark-done.ts` then fails to flip
that status and exits `0` with no output. The task stays unready, every dependent stays
blocked, and the autopilot wave loop ends **reporting a clean finish with zero
escalations**.

Nothing in the run surfaces the problem. Only a hand comparison of the workflow's
`completed` array against the on-disk statuses reveals it.

## The defect

`mark-done.ts:41` matches the Status line with:

```ts
const status = /^(>\s*\*\*Status\*\*\s*:\s*)([A-Za-z-]+)\s*$/.exec(line);
```

The value must be one word ending the line. A decorated line does not match. The
function then leaves the status untouched and returns normally.

`lib/parse-task.ts:292` anchors the same way, and does so **on purpose**:

```ts
// Anchor the trailing $ so trailing junk like "todo maybe" or
// "todo | in-progress | done" is rejected, not silently treated as todo.
const match = /^\*\*Status\*\*\s*:\s*([a-z-]+)\s*$/i.exec(line);
```

The anchoring is correct. The bug is that **no consumer reports the rejection at the
moment it matters**. Both regexes fail quietly, in two separate copies of the rule.

## Why it is silent — the full chain

1. A dev agent writes `> **Status**: in-progress (attempt 3)`.
2. The task passes the binary gate and the rubric judge.
3. `mark-done.ts` runs. The regex at `:41` misses, so the status is never flipped.
   **The checkbox loop at `:48-50` still runs**, because it is independent of the status
   match. The file ends up half-finalized: every gate checkbox ticked, status still
   `in-progress`. Exit code `0`, no stdout, no stderr.
4. The orchestrator appends the task to `completed`. It gates on the judge verdict and
   never re-reads the file.
5. The next wave calls `next-ready.ts`. `extractStatus` returns `null`, so
   `next-ready.ts:101` (`task.status !== "todo"`) skips the task itself, and
   `next-ready.ts:104` (`upstream?.status === "done"`) holds back every dependent.
6. The ready set is `[]`. The wave loop hits `if (fresh.length === 0) break` and returns
   `escalations: []`.

Step 3 is the deceptive part. A half-finalized file reads as finished at a glance.

## Evidence

Both cases come from one plan, `herdr-workbench` `docs/rust-rewrite` (31 tasks).

| Task | Status line written by the dev agent | Score | Stranded |
|---|---|---|---|
| `picker/01` | `in-progress (retry 3: 3.9 ms median, measured by \`scripts/bench-project-source.zsh\`)` | 4.86 pass | `picker/02`, `polish/04` |
| `cutover/01` | `in-progress (attempt 3)` | 5.00 pass | `cutover/02`, `cutover/03` (the Final review) |

Reproduce the half-finalized state from that repo's history:

```zsh
git show 0b96d52:docs/rust-rewrite/tasks/cutover/01-manifest-flip.md | rg -c '^- \[x\]'
# 19
git show 0b96d52:docs/rust-rewrite/tasks/cutover/01-manifest-flip.md | rg '^> \*\*Status\*\*'
# > **Status**: in-progress (attempt 3)
```

Nineteen ticked boxes, status never flipped.

The `cutover/01` case cost a whole extra autopilot run. It stranded `cutover/03`, the
Final review, so the closing cross-vendor gate never ran.

## Related: agents decorate task headers freely

The same run produced `> **Retry attempt**: 2` in
`docs/rust-rewrite/tasks/agent/05-dashboard.md`. That one is harmless — it sits on its
own line, so the `Status` line still parses. It is the same impulse, one line away from
the same outcome.

Nothing currently tells a dev agent that the Status line takes exactly one word.
`autopilot`'s dev prompt says only: *set the task header `> **Status**:` to in-progress*.

## Proposed fix

Recommended: **A + E**, then the prompt sentence below. Read **C** first — it explains
why the obvious "add a lint check" answer does not work here.

A turns silent into loud, on the one path every task must cross. E removes the duplicated
rule that let the two copies drift apart.

### A. Make `mark-done.ts` fail loudly (minimum viable fix)

Exit non-zero when no Status line matched. Name the offending line in the message.
Also skip the checkbox pass in that case, so a failed run never leaves a half-finalized
file.

```
mark-done error: Status line did not parse — the value must be a single word.
  docs/…/cutover/01-manifest-flip.md:9
  > **Status**: in-progress (attempt 3)
                            ^^^^^^^^^^^ remove this
```

Add a case to `mark-done.test.ts`.

### B. Make `mark-done.ts` tolerant

Accept a decorated line, take the first word, and rewrite the whole line to a bare
`done`. Rejected as the primary fix: it silently discards text an agent wrote, and it
hides the underlying agent behaviour instead of correcting it.

### C. Reach the edits the lint hook cannot see

**The detector already exists and already works.** `lint-task.ts:79` pushes a `status`
diagnostic when `task.status === null`, and the run exits 1. Verified against the real
`cutover/01` file:

```
$ bun lint-task.ts <the decorated task file>
… [status] Status missing or not one of todo/in-progress/done/blocked
1 violation(s) in 1 file(s).      # exit 1
```

`hooks/flightplan-lint.sh` wires that up correctly too: it filters on path and on the
`> **Required reading**:` marker, both of which the failing files satisfied, then exits 2
to surface the violation to the LLM.

**So why did nothing fire?** The hook is a `PostToolUse` hook. It reads
`.tool_input.file_path` (`flightplan-lint.sh:19`), so it only ever sees **Claude's own
Write/Edit calls**. The run that produced both failures used `CFG.devEngine: 'codex'`.
Codex edits the working tree from its own subprocess, and those writes never pass
through a Claude tool call. The hook is structurally blind to them.

That blind spot covers every external dev engine — `codex` and `opencode` alike.

The fix is therefore **not** a new check. It is running the existing check somewhere that
always executes:

- Have `mark-done.ts` call the shared parser and refuse to proceed on a `null` status
  (this is option A, and it is the same detection).
- Or have the external-engine dev prompt run `lint-task.ts` on the task file after the
  CLI returns, alongside the `## Verification` commands it already re-runs.

Prefer the first. It sits on the one code path every task must cross to be marked done.

### D. Assert after `mark-done`, orchestrator-side

Re-read the file after `mark-done.ts` and confirm `Status: done`. Treat a mismatch as a
failed attempt. Defense in depth, but it lives in the orchestrator script that each
autopilot run regenerates, so it is the easiest of these to lose.

### E. Delete the duplicated regex

`mark-done.ts` carries its own copy of the Status pattern. Have it use the parser in
`lib/parse-task.ts` instead. Two copies of one rule is how they drift.

## Also worth fixing: tell the agents the rule

Add one sentence to `autopilot`'s dev prompt and to the flightplan task template: the
Status line holds exactly one of `todo`, `in-progress`, `done`, `blocked`, and nothing
else. Put any note on its own line.

This is the cheapest change here, and it addresses the cause rather than the symptom.

## Files to touch

- `packages/dispatch/skills/flightplan/scripts/mark-done.ts` — A, E
- `packages/dispatch/skills/flightplan/scripts/mark-done.test.ts` — A
- `packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts` — E (the parser to reuse)
- `packages/dispatch/skills/autopilot/references/orchestrator.md` — D, and both dev-prompt sentences
- `packages/dispatch/skills/flightplan/SKILL.md` — the task-template sentence

No change needed in `packages/dispatch/hooks/flightplan-lint.sh`. It works; it just
cannot see an external engine's writes.

## How to verify a fix

1. Build a two-task fixture tree where task B depends on task A.
2. Write `> **Status**: in-progress (attempt 2)` into task A.
3. Run `mark-done.ts` on task A. Expect a non-zero exit and a message naming the line.
4. Confirm task A's checkboxes are untouched.
5. Fix the line to a bare `in-progress`, re-run, then confirm `next-ready.ts` offers B.
