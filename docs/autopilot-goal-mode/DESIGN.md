# Autopilot goal mode: self-repairing flight until the tree completes

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-11-14

## Intent

Today an autopilot flight stops at the first problem only a person can fix. A plan defect parks its task at once, and a task that runs out of `maxAttempts` parks too. The run then returns escalations and waits for a person.

Q's experience across many flights is that both kinds of stop usually come from the plan, not the code. Typical causes are a Verification command no implementation can pass, an unreasonable judge criterion, or a task order that makes a gate impossible. After a small plan adjustment, the flight continues and still delivers every goal and feature.

Goal mode lets the main agent make those adjustments itself and keep flying until the tree is complete. The user opts in at the final confirmation, and Claude Code's `/goal` holds the session open until the flight is done.

## Goals

- Add a flight-mode choice to autopilot Step 2. **Standard** behaves exactly as today. **Goal mode** self-repairs until completion.
- In goal mode, the main agent handles every escalation the Workflow returns. Plan defects and capped tasks get a plan repair, and the flight re-launches.
- Repairs may change: test specs that cannot pass, Verification commands that cannot pass, judge or Acceptance criteria that cannot be met as written, and task order or `Depends on` edges that cause any of these.
- Every repair is approved by an independent reviewer before it is applied.
- A repair budget bounds the loop, so a flight that cannot be repaired stops and reports.
- In a waypoints leg, a criterion may be deferred to a later leg, but only when the reviewer finds no way to satisfy it in the current leg.
- The final report lists every error event and every repair.

## Non-goals

- Repair logic in the orchestrator Workflow script (`references/orchestrator.md`). Repairs happen in the main conversation, after the Workflow returns. The orchestrator gains three small changes (section 4b), approved by Q.
- Goal mode on Codex or OpenCode. `/goal` is a Claude Code feature, so Step 2 does not offer the option on those harnesses.
- Repairing code. The dev, verifier, and judge loop inside the Workflow still owns the code.
- Auto-advancing a waypoints leg. `waypoints.ts advance` stays a human gate (`waypoints/SKILL.md:86`).

## Anti-goals

Any of these makes the feature a failure, even if every task reads `done`:

- A gate is weakened until the task passes, and the work no longer delivers what the plan asked for.
- The PLAN.md goal is changed, or a feature defined in PLAN.md is dropped from the flight without being deferred and reported.
- The loop spends without bound because the goal condition has no exit.
- A deferral or a gate change goes into the tree silently, with no line in the final report.

## Constraints

- **Leak check.** The orchestrator aborts the run when the main tree changes outside a land (`SKILL.md:231`). Therefore no task file may be edited while a Workflow runs. Every repair happens between Workflow runs.
- **No relayed user message (measured).** An earlier runtime relayed the user's latest message verbatim to every Workflow agent. Measured on Claude Code, Workflow agents now receive no user message, on the goal-setting turn or on a `/goal` continuation turn, so the goal text never reaches them (see Open risk). Write the goal condition as a description of a state anyway.
- **Carve-outs stay human-only.** A repair may never add a `(human)` tag or write an attestation file (`SKILL.md:293`). Those carve-outs are declared by a person.
- **Leg scaffolding.** `waypoints.ts leg-scaffold` creates the leg directory non-recursively and throws when the directory exists (`flightplan/references/waypoint-mode.md:33`). A deferral therefore cannot pre-create the next leg's directory, so deferred items live in the current leg's directory.
- **Version policy.** This changes the dispatch plugin only. Bump dispatch's two `plugin.json` files at release.

## Approaches

1. **Repair loop in the main conversation (picked).** The orchestrator is unchanged. After the Workflow returns escalations, the main agent runs the repair reviewer, applies the approved edits, records them, and re-launches the flight. This avoids the leak check, keeps resume semantics intact, and leaves the Codex wave loop untouched. The cost is one new Workflow launch (scout and bake) per repair round.
2. **Repair inside the orchestrator (rejected).** The orchestrator would call a repair agent instead of parking. It needs no re-launch, but editing a task file mid-run trips the leak check. It would need a leak-check exception, which is where a bug would hide, and a second copy in `references/codex.md`.

Q picked approach 1.

## Design

### 1. Step 2: the flight-mode question

Add **Flight mode** to the first `AskUserQuestion` call, as its fourth question. This uses the last slot under the four-question cap.

- **Standard (Recommended)**: park and report, as today.
- **Goal mode**: self-repair plan defects and capped tasks until the tree completes, within the repair budget.

Offer this question only under Claude Code. In goal mode, the one-screen brief also states the repair budget, the repair rules below, and that gate edits are possible and will be reported.

### 2. Setting the goal

After the user's explicit go and before the first Workflow launch, the main agent shows the user the exact `/goal` line to type. `/goal` is a session Stop hook that only the user sets; whether the model can propose one through a tool is unverified. The evaluator judges from the transcript, so the condition names what the transcript shows, and describes a state with two exits:

```text
/goal The autopilot flight for docs/<slug> has ended: the last line of the latest turn reads "repairs --status: complete" or "repairs --status: exhausted", and that turn printed the path of <plan dir>/.flightlog/FLIGHTREPORT.md.
```

The main agent ends every goal-mode turn with `repairs --status: <status>`, the latest `flightlog.ts repairs <run.jsonl> --tasks <dir> --status` output.

`complete` means every task is `done`. `exhausted` means the repair budget ran out, a task hit a non-repairable stop, or every remaining escalation was refused by the reviewer. Both exits end the goal.

### 3. The repair loop

After each Workflow return, the main agent sorts the escalations:

| Escalation                                                                             | Action                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan defect (`PLAN DEFECT reported by …`)                                              | Run the repair reviewer.                                                                                                                       |
| Capped (`maxAttempts` or `finalReviewMaxAttempts`)                                     | Run the repair reviewer. Point it at the Verification and judge criteria first, since Q's experience says the cause is usually there.          |
| Infrastructure (`infrastructure: true`), including `(scout)`, `(worktree)`, `(commit)` | Re-launch once with no edit (`infra-retry`). A second infrastructure stop on the same task is recorded `halt`.                                 |
| `parked: false`                                                                        | Reset the Status to `todo` as `SKILL.md:316` says, then treat it as infrastructure.                                                            |
| Divergence (`(divergence)`)                                                            | Record `halt` for the flight and stop the loop. Its refs passed and landed, so a re-launch would fly them again over their own uncommitted work; the existing rule (`SKILL.md:318`) needs a person. |
| `(tree)` stall                                                                         | Record `halt` for `(tree)`. `--status` reads a `(tree)` halt as `exhausted`, because a re-launch with no edit would stall again without bound. |
| Leak abort, `drained`, budget-floor stop                                               | Record `halt` for the flight and stop the loop at once. The tree state is unknown after a leak, and a drain is the user's own stop.            |

Every escalation is recorded in the trail (section 4) before it is acted on, so `--status` sees every stop. **A task already `blocked` when the flight starts is adopted (Q's decision):** `flight-start` records it as an escalation of the new flight, keeping the class and reason of its last `capped` or `plan-defect` escalation, or `plan-defect` when the trail has none, and the reviewer sees it before the first launch, under the same budget. A task-level `halt` does not block other work, but a `halt` on any synthetic ref exhausts the flight, since it has no Status a re-launch could change. A run that completes nothing after a round with no counted repair also exhausts it. The goal ends `exhausted` once nothing repairable remains.

**The repair reviewer** is a fresh opus subagent. Its input is only:

- the escalated task file, the task files it depends on or that depend on it, and read access to every task not yet `done`, for the pattern search below
- the PLAN.md goal and requirements sections
- `flightlog.ts progress --task <ref>` and that task's section of RUNLOG.md, including the verifier's output and the judge's rationale
- the kept worktree path, so it can read the code the attempts produced

It answers one verdict, written to a file:

- `fix`: the defect pattern, the list of tasks it searched and the ones it changed, and the edited task files, with one line per changed gate item explaining why no implementation could pass the old wording, and why the new wording still enforces the PLAN feature.
- `defer`: waypoints legs only. It names the criteria to move and why no path inside the current leg exists.
- `not-plan`: the plan is sound and the code is the problem. The task is re-flown once with no plan change, and the reviewer's note goes into the task's notes for the next dev. A second `not-plan` on the same task counts as refused.
- `refuse`: no acceptable repair exists. The task stays parked.

The main agent never decides a verdict itself. It applies what the reviewer approved.

**Every repair fixes the pattern, not just the instance (Q's decision).** Because repairs are budgeted, each one must count. The reviewer names the defect pattern behind the failing item, such as "Verification greps a path a sibling task creates" or "rubric demands a coverage figure no test run prints". It then searches every task not yet `done` for the same or a similar pattern and fixes all of them in the same repair, which counts as one repair against the budget. This matters because a fix that misses a sibling file was the single largest source of repeat findings in flightplan's reviews: 7 of 42 findings over two measured reviews (CLAUDE.md, dispatch summary). The reviewer never edits a `done` task, since its gate already passed against real work.

**Applying a repair:**

1. Apply the edit. Run `lint-task.ts` on the tree. A lint failure means the repair is rejected.
2. Run the goal guard (section 5). A guard failure means the repair is rejected.
3. Record the repair with `flightlog.ts repair` (section 4).
4. Set each repaired task's re-entry point (below), and reset its Status to `todo`.
5. Re-launch one full Workflow per round. It covers every repaired task at once and carries each task's re-entry point (section 4b).

**Re-entry after a repair (Q's decision).** A repair is a special case, not a normal retry. When the code in the kept worktree was judged against a gate that has since been fixed, running dev again is usually wasted work. The task re-enters at `verify` when all of these hold:

- The repair changed only `## Verification`, `## Acceptance criteria`, or `## Eval rubric` items, and no instruction the dev builds from (scope, notes, test spec, `Depends on`).
- The kept worktree exists and holds work from a prior attempt.
- The defect was not reported by the dev. A dev that replied `PLAN DEFECT` stopped before writing code, so the worktree holds nothing to verify.

Otherwise the task re-enters at `dev`. The goal guard derives the re-entry point from the diff and the trail, not from the reviewer's say-so.

This overrides the "gate rejected, so restart at dev" rule (`SKILL.md:71`) for repaired tasks only. The repair entry plays the role an attestation plays today: it records why the rejection no longer stands, because the gate item that rejected the work was itself changed. If the resumed attempt fails, the next attempt runs the full pipeline, as every resume already does (`SKILL.md:58`), so a wrong `verify` re-entry costs one verify round.

### 4. Budget and record: `flightlog.ts`

Extend `flightlog.ts`, which already owns the run trail, instead of adding a ledger file:

- `flightlog.ts flight-start <run.jsonl> --plan <PLAN.md>` appends a `kind: "flight"` entry with the PLAN goal hash. It marks the flight boundary. Budget, guard, `--status`, and the report all count from the latest `flight` entry. **My call:** re-running goal mode after `exhausted` starts a new flight with a fresh budget, because choosing goal mode again is the user's explicit go.
- `flightlog.ts repair <run.jsonl> --task <ref>|--flight --verdict fix|defer|not-plan|refuse|infra-retry|halt --reason-file <f> [--diff-file <f>]` appends a `kind: "repair"` entry.
- `flightlog.ts repairs <run.jsonl> --status` prints `complete`, `exhausted`, or `continue`, and exits 0. It reads the task tree's Status values and the repair entries.
- `flightlog.ts repairs <run.jsonl> --json` prints per-task and flight-wide counts.

**Budget (Q's decision):** at most 3 repairs per task and 10 per flight. Each repair grants a fresh `maxAttempts`, so the worst case is 3 + 3×3 = 12 attempts for one task and 30 extra attempts for a flight. `not-plan` and `infra-retry` count against the budget. The script enforces the budget, and the model never counts.

### 4b. Orchestrator changes (approved by Q)

Three small changes, with no repair logic:

1. **Log escalations.** Before the orchestrator returns, it appends one `kind: "escalation"` entry per escalation and per cleanup failure to run.jsonl. The trail then holds them as facts, and the report never depends on the main agent copying JSON through a model. Today they exist only in the Workflow's return value.
2. **Continue attempt numbers.** A normal flight starts every task at attempt 1 (`orchestrator.md:1106`), so a re-flown task would reuse attempt numbers 1..N. `score-task --log` and `fleet.ts` key rows on ref plus attempt, so the trail would contradict itself. The orchestrator seeds each task's first attempt from the trail's highest attempt for that ref, plus 1. The cap stays `maxAttempts` per launch, so each repair grants a fresh set of attempts.
3. **Per-task re-entry in a full flight.** Today `--task <ref> --from <step>` is a single-task resume that replaces the wave loop and runs none of the task's dependents. Add a `CFG.reentry` map, `{ <ref>: "verify" | "dev" }`, read by a normal wave flight. A listed task enters its first attempt at that step, in its kept worktree, and the wave loop then schedules its dependents as usual. One launch per round then covers every repaired task.

### 5. The goal guard

A deterministic check, run before each repair is recorded:

- The PLAN.md `## Goals` section (or `## Goal`) is byte-identical to its state at flight start. The script stores a hash at the first launch.
- Each removed or reworded Acceptance criteria item must appear in the reviewer's per-item justification. Otherwise the guard rejects the repair.
- No `(human)` tag is added, and no attestation file is created.
- Except for a `defer` verdict, the number of Acceptance criteria items in a task does not drop. Under `defer`, every removed Acceptance criteria item appears in the verdict's `defer` list for its task.
- No task's Status changes to `done`, and no gate checkbox is ticked.

The guard stops a careless edit, not a determined one. The reviewer's judgement is the real defence. That limit is stated in the final report's header.

### 6. Waypoints deferral

**My call:** Final review receives the leg's `DEFERRED.md` items as declared out of scope for this leg, appended after `CFG.planGoal`. Without this, Final review scores against a goal that still includes the deferred criteria, caps, and turns every deferral into `exhausted` at the last task. The PLAN.md goal itself stays untouched.

When the plan is a waypoints leg and the reviewer returns `defer`:

1. Move the criteria out of the task file into `docs/<proj>/legs/<current>/DEFERRED.md`. Each item records its source task, original wording, the reviewer's reason, and the date.
2. Make `waypoints.ts active` print every prior leg's `DEFERRED.md` items in its prior-legs digest. Then flightplan's waypoint mode sees them when it plans the next leg (`waypoint-mode.md:19`).
3. Make the `waypoints.ts advance` preview name the deferred count in its drafted outcome, so the person landing the leg sees it.

A `defer` verdict outside a waypoints leg is invalid, and the guard rejects it.

### 7. The final report

After the loop ends, write `<plan dir>/.flightlog/FLIGHTREPORT.md`. Generate it with `flightlog.ts report --flight`, from the JSONL trail alone, so it holds facts the trail records rather than model prose. It contains, in order:

1. Outcome: `complete` or `exhausted`, with the budget used.
2. Deferred criteria, if any. This comes first because a deferral is debt the next leg owes.
3. Every error event in time order: each escalation (plan defect, capped, infrastructure, divergence, leak), each failed attempt's verdict line, and each cleanup failure.
4. Every repair: the verdict, the reviewer's reason, and the before and after text of each changed gate item.
5. Still parked: tasks refused or non-repairable, with their last reason.
6. The existing `needsHuman` checklist.

RUNLOG.md stays as today. FLIGHTREPORT.md is the summary a person reads first.

## Left to the builder

- The repair reviewer's exact prompt, and where it lives (a `references/repair.md` beside the skill is the likely home).
- The JSONL field names for `kind: "repair"` entries.
- How `repairs --status` finds the tree (from the log path or a flag).
- The format of `DEFERRED.md`, provided `waypoints.ts` parses it with a test.
- Whether the PLAN goal hash lives in the run log or a sibling file under `.flightlog/`.

## Open risk

The spike (a two-task toy plan in goal mode with one deliberately impossible Verification command) measured both open behaviours on Claude Code. They are now facts:

1. **User voice.** Workflow agents receive no relayed user message at all, on the goal-setting turn or on a `/goal` continuation turn. Each gets only the script's computed task, framed as carrying no user authority. The old `SKILL.md` advice to send a plain go-ahead before launch is dropped, since nothing relays the message any more.
2. **Evaluator input.** The `/goal` evaluator judges from the transcript, not the filesystem, and a continuation turn arrives as "Stop hook feedback". Printing the `repairs --status` line as the last line of every goal-mode turn is therefore required, not a precaution.
3. **Setting the goal.** `/goal` is a session Stop hook the user sets by typing `/goal <condition>`. Whether the model can propose one through a tool is unverified, so the skill shows the user the exact line to type (section 2).
