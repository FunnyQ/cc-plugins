# Autopilot Goal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a goal-mode flight to autopilot. The main agent repairs plan defects and capped tasks through an independent reviewer, then re-flies until the tree is complete or the repair budget is exhausted. Every event goes into a final report.

**Architecture:** The repair loop runs in the main conversation, between Workflow runs. The orchestrator gains three changes with no repair logic: it tags and logs escalations to `run.jsonl`, it supports per-task re-entry (`CFG.reentry`), and it passes deferred scope to Final review (`CFG.deferredScope`). Budget, status, guard, and report are deterministic code in a new `lib/goal-mode.ts`, exposed through new `flightlog.ts` subcommands.

**Tech Stack:** Bun + TypeScript, `bun:test`, the orchestrator's fake-agent harness (`autopilot/scripts/orchestrator-script.test.ts`).

**Spec:** `docs/autopilot-goal-mode/DESIGN.md`

## Global Constraints

- Runtime is Bun with TypeScript. Use `type`, never `interface`. Add no npm dependency.
- Old `run.jsonl` trails must still parse and render identically. New entry kinds are additive.
- Budget: `TASK_REPAIR_CAP = 3`, `FLIGHT_REPAIR_CAP = 10`. Verdicts `fix`, `defer`, `not-plan`, and `infra-retry` count. `refuse` and `halt` do not.
- The guard never accepts a change to PLAN.md's `## Goals` / `## Goal` section, an added `(human)` tag, or an edit to a `done` task.
- `defer` is valid only when the plan path matches `docs/<proj>/legs/<NN-slug>/PLAN.md`.
- `CFG.reentry` accepts only `dev` and `verify`. `judge` stays attestation-only.
- Goal mode is offered under Claude Code only.
- Typecheck with `bunx --bun tsc --noEmit` from the repo root. It must print nothing.
- Release is separate. This plan bumps no version.

## Review Focus

1. **A trail with no `flight` entry**, written by a standard run or an older dispatch: `repairs --status` exits 2 with `no goal-mode flight started`. It never guesses a boundary. (Task 3 test.)
2. **Reasons that contain `'`, `"`, newlines, or `%`** survive the orchestrator → shell → `flightlog.ts escalations` round trip byte for byte. (Task 4 test.)
3. **A repaired task reset to `todo` keeps its worktree** through the run-start sweep, or `verify` re-entry has nothing to verify. (Task 5 test.)
4. **A repair that changes only the Status line plus gate sections** re-enters at `verify`. A change to the Status line alone must not count as a dev-facing change. (Task 2 test.)
5. **A `verify` re-entry whose worktree vanished** falls back to `dev` in a fresh worktree with a logged note. It does not park as infrastructure, which is what a single-task resume does today. (Task 5 test.)

---

### Task 1: New flightlog entry kinds

**Files:**

- Modify: `packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts`
- Test: `packages/dispatch/skills/flightplan/scripts/lib/flightlog.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type EscalationClass =
    | "plan-defect"
    | "capped"
    | "infrastructure"
    | "divergence"
    | "stall"
    | "leak"
    | "budget-floor"
    | "cleanup-failure";
  export type RepairVerdict =
    "fix" | "defer" | "not-plan" | "refuse" | "infra-retry" | "halt";
  export type FlightEntry = {
    kind: "flight";
    ts: string;
    task: "(flight)";
    goalHash: string;
    planPath: string;
  };
  export type EscalationEntry = {
    kind: "escalation";
    ts: string;
    task: string;
    attempt: number;
    class: EscalationClass;
    infrastructure: boolean;
    parked: boolean;
    reason: string;
  };
  export type RunEndEntry = {
    kind: "run-end";
    ts: string;
    task: "(flight)";
    aborted: boolean;
    completed: string[];
    drained: string[];
    needsHuman: { task: string; criteria: string[] }[];
  };
  export type RepairEntry = {
    kind: "repair";
    ts: string;
    task: string;
    verdict: RepairVerdict;
    reason: string;
    pattern?: string;
    changed?: string[];
    reentry?: Record<string, "dev" | "verify">;
    diff?: string;
  };
  export type FlightlogEntry =
    | ScoreEntry
    | NoteEntry
    | StateEntry
    | FlightEntry
    | EscalationEntry
    | RunEndEntry
    | RepairEntry;
  ```

- [ ] **Step 1: Write failing tests** in `flightlog.test.ts`:
  - `parseLog keeps flight, escalation, run-end and repair entries`: one JSONL line of each kind round-trips through `formatEntry` / `parseLog` equal to the input.
  - `renderRunlog renders escalation and repair lines under their task`: an escalation for `ui/01` renders `- escalation — capped: <reason>`. A repair renders `- repair — fix: <reason>`.
  - `renderRunlog skips flight and run-end entries`.
  - `an old trail renders byte-identically`: an existing fixture with score, note, and state entries renders to the same string as before the change.
- [ ] **Step 2:** Run `bun test packages/dispatch/skills/flightplan/scripts/lib/flightlog.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Extend the types, `parseLines`' kind filter, and `renderLine` / `renderRunlog` in `lib/flightlog.ts`. Pass each reason through `singleSpaced`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dispatch): add goal-mode flightlog entry kinds`.

### Task 2: Goal-mode core: status, budget, guard, re-entry, report

**Files:**

- Create: `packages/dispatch/skills/flightplan/scripts/lib/goal-mode.ts`
- Test: `packages/dispatch/skills/flightplan/scripts/lib/goal-mode.test.ts`

**Interfaces:**

- Consumes: the Task 1 types. `ParsedTask` and `findReady` from `next-ready.ts` / `lib/parse-task.ts`. `resumePoint` from `lib/resume-point.ts`.
- Produces:
  ```ts
  export const TASK_REPAIR_CAP = 3;
  export const FLIGHT_REPAIR_CAP = 10;
  export function goalSection(planMd: string): string; // body of ## Goals or ## Goal, "" if absent
  export function goalHash(planMd: string): string; // sha256 hex of goalSection
  export function currentFlight(
    entries: FlightlogEntry[],
  ): { flight: FlightEntry; entries: FlightlogEntry[] } | null; // entries after the LAST flight entry
  export function repairCounts(flightEntries: FlightlogEntry[]): {
    flight: number;
    byTask: Record<string, number>;
  };
  export type FlightStatus = "complete" | "exhausted" | "continue";
  export function flightStatus(
    flightEntries: FlightlogEntry[],
    tasks: Record<string, ParsedTask>,
  ): FlightStatus;
  export function admitRepair(
    flightEntries: FlightlogEntry[],
    task: string,
    verdict: RepairVerdict,
  ): { ok: true } | { ok: false; error: string };
  export type GuardInput = {
    verdict: "fix" | "defer";
    isLeg: boolean;
    flightGoalHash: string;
    planMd: string;
    before: Record<string, string>; // ref -> task file text at HEAD
    after: Record<string, string>; // ref -> task file text on disk
    doneRefs: string[]; // refs whose HEAD Status is done
    justified: { task: string; before: string }[]; // gate items the reviewer justified changing
    kept: string[]; // refs with a kept worktree
    devReportedDefect: string[]; // refs whose latest escalation reason starts "PLAN DEFECT reported by dev"
    workedRefs: string[]; // refs with a completed dev step in the trail
  };
  export function guardRepair(
    input: GuardInput,
  ):
    | { ok: true; reentry: Record<string, "dev" | "verify"> }
    | { ok: false; violations: string[] };
  export function renderFlightReport(
    flightEntries: FlightlogEntry[],
    opts: { slug: string; status: FlightStatus; deferredMd: string | null },
  ): string;
  ```

**Rules the tests pin:**

- `flightStatus`:
  - Returns `complete` when every task is `done`.
  - Returns `exhausted` when one of these holds:
    - a repair entry with task `(flight)` and verdict `halt` exists
    - the flight count is at least `FLIGHT_REPAIR_CAP`
    - nothing is repairable
  - Otherwise returns `continue`. A task makes the flight `continue` when one of these holds:
    - it is in `findReady`
    - it is `in-progress`
    - it is `blocked` with no `refuse` or `halt` repair and a task count below `TASK_REPAIR_CAP`
- `admitRepair`:
  - Refuses any counted verdict once either cap is reached.
  - Refuses a second `not-plan` for the same task, with the error `record refuse instead`.
  - Refuses a second `infra-retry` for the same task, with the error `record halt instead`.
- `guardRepair` violations:
  - `goalHash(planMd) !== flightGoalHash`
  - any ref in `doneRefs` changed
  - an added `(human)` tag in a changed gate item
  - a removed or reworded Acceptance criteria / Verification item that is missing from `justified`
  - a drop in the Acceptance criteria item count unless the verdict is `defer`
  - `defer` with `isLeg` false
- `guardRepair` re-entry per changed ref is `verify` only when all of these hold:
  - the only differing sections are `## Verification`, `## Acceptance criteria`, `## Eval rubric`, or the `> **Status**:` line
  - the ref is in `kept`
  - the ref is in `workedRefs`
  - the ref is not in `devReportedDefect`

  In every other case it is `dev`.

- `renderFlightReport` section order:
  1. `# Flight report — <slug>`
  2. An outcome line with `complete` or `exhausted`, and `repairs used N/10`.
  3. The guard-limit sentence: `The goal guard rejects careless gate edits, not deliberate ones; each gate change below was approved by an independent reviewer.`
  4. `## Deferred criteria`, only when `deferredMd` is non-null.
  5. `## Error events`, in time order: escalation entries, score entries with `passed: false`, and `run-end` entries where `aborted` is true.
  6. `## Repairs`, each with its verdict, pattern, reason, and diff.
  7. `## Still parked`
  8. `## Needs a person`, from the last `run-end`'s `needsHuman`.

- [ ] **Step 1: Write failing tests**, one `describe` per function. Each rule above gets one test. Include these by name:
  - `flightStatus returns continue for a blocked task with 2 repairs and exhausted with 3`
  - `flightStatus ignores a todo task whose dependency was refused`, which is covered by `findReady`
  - `guardRepair: Status line plus Verification change re-enters at verify` (Review Focus 4)
  - `guardRepair: Status line plus Verification change re-enters at dev when the worktree is not kept`
  - `guardRepair: a Depends on change re-enters at dev`
  - `guardRepair rejects an edit to a done task`
  - `guardRepair rejects defer outside a leg`
  - `goalHash ignores edits outside the Goals section`
- [ ] **Step 2:** Run `bun test packages/dispatch/skills/flightplan/scripts/lib/goal-mode.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `lib/goal-mode.ts`. Split task bodies by `## ` headings for the section diff. Compare gate items as trimmed `- [ ]` / `- [x]` lines, ignoring the checkbox state.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dispatch): add goal-mode status, guard and report core`.

### Task 3: flightlog CLI subcommands

**Files:**

- Modify: `packages/dispatch/skills/flightplan/scripts/flightlog.ts`
- Test: `packages/dispatch/skills/flightplan/scripts/flightlog.test.ts`

**Interfaces:**

- Consumes: Task 2 exports. `loadAllTasks` from `next-ready.ts`. `parseDeferred` / `legOf` from Task 6 (`waypoints/scripts/deferred.ts`). Task 6 can land first, or `guard` can hard-code `isLeg` until it does.
- Produces these CLI contracts. Every one exits 2 on usage errors.
  - `flight-start <log> --plan <PLAN.md>` appends a `flight` entry with `goalHash`.
  - `escalations <log> --payload <uri-encoded JSON>` decodes `{escalations, cleanupFailures, drained, aborted, completed, needsHuman}`. It appends one `escalation` entry per escalation and one `cleanup-failure` escalation per cleanup failure, then one `run-end` entry. This is the orchestrator's write path.
  - `guard <log> --plan <PLAN.md> --tasks <dir> --verdict fix|defer --justified <json file> --kept <ref,ref|"">` reads `before` with `git show HEAD:<path>`, takes `doneRefs` from the HEAD Status lines, `workedRefs` from `resumePoint` (a completed `dev` step), and `devReportedDefect` from each ref's latest `escalation` entry in the current flight, and prints the `guardRepair` result as JSON. It exits 1 when `ok` is false.
  - `repair <log> --task <ref>|--flight --verdict <v> --reason-file <f> [--pattern <text>] [--changed <ref,ref>] [--reentry <json>] [--diff-file <f>]` runs `admitRepair` first. It exits 1 with the error when refused, and otherwise appends.
  - `repairs <log> --tasks <dir> --status` prints exactly one of `complete`, `exhausted`, or `continue`. It exits 2 with `no goal-mode flight started` when `currentFlight` is null.
  - `repairs <log> --tasks <dir> --json` prints `repairCounts` plus `status`.
  - `report <log> --flight [--deferred <DEFERRED.md>]` writes `FLIGHTREPORT.md` beside the log and prints its path. Without `--flight`, `report` behaves as today.

- [ ] **Step 1: Write failing tests** in `flightlog.test.ts`. They spawn the CLI on a temp dir with a two-task tree fixture:
  - `repairs --status exits 2 on a trail with no flight entry` (Review Focus 1)
  - `flight-start then repairs --status prints continue for a blocked task`
  - `escalations decodes a payload with quotes, newlines and percent signs`
  - `repair refuses a fourth fix on one task with exit 1`
  - `report --flight writes FLIGHTREPORT.md and leaves RUNLOG.md untouched`
- [ ] **Step 2:** Run `bun test packages/dispatch/skills/flightplan/scripts/flightlog.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Add the subcommands to `main()` and the `usage()` text. Update the header usage block.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dispatch): add goal-mode flightlog subcommands`.

### Task 4: Orchestrator tags and logs escalations

**Files:**

- Modify: `packages/dispatch/skills/autopilot/references/orchestrator.md` (every `escalations.push({` site; the return block near line 2227; the "What the main agent does with the result" prose)
- Test: `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts`

**Interfaces:**

- Produces:
  - Every escalation object carries `class: EscalationClass`. The source of truth for each class:
    - `(worktree)`, `(commit)`, `(scout)`, and any `infrastructureFailure`: `infrastructure`
    - `(tree)` stall or an empty tree: `stall`
    - `(divergence)`: `divergence`
    - the budget-floor stop: `budget-floor`
    - a plan-defect park: `plan-defect`
    - a cap park: `capped`
    - leak abort: `leak`
  - One agent call labelled `log-escalations` runs before `return`, through `wtCall`'s pattern with `MODEL.worktree`. It runs exactly `bun ${S}/flightlog.ts escalations ${CFG.logFile} --payload '<p>'`, where `<p>` is `encodeURIComponent(JSON.stringify(payload)).replace(/'/g, "%27")`. A failed log call adds no escalation and does not change the return value. It sets `logFailed: true` on the result.

- [ ] **Step 1: Write failing tests:**
  - `every escalations.push site in the extracted script sets class`: a static check over `extractScript(doc)` that counts `escalations.push({` blocks and asserts each contains `class:`.
  - `a capped task escalates with class capped` and `a dev PLAN DEFECT escalates with class plan-defect`, using the existing scenario helpers.
  - `the run ends with one log-escalations call whose payload decodes to the returned escalations` (Review Focus 2). Use a reason containing `'`, `"`, `\n`, and `%`. Decode the `--payload` argument out of the recorded prompt.
  - `a log-escalations failure sets logFailed and leaves escalations unchanged`.
- [ ] **Step 2:** Run `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts`. Expected: the new tests FAIL. Teach the harness's fake `agent` to answer the `log-escalations` label with `{ ok: true }`.
- [ ] **Step 3:** Implement the change in the orchestrator script and document `class` and `logFailed` in the result prose.
- [ ] **Step 4:** Run the same command plus `bun test packages/dispatch/skills/autopilot/scripts/bake-orchestrator.test.ts`. Expected: PASS, including every pre-existing test.
- [ ] **Step 5:** Commit: `feat(dispatch): log autopilot escalations to the flightlog`.

### Task 5: Orchestrator per-task re-entry and deferred scope

**Files:**

- Modify: `packages/dispatch/skills/autopilot/references/orchestrator.md` (the CFG block; the `RESUME` setup near line 240; `runTask`'s `first` / `startAt` near line 1106; the wave-1 start sweep near line 1950; the Final-review verify prompt at line 654)
- Test: `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts`, `bake-orchestrator.test.ts`

**Interfaces:**

- Produces:
  - `CFG.reentry: {}` has the shape `{ "<ref>": { from: "dev" | "verify", attempt: number } }`. It is validated at script start: `from` must be `dev` or `verify`, and `attempt` a whole number ≥ 1. Otherwise the script throws, naming the ref. It cannot be combined with `CFG.resumeTask`, and that combination throws too.
  - `CFG.deferredScope: ""` holds free text. When it is non-empty, the Final-review verify prompt adds, after the PLAN-goal sentence: `These criteria were deferred to a later leg and are out of scope here; do not fail the goal for them:\n${CFG.deferredScope}`.
  - Inside `runTask`, `entryFor(ref)` returns `RESUME` for the resumed ref, else `CFG.reentry[ref]`, else null. `first` and `startAt` read from it.
  - For a `verify` entry, the worktree step runs `wt-show` first, as a resume does. A missing worktree logs `flightlog.ts log … --role reentry --message "kept worktree gone; re-entering at dev"`, creates a fresh worktree, and starts at `dev`.
  - The wave-1 `sweep("start", …)` keep list adds `Object.keys(CFG.reentry)`.

- [ ] **Step 1: Write failing tests:**
  - `bake accepts a reentry object and a deferredScope string`, in `bake-orchestrator.test.ts`.
  - `reentry rejects judge` and `reentry plus resumeTask throws`.
  - `a reentry task starts at verify on its given attempt number`: assert the first label for the ref is `verify:<ref>#4` with `attempt: 4`.
  - `the start sweep keeps reentry refs` (Review Focus 3): assert the `wt-sweep:start` prompt contains `--keep` with the ref.
  - `a verify reentry with a missing worktree falls back to dev` (Review Focus 5).
  - `deferredScope reaches only the Final-review verify prompt`.
- [ ] **Step 2:** Run both test files. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the change. Leave single-task resume behaviour byte-identical. The existing `orchestrator single-task resume` tests prove this.
- [ ] **Step 4:** Run both test files. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dispatch): per-task reentry and deferred scope in autopilot`.

### Task 6: Waypoints deferral file

**Files:**

- Create: `packages/dispatch/skills/waypoints/scripts/deferred.ts`, `deferred.test.ts`
- Modify: `packages/dispatch/skills/waypoints/scripts/waypoints.ts` (`formatActive`, the `active` case, `draftOutcome`, the `advance` case)
- Test: `packages/dispatch/skills/waypoints/scripts/waypoints.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type DeferredItem = {
    criterion: string;
    from: string;
    date: string;
    why: string;
  };
  export function parseDeferred(md: string): DeferredItem[];
  export function appendDeferred(
    md: string | null,
    legSlug: string,
    items: DeferredItem[],
  ): string;
  export function legOf(
    planPath: string,
  ): { proj: string; slug: string } | null; // docs/<proj>/legs/<NN-slug>/PLAN.md
  export function formatActive(
    roadmap: Roadmap,
    priorGoals: Record<string, string>,
    deferred?: Record<string, DeferredItem[]>,
  ): string;
  export function draftOutcome(
    runlog: string,
    planOverview: string,
    deferredCount?: number,
  ): string;
  ```

  File shape:

  ```markdown
  # Deferred criteria — <leg slug>

  - [ ] <criterion>
    - from: <ref> · deferred: <YYYY-MM-DD>
    - why: <reason>
  ```

  `formatActive` prints `  deferred: <criterion> (from <ref>)` under each landed leg that has items. `draftOutcome` appends ` · deferred <N> criteria to a later leg` when `deferredCount > 0`.

- [ ] **Step 1: Write failing tests:** `parseDeferred(appendDeferred(null, …))` round-trips, `legOf` matches a leg path and returns null for `docs/x/PLAN.md`, `formatActive` lists the deferred items, and `draftOutcome` appends the count. The existing `formatActive` / `draftOutcome` tests stay green with the new arguments omitted.
- [ ] **Step 2:** Run `bun test packages/dispatch/skills/waypoints/scripts/`. Expected: FAIL.
- [ ] **Step 3:** Implement the change. `active` reads `legs/<slug>/DEFERRED.md` for each landed leg. `advance` reads the active leg's file.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(dispatch): carry deferred criteria across waypoints legs`.

### Task 7: The repair reviewer prompt

**Files:**

- Create: `packages/dispatch/skills/autopilot/references/repair.md`

**Interfaces:**

- Consumes: the Task 3 CLI and the Task 6 `DEFERRED.md` shape.
- Produces: the prompt the main agent hands to a fresh `general-purpose` opus subagent. The reviewer edits task files in place and writes one verdict file, `<plan dir>/.flightlog/repair/<round>-<ref-slug>.json`:

  ```json
  {
    "verdict": "fix|defer|not-plan|refuse",
    "pattern": "",
    "searched": [],
    "changed": [],
    "justified": [{ "task": "", "before": "", "after": "", "why": "" }],
    "defer": [{ "task": "", "criterion": "", "why": "" }],
    "note": ""
  }
  ```

  The prompt carries these rules from the design:
  - The PLAN goal and features must still be delivered.
  - Name the defect pattern, search every task not yet `done`, and fix every instance in this one repair.
  - Never edit a `done` task, never add `(human)`, and never write an attestation.
  - For a capped task, examine the Verification and judge criteria first.
  - `defer` only inside a waypoints leg, and only when no in-leg path exists.
  - `not-plan` puts its note under the task's `## Notes` for the next dev.
  - Reply with the verdict file path only.

- [ ] **Step 1:** Write `repair.md`. Then run one dry check: hand it to a subagent against a fixture task whose Verification greps a path no task creates. Read the verdict file it writes. Expected: `verdict: "fix"`, a non-empty `pattern`, and the item in `justified`.
- [ ] **Step 2:** Run `bun flightlog.ts guard …` on that fixture's diff. Expected: `{"ok":true,…}` with re-entry `dev` (the fixture has no kept worktree).
- [ ] **Step 3:** Commit: `feat(dispatch): add the goal-mode repair reviewer prompt`.

### Task 8: Spike: `/goal` behaviour (needs Q)

**Files:** none committed. Record the findings in `DESIGN.md` § Open risk.

- [ ] **Step 1:** Build a two-task toy plan under `/tmp/q-lab/dispatch/autopilot/spike-<mktemp>/docs/toy/`. One task's Verification runs `test -e /nonexistent`.
- [ ] **Step 2:** Ask Q to approve a `/goal` with the design's condition. Run autopilot standard mode until it parks, apply a hand repair, and re-launch.
- [ ] **Step 3:** Record two facts:
  - What the re-launched agents receive as the user voice. Read the dev agent's prompt in its transcript under `<session>/subagents/workflows/`.
  - Whether the goal evaluator ended the session on `repairs --status` output, or needed the printed line.
- [ ] **Step 4:** If the user voice on the re-launch is the goal text, add to Task 9: the main agent sends a plain go-ahead line before each re-launch.

### Task 9: Wire goal mode into the autopilot skill

**Files:**

- Modify: `packages/dispatch/skills/autopilot/SKILL.md` (Step 2, the brief, a new `## Goal mode` section after Step 4, Step 4's report)
- Modify: `packages/dispatch/skills/autopilot/references/codex.md`, `references/opencode.md`: one line each, `Goal mode is Claude Code only; do not offer the Flight mode question.`
- Modify: `CLAUDE.md`: one sentence in the dispatch summary about goal mode's repair loop living in the main conversation.

**Content the `## Goal mode` section fixes, as numbered steps:**

1. Before the first launch, run `flight-start`. Propose the goal with the condition from DESIGN.md § 2.
2. After each Workflow return, check `logFailed`. When it is true, stop and report: the trail is incomplete, so `--status` cannot be trusted.
3. Run `repairs --status`. On `complete` or `exhausted`, go to step 7.
4. Sort each escalation by class, following the DESIGN.md § 3 table. Record `infra-retry` or `halt` with `repair` before acting.
5. For each `plan-defect` or `capped` escalation, spawn the reviewer with `references/repair.md`. On `fix` or `defer`, run `guard`:
   - When it rejects, restore each changed file with `git show HEAD:<path> > <path>` and record `refuse`.
   - When it passes, record `repair` with the guard's `reentry`, write `DEFERRED.md` for `defer`, and commit the task files as `plan repair: <pattern>`.
6. Reset the repaired tasks to `todo`. Bake with `reentry`, using each task's attempt from `flightlog.ts progress --task <ref> --json`, and with `deferredScope` from `DEFERRED.md`. Re-launch.
7. Run `report --flight`. Print the outcome and the FLIGHTREPORT.md path. Print the `repairs --status` line as the last line of every goal-mode turn.

- [ ] **Step 1:** Add the Flight mode question to Step 2's first `AskUserQuestion` call. Its options are `Standard (Recommended)` and `Goal mode`. Add the brief lines: the budget `3 per task / 10 per flight`, gate edits are possible and reported, and the worst case is `12 attempts per task, 30 extra per flight`.
- [ ] **Step 2:** Write the `## Goal mode` section from the steps above, plus the Task 8 findings.
- [ ] **Step 3:** Run the repo gates:
  - `bun test packages/dispatch` passes.
  - `bunx --bun tsc --noEmit` prints nothing.
  - The dispatch mod copy-test from CLAUDE.md § Commands passes.
- [ ] **Step 4:** Commit: `feat(dispatch): offer goal mode at autopilot confirmation`.
