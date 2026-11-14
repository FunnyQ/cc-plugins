# Goal mode: commands for each step

Follow this file for every step of `SKILL.md` → "Goal mode". Goal mode is Claude Code only.

## Names

- `$SCRIPTS` and `$OWN`: the paths Step 1 resolved.
- `$WAYPOINTS`: `<base>/../waypoints/scripts`, absolute.
- `<root>`, `<slug>`, `<plan dir>`, `<PLAN.md>`, `<tasks dir>`, `<log>`: the values baked into `CFG` as `repoRoot`, `slug`, `planDir`, `planPath`, `tasksDir`, `logFile`.
- `<proj>`, `<leg>`: the `proj` and `slug` that `legOf(<PLAN.md>)` returns, for a waypoints leg only.
- `<round>`: the repair round in this flight. Start at 1, and add 1 after each re-launch.
- `<ref-slug>`: the ref with `/` replaced by `-`, such as `ui-01`. Use `flight` for a `--flight` record and `tree` for `(tree)`.
- `<scratch>`: `<plan dir>/.flightlog/repair/<round>-<ref-slug>`. Create `<plan dir>/.flightlog/repair/` when it is absent. The `.flightlog/` self-ignore keeps every file there out of git and out of the guard.

## 1. Start the flight and set the goal

Run this once, after the user's go and before the first launch:

```bash
bun $SCRIPTS/flightlog.ts flight-start <log> --plan <PLAN.md> --tasks <tasks dir>
```

It prints a JSON array of the escalations it adopted. Every task already `blocked` when the flight starts becomes an escalation of this flight, keeping the `class` and `reason` of its last `capped` or `plan-defect` escalation in the trail, or `plan-defect` with a placeholder reason when the trail has none. Those tasks are repairable under the same budget as any other.

`flight-start` needs a clean working tree: it refuses, exits non-zero and writes no flight entry when `git status --porcelain` at the repo root lists any path outside `<plan dir>/.flightlog/`, because the checkpoint commit in step 5.1 would otherwise sweep the user's own uncommitted work into a `chore(autopilot)` commit. When it refuses, show the user the listed paths, tell them to commit or stash those changes first, and run `flight-start` again once they have. Do not stash or commit on their behalf.

Show the user this line, filled in, and ask them to type it:

```text
/goal The autopilot flight for docs/<slug> has ended: the last line of the latest turn reads "repairs --status: complete" or "repairs --status: exhausted", and that turn printed the path of <plan dir>/.flightlog/FLIGHTREPORT.md.
```

When `<PLAN.md>` is a waypoints leg, `docs/<proj>/legs/<leg>/PLAN.md` (`legOf` in `$WAYPOINTS/deferred.ts` returns non-null), offer the leg goal beside the flight goal and let the user pick one. The leg goal runs step 8 after a `complete` flight: it works through the owed `(human)` checks, fixes what they find, and advances the roadmap.

```text
/goal The autopilot leg docs/<proj>/legs/<leg> has ended: the last line of the latest turn reads "leg-close: closed", "leg-close: open", or "repairs --status: exhausted", and that turn printed the path of <plan dir>/.flightlog/FLIGHTREPORT.md.
```

Keep the condition a description of a state, never an imperative. Do not set the goal through a tool: `/goal` is a session Stop hook the user sets, and a model-proposed goal is unverified. Launch only after the user has set it.

When `flight-start` printed `[]`, launch. Otherwise review the adopted escalations before the first launch, as round 1: go to step 3, and treat the printed array as the escalations step 4 sorts. Step 6 then makes the first launch. Reviewing them first keeps a single procedure: every escalation the reviewer sees is a stop already in the trail, and no launch spends attempts on a tree whose plan defects are known.

## 2. Check the trail

When the Workflow call throws or returns no result, the trail holds no run-end for it. Treat it as an infrastructure stop for the whole round: write `Workflow returned no result` to `<plan dir>/.flightlog/repair/<round>-flight.reason.md`, record `infra-retry` with `--flight` as step 4 shows, and re-launch with no edit and the same `CFG`. When `repair` answers `record halt instead`, the Workflow has failed twice: record `halt` with `--flight`, tell the user the Workflow returned no result twice, ask them to type `/goal clear`, and go to step 7.

When the Workflow result has `logFailed: true`, stop the loop. Tell the user the trail is missing this run's stops, so the goal cannot end on its own, and ask them to type `/goal clear`. End the turn with `repairs --status: unknown (trail incomplete)`.

Whenever you stop the loop before step 7 prints its outcome, such as here or at step 5.1, ask the user to type `/goal clear`.

## 3. Read the status

```bash
bun $SCRIPTS/flightlog.ts repairs <log> --tasks <tasks dir> --status
```

On `complete` or `exhausted`, go to step 7. On `continue`, go to step 4. An unparseable or invalid task file reads `exhausted`, with the files named on stderr; name them in the report.

## 4. Sort the escalations

Sort by `class` first. Apply the `parked: false` row only to a task ref whose class is `plan-defect`, `capped`, or `infrastructure`; every `stall` and `budget-floor` escalation reads `parked: false` and still follows its class row.

| `class`, or result field                                               | Action                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `budget-floor`, `divergence`, a leak abort, `drained` refs             | Record `halt` with `--flight`, then go to step 7 at once.                                                    |
| `stall` (ref `(tree)`)                                                 | Record `halt` with `--task "(tree)"`, then go to step 7 at once. `repairs --status` reads it as `exhausted`. |
| `plan-defect`, `capped`                                                | Run step 5.                                                                                                  |
| `infrastructure`                                                       | Record `infra-retry` for the task, then reset its Status to `todo` in step 6. Re-launch with no edit.        |
| `parked: false` on a `plan-defect`, `capped`, or `infrastructure` task | Reset the Status to `todo` first, as Escalation says, then treat the escalation as `infrastructure`.         |

A `divergence` halts the flight because its refs passed and landed, and a re-launch would fly them again over their own uncommitted work; a person decides each ref's Status, as Escalation says. A `halt` on any synthetic ref, such as `(scout)`, `(worktree)` or `(commit)` after a second infrastructure stop, also reads `exhausted`, because a synthetic ref has no Status a re-launch could change.

Record each `infra-retry` or `halt` before acting on it. Write the escalation's `reason` to `<scratch>.reason.md`, then run:

```bash
bun $SCRIPTS/flightlog.ts repair <log> --task <ref> --verdict infra-retry|halt --reason-file <scratch>.reason.md
bun $SCRIPTS/flightlog.ts repair <log> --flight --verdict halt --reason-file <scratch>.reason.md
```

When `repair` exits 1 and names another verdict, such as `record halt instead`, record that verdict.

## 5. Run each repair reviewer

Handle one `plan-defect` or `capped` escalation at a time. Finish its guard, record, and commit before you spawn the next reviewer.

0. Check the budget before you spawn:
   ```bash
   bun $SCRIPTS/flightlog.ts repairs <log> --tasks <tasks dir> --json
   ```
   When `flight` is 10 or more, write `flight repair budget spent before review` to `<scratch>.reason.md`, record `halt` for the ref, and go to step 3. When `byTask` holds 3 or more for the ref, write `task repair budget spent before review` to `<scratch>.reason.md`, record `refuse` for the ref, and go to the next escalation. These are the verdicts `repair` itself redirects a counted verdict to, so no reviewer is spent on a repair that could never be recorded.
1. Checkpoint the tree, once per round, before the first reviewer:
   - **Mixed tree, no save.** When `failedInMainTree` is not empty and either `CFG.commitBetweenWaves` is `false` or the result's `escalations` hold one for `(commit)`, the tree still holds this run's gated, uncommitted work beside the ungated fixer edits, and a restore would revert the gated code while the `done` Status lines survive. Save nothing and restore nothing. Write `gated and ungated changes are mixed in the main tree (commitBetweenWaves false or a (commit) failure)` to `<plan dir>/.flightlog/repair/<round>-flight.reason.md`, record `halt` with `--flight` as step 4 shows, tell the user the tree needs a person, ask them to type `/goal clear`, and go to step 7.
   - Otherwise, when the Workflow result's `failedInMainTree` is not empty, a failed Final review's fixer left ungated edits in the main tree, which the orchestrator kept out of history. Save them as a commit object first, without touching the real index or the stash:
     ```bash
     idx=$(mktemp -d)/index
     GIT_INDEX_FILE=$idx git -C <root> read-tree HEAD
     GIT_INDEX_FILE=$idx git -C <root> add -A
     tree=$(GIT_INDEX_FILE=$idx git -C <root> write-tree)
     commit=$(git -C <root> commit-tree "$tree" -p HEAD -m "autopilot: ungated tree before repair round <round>")
     git -C <root> update-ref refs/autopilot/ungated/<slug>/<round> "$commit" ""
     ```
     When `update-ref` fails because the ref exists, an earlier flight saved one there: append `-2`, `-3`, and so on to the ref name until it succeeds. Then restore every path `git -C <root> status --porcelain` lists outside `<plan dir>`, as **Restore the tree** below says, and name the ref in the trail, so the flight report lists it:
     ```bash
     bun $SCRIPTS/flightlog.ts log <log> --task "(flight)" --role ungated --message "refs/autopilot/ungated/<slug>/<round> holds the failed Final review edits of <failedInMainTree refs>"
     ```
   - Run `git -C <root> status --porcelain`. When it lists anything, including the Workflow's post-loop state, commit those paths with `git add` and `git commit -m "chore(autopilot): checkpoint before plan repair"`. Commit even when `CFG.commitBetweenWaves` is `false`, and say so in the report: the guard compares against HEAD and rejects any uncommitted change anywhere in the repo. When it still lists anything, stop and report.
2. Render the run log: `bun $SCRIPTS/flightlog.ts report <log>`.
3. List the kept worktrees without removing any:
   ```bash
   bun $SCRIPTS/worktree.ts sweep --keep-all --repo <root> --slug <slug> --plan-dir <plan dir>
   ```
   It prints `{ removed: [], kept: [{ ref, path }] }`. Join the `kept` refs with `,` as `<kept refs>`, or use `""` when none is kept.
4. Spawn the reviewer as `references/repair.md` says. Fill `{{kept}}` with that ref's `path`, or `none`. Fill `{{verdict_file}}` with `<scratch>.json`.
5. When the verdict file is missing or does not parse as JSON, write `reviewer wrote no readable verdict` to `<scratch>.reason.md`, restore the tree, and record `refuse`. Otherwise write its `note` to `<scratch>.reason.md`:
   ```bash
   bun -e 'const v = await Bun.file(process.argv[1]).json(); await Bun.write(process.argv[2], v.note)' <scratch>.json <scratch>.reason.md
   ```
6. On `refuse`, restore the tree, record `refuse`, and go to the next escalation.
7. On `fix` or `defer`, run the guard with the verdict file as the justification:
   ```bash
   bun $SCRIPTS/flightlog.ts guard <log> --plan <PLAN.md> --tasks <tasks dir> --verdict fix|defer --justified <scratch>.json --kept <kept refs>
   ```
   On `not-plan`, run the guard with `--verdict fix` and an empty justification, so a not-plan note can never carry a gate edit:
   ```bash
   echo '[]' > <scratch>.empty.json
   bun $SCRIPTS/flightlog.ts guard <log> --plan <PLAN.md> --tasks <tasks dir> --verdict fix --justified <scratch>.empty.json --kept <kept refs>
   ```
   Keep the guard's printed `reentry` map as `<guard reentry JSON>`.
8. When the guard exits 1, append its `violations` to `<scratch>.reason.md`, restore the tree, and record `refuse`.
9. When the guard passes, lint the tree:
   ```bash
   bun $SCRIPTS/lint-task.ts <tasks dir>
   ```
   When it exits non-zero, append its output to `<scratch>.reason.md`, restore the tree, and record `refuse`.
10. When the lint passes, save the task diff, then record the verdict with the guard's `reentry` map. `repair` reads `pattern` and `changed` from the verdict file itself, so no reviewer-written text passes through the shell:
    ```bash
    git -C <root> diff HEAD -- <tasks dir> > <scratch>.diff
    bun $SCRIPTS/flightlog.ts repair <log> --task <ref> --verdict fix|defer|not-plan --reason-file <scratch>.reason.md --verdict-file <scratch>.json --reentry '<guard reentry JSON>' --diff-file <scratch>.diff
    ```
11. On `defer`, append the verdict's `defer` list to `<plan dir>/DEFERRED.md`:
    ```bash
    bun -e 'const [mod, plan, verdict, out] = process.argv.slice(1); const { appendDeferred, legOf } = await import(mod); const v = await Bun.file(verdict).json(); const f = Bun.file(out); const date = new Date().toLocaleDateString("sv"); await Bun.write(out, appendDeferred((await f.exists()) ? await f.text() : null, legOf(plan).slug, v.defer.map((d) => ({ criterion: d.criterion, from: d.task, date, why: d.why }))));' $WAYPOINTS/deferred.ts <PLAN.md> <scratch>.json <plan dir>/DEFERRED.md
    ```
12. Write the commit message to a file, stage the changed task files, and `DEFERRED.md` on `defer`, then commit with that file:
    ```bash
    bun -e 'const [verdict, ref, out] = process.argv.slice(1); const v = await Bun.file(verdict).json(); await Bun.write(out, v.verdict === "not-plan" ? `plan repair: not-plan note for ${ref}\n` : `plan repair: ${v.pattern}\n`)' <scratch>.json <ref> <scratch>.msg
    git -C <root> add -- <tasks dir>
    git -C <root> commit -F <scratch>.msg
    ```
    On `defer`, add `<plan dir>/DEFERRED.md` to the `git add` line.

**Restore the tree** by restoring every path `git -C <root> status --porcelain` lists: run `git show HEAD:<path> > <path>` for a tracked file, and `trash` an untracked one. Run it before every `refuse`, so a refused or failed reviewer's edits never reach the next checkpoint commit.

Record `refuse` with the same command as step 4, using `--verdict refuse`. Never decide or amend a verdict yourself.

## 6. Re-launch

0. When the Workflow result's `failedInMainTree` is not empty and step 5.1's save has not run this round, because no reviewer ran, run its save and restore now, under the same mixed-tree rule, so that no re-launch starts with ungated fixer edits uncommitted.
1. Set `Status: todo` on every task this round recorded as `fix`, `defer`, `not-plan`, or `infra-retry`, and on every `blocked` task named in a `changed` list. Commit the Status edits with `git commit -m "plan repair: reset <refs> to todo"`.
2. Build `CFG.reentry` from three sources:
   - this round's guard `reentry` maps;
   - `dev` for each ref this round recorded as `fix`, `defer`, `not-plan`, or `infra-retry` that no guard map names, such as an escalated task whose repair edited only a sibling's `Depends on`;
   - each entry of the `CFG.reentry` you baked for the last launch whose task still reads `todo`, because it never became ready in that run and still needs its attempt seed and kept worktree.

   When a ref appears more than once, use `dev` if any entry says `dev`. For each ref, run `bun $SCRIPTS/flightlog.ts progress <log> --task <ref> --json` and take its `attempt`. Omit a ref with no recorded attempts, since it starts fresh. Write each entry as `{ "<ref>": { "from": "dev" | "verify", "attempt": N } }`.

3. Set `CFG.deferredScope` as `SKILL.md` Step 3 says.
4. Bake with every other `CFG` value unchanged, launch the Workflow, and go to step 2 when it returns. Add 1 to `<round>`.

## 7. Report

```bash
bun $SCRIPTS/flightlog.ts report <log> --flight --deferred <plan dir>/DEFERRED.md
bun $SCRIPTS/flightlog.ts repairs <log> --tasks <tasks dir> --status
```

The first command writes `<plan dir>/.flightlog/FLIGHTREPORT.md` and prints its path. Print the outcome the second command prints now, not one read earlier in the turn, and that path. Then report as Step 4 says.

Under the leg goal, go to step 8 when the outcome is `complete`. On `exhausted`, stop here: the leg stays active.

## 8. Close the leg (leg goal only)

The typed leg goal pre-approves three things: running the owed checks, fixing the code they find broken, and confirming the drafted `advance` outcome. It approves nothing that costs money or changes what a user sees beyond what the plan specifies; ask for those as [Reporting while the goal runs](#reporting-while-the-goal-runs) says, and leave the check `owed` until the user answers.

1. Read the `## Needs a person` checklist in `FLIGHTREPORT.md`. Number its items in order as `<n>`.
2. For each item, try to perform it with the tools you have: a browser skill, the dev server, a command. Write what you did and what you saw to `<plan dir>/.flightlog/after-run/<n>-<ref-slug>.md`, ending with one verdict: `PASS`, `FAIL`, or `OWED` when no tool reaches it. Log it:
   ```bash
   bun $SCRIPTS/flightlog.ts log <log> --task <ref> --role after-run --message "<PASS|FAIL|OWED> — <n>: <one line>"
   ```
3. On `FAIL`, fix the code in the main tree. Then run every Verification command of the item's task, and of the Final review task, from `<root>`. When they pass and the check passes again, commit the fix and its evidence file with `git commit -m "fix(after-run): <one line>"`, and log `FIXED — <n>: <one line>` as step 2 shows. When the fix still fails after 2 tries, restore the tree as **Restore the tree** says, log `FAIL`, and go to step 5 without advancing.
4. Advance the roadmap. Run `bun $WAYPOINTS/waypoints.ts advance <proj>` to print the drafted outcome, then write it:
   ```bash
   bun $WAYPOINTS/waypoints.ts advance <proj> --outcome "<drafted outcome> · after-run: <fixed> fixed, <owed> owed"
   git -C <root> add docs/<proj>/WAYPOINTS.md
   git -C <root> commit -m "docs(waypoints): land <leg>"
   ```
   It promotes the next leg to `[~]` and plans nothing; the next leg still needs its own flightplan run.
5. Print the `OWED` and unfixed `FAIL` items as a checklist the user still owes, each with its evidence path. End the turn with `leg-close: closed` after step 4 ran, or `leg-close: open` when step 3 stopped it.

Post-flight fixes pass through no judge and no rubric, only the Verification commands step 3 re-runs. Say so in the report and name every `fix(after-run)` commit.

## Reporting while the goal runs

Write to the user only when the loop needs them: a halt, a `/goal clear` request, a refused or failed fix in step 8, or a decision the goal does not cover. Name a decision the goal does not cover when it costs money, such as a paid API call, or changes behavior a user sees beyond what the plan specifies. A plan defect the repair reviewer fixed is not a problem: the trail and `FLIGHTREPORT.md` carry it, so report nothing for it between launches.

## Every goal-mode turn

End every goal-mode turn with the line `repairs --status: <status>`, holding the latest `repairs --status` output. Under the leg goal, once step 8 has started, end it with the `leg-close:` line instead. The `/goal` evaluator judges from the transcript, never the filesystem, and a continuation turn arrives as "Stop hook feedback". A turn that does not print the line cannot end the goal.

## Measured on Claude Code

- Workflow agents receive no user message, on the goal-setting turn or on a `/goal` continuation turn. Each gets only the task the script computes, framed as carrying no user authority. The goal text therefore never reaches a dev or verifier.
- The `/goal` evaluator reads the transcript, not the filesystem.
- Only the user sets `/goal`, by typing it. Whether the model can propose one through a tool is unverified.
