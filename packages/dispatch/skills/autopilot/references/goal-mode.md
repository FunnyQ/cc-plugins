# Goal mode: commands for each step

Follow this file for every step of `SKILL.md` → "Goal mode". Goal mode is Claude Code only.

## Names

- `$SCRIPTS` and `$OWN`: the paths Step 1 resolved.
- `$WAYPOINTS`: `<base>/../waypoints/scripts`, absolute.
- `<root>`, `<slug>`, `<plan dir>`, `<PLAN.md>`, `<tasks dir>`, `<log>`: the values baked into `CFG` as `repoRoot`, `slug`, `planDir`, `planPath`, `tasksDir`, `logFile`.
- `<round>`: the repair round in this flight. Start at 1, and add 1 after each re-launch.
- `<ref-slug>`: the ref with `/` replaced by `-`, such as `ui-01`. Use `flight` for a `--flight` record and `tree` for `(tree)`.
- `<scratch>`: `<plan dir>/.flightlog/repair/<round>-<ref-slug>`. Create `<plan dir>/.flightlog/repair/` when it is absent. The `.flightlog/` self-ignore keeps every file there out of git and out of the guard.

## 1. Start the flight and set the goal

Run this once, after the user's go and before the first launch:

```bash
bun $SCRIPTS/flightlog.ts flight-start <log> --plan <PLAN.md>
```

Show the user this line, filled in, and ask them to type it:

```text
/goal The autopilot flight for docs/<slug> has ended: the last line of the latest turn reads "repairs --status: complete" or "repairs --status: exhausted", and that turn printed the path of <plan dir>/.flightlog/FLIGHTREPORT.md.
```

Keep the condition a description of a state, never an imperative. Do not set the goal through a tool: `/goal` is a session Stop hook the user sets, and a model-proposed goal is unverified. Launch only after the user has set it.

## 2. Check the trail

When the Workflow result has `logFailed: true`, stop the loop. Tell the user the trail is missing this run's stops, so the goal cannot end on its own, and ask them to type `/goal clear`. End the turn with `repairs --status: unknown (trail incomplete)`.

Whenever you stop the loop before step 7 prints its outcome, such as here or at step 5.1, ask the user to type `/goal clear`.

## 3. Read the status

```bash
bun $SCRIPTS/flightlog.ts repairs <log> --tasks <tasks dir> --status
```

On `complete` or `exhausted`, go to step 7. On `continue`, go to step 4.

## 4. Sort the escalations

Sort by `class` first. Apply the `parked: false` row only to a task ref whose class is `plan-defect`, `capped`, or `infrastructure`; every `stall` and `budget-floor` escalation reads `parked: false` and still follows its class row.

| `class`, or result field                                               | Action                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `budget-floor`, a leak abort, `drained` refs                           | Record `halt` with `--flight`, then go to step 7 at once.                                                    |
| `stall` (ref `(tree)`)                                                 | Record `halt` with `--task "(tree)"`, then go to step 7 at once. `repairs --status` reads it as `exhausted`. |
| `divergence`                                                           | Record `halt` for the ref. Keep repairing the other tasks.                                                   |
| `plan-defect`, `capped`                                                | Run step 5.                                                                                                  |
| `infrastructure`                                                       | Record `infra-retry` for the task, then reset its Status to `todo` in step 6. Re-launch with no edit.        |
| `parked: false` on a `plan-defect`, `capped`, or `infrastructure` task | Reset the Status to `todo` first, as Escalation says, then treat the escalation as `infrastructure`.         |

A task already `blocked` when the flight started gets no escalation in it, so `repairs --status` treats it as stopped and never offers it for repair. To repair it, reset its Status to `todo` before step 1.

Record each `infra-retry` or `halt` before acting on it. Write the escalation's `reason` to `<scratch>.reason.md`, then run:

```bash
bun $SCRIPTS/flightlog.ts repair <log> --task <ref> --verdict infra-retry|halt --reason-file <scratch>.reason.md
bun $SCRIPTS/flightlog.ts repair <log> --flight --verdict halt --reason-file <scratch>.reason.md
```

When `repair` exits 1 and names another verdict, such as `record halt instead`, record that verdict.

## 5. Run each repair reviewer

Handle one `plan-defect` or `capped` escalation at a time. Finish its guard, record, and commit before you spawn the next reviewer.

1. Run `git -C <root> status --porcelain`. When it lists anything, including the Workflow's post-loop state, commit those paths with `git add` and `git commit -m "chore(autopilot): checkpoint before plan repair"`. When it still lists anything, stop and report: the guard compares against HEAD and rejects any uncommitted change anywhere in the repo.
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
8. When the guard exits 1, append its `violations` to `<scratch>.reason.md`, restore the tree, and record `refuse`.
9. When the guard passes, lint the tree:
   ```bash
   bun $SCRIPTS/lint-task.ts <tasks dir>
   ```
   When it exits non-zero, append its output to `<scratch>.reason.md`, restore the tree, and record `refuse`.
10. When the lint passes, save its `reentry` map and the task diff, then record the verdict:

```bash
git -C <root> diff HEAD -- <tasks dir> > <scratch>.diff
bun $SCRIPTS/flightlog.ts repair <log> --task <ref> --verdict fix|defer|not-plan --reason-file <scratch>.reason.md --pattern "<pattern>" --changed <changed refs> --reentry '<guard reentry JSON>' --diff-file <scratch>.diff
```

11. On `defer`, append the verdict's `defer` list to `<plan dir>/DEFERRED.md`:
    ```bash
    bun -e 'const [mod, plan, verdict, out] = process.argv.slice(1); const { appendDeferred, legOf } = await import(mod); const v = await Bun.file(verdict).json(); const f = Bun.file(out); const date = new Date().toLocaleDateString("sv"); await Bun.write(out, appendDeferred((await f.exists()) ? await f.text() : null, legOf(plan).slug, v.defer.map((d) => ({ criterion: d.criterion, from: d.task, date, why: d.why }))));' $WAYPOINTS/deferred.ts <PLAN.md> <scratch>.json <plan dir>/DEFERRED.md
    ```
12. Commit the changed task files, and `DEFERRED.md` on `defer`, with `git commit -m "plan repair: <pattern>"`. On `not-plan`, use `plan repair: not-plan note for <ref>`.

**Restore the tree** by restoring every path `git -C <root> status --porcelain` lists: run `git show HEAD:<path> > <path>` for a tracked file, and `trash` an untracked one. Run it before every `refuse`, so a refused or failed reviewer's edits never reach the next checkpoint commit.

Record `refuse` with the same command as step 4, using `--verdict refuse`. Never decide or amend a verdict yourself.

## 6. Re-launch

1. Set `Status: todo` on every task this round recorded as `fix`, `defer`, `not-plan`, or `infra-retry`, and on every `blocked` task named in a `changed` list. Commit the Status edits with `git commit -m "plan repair: reset <refs> to todo"`.
2. Build `CFG.reentry` from this round's guard `reentry` maps, plus `dev` for each ref this round recorded as `infra-retry`. When a ref appears more than once, use `dev` if any entry says `dev`. For each ref, run `bun $SCRIPTS/flightlog.ts progress <log> --task <ref> --json` and take its `attempt`. Omit a ref with no recorded attempts, since it starts fresh. Write each entry as `{ "<ref>": { "from": "dev" | "verify", "attempt": N } }`.
3. When `<plan dir>/DEFERRED.md` exists, set `CFG.deferredScope` to its contents.
4. Bake with every other `CFG` value unchanged, launch the Workflow, and go to step 2 when it returns. Add 1 to `<round>`.

## 7. Report

```bash
bun $SCRIPTS/flightlog.ts report <log> --flight --deferred <plan dir>/DEFERRED.md
```

It writes `<plan dir>/.flightlog/FLIGHTREPORT.md` and prints its path. Print the outcome, `complete` or `exhausted`, and that path. Then report as Step 4 says.

## Every goal-mode turn

End every goal-mode turn with the line `repairs --status: <status>`, holding the latest `repairs --status` output. The `/goal` evaluator judges from the transcript, never the filesystem, and a continuation turn arrives as "Stop hook feedback". A turn that does not print the line cannot end the goal.

## Measured on Claude Code

- Workflow agents receive no user message, on the goal-setting turn or on a `/goal` continuation turn. Each gets only the task the script computes, framed as carrying no user authority. The goal text therefore never reaches a dev or verifier.
- The `/goal` evaluator reads the transcript, not the filesystem.
- Only the user sets `/goal`, by typing it. Whether the model can propose one through a tool is unverified.
