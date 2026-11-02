# SKILL-02: The runnable example, doubling as the dashboard fixture

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: skill/01, deck/04, deck/05
> **Blocks**: review/01
> **Status**: done

## Goal

A reader with no context can copy one directory, start the dashboard against it, and see every panel render — and the same committed files serve as the fixture that proves the new source loads.

## Files to create / modify

- `packages/dispatch/skills/deckplan/references/example/workflow.js` (new) — a complete, conforming workflow script an author copies and adapts
- `packages/dispatch/skills/deckplan/references/example/graph.json` (new) — the graph that script declares
- `packages/dispatch/skills/deckplan/references/example/run.id` (new) — the example's run identifier, the same value the script interpolates into every prompt
- `packages/dispatch/skills/deckplan/references/example/run.jsonl` (new) — a hand-written trail exercising every state the panel can show
- `packages/dispatch/skills/deckplan/references/example/README.md` (new) — how to place the example, how to run it, and what to look for on each panel
- `packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` (modify) — load the committed graph and trail from their committed path and assert they validate

All paths are from the repo root `/Users/funnyq/Projects/q-lab/cc-plugins`.

## Implementation notes

### Two jobs, one artifact

These files are read by two audiences and both have a veto:

- **An author** copies them as the starting point for their own workflow. So the script must be complete and readable, not a fragment with elisions, and every rule it follows must be visible in it rather than only described in prose elsewhere.
- **A test** loads them and asserts the loader accepts them. So they must be committed, stable, and free of anything machine-specific.

Where the two pull apart, the author wins on the script and the test wins on the data files. Note which choices that decided.

### The graph's shape

Five or six nodes across two or three lanes. Small enough to read on one screen; large enough that the layout is actually exercised.

**At least one dependency must cross lanes.** State this as a hard requirement of the example, not a nicety. The renderer draws a same-lane dependency as a straight run along the road and a lane-changing one as a curved crossover, and the crossover is the part of the layout most likely to break. A single-lane example proves nothing about it, and an example whose every edge stays in its lane proves the same nothing while looking complete.

Every node reference is a lowercase lane token, a forward slash, then exactly two digits — the shape the annotated schema in `../_context/contract.md` gives as a regex. Use that file's worked example as the model; do not invent a second ref convention here.

The declared lane order is meaningful and is not alphabetical. Deliberately choose a lane order that a sort would change, so that a regression which sorts the lanes is visible in the example rather than hidden by a lucky ordering.

`repoRoot` in the committed file is the one machine-specific value. Decide how the committed copy carries it and record the decision — the README's placement step is the natural place for the reader to substitute their own, and the test must not depend on the committed value pointing at anything that exists.

### The trail's coverage

The trail is what makes this a fixture rather than a demo. It must produce, across the graph's nodes, every state the panel can display:

- a node resolved complete by a state declaration
- a node with an opening note and no closing note, so it reads as in flight
- a node whose dependency is not complete, so it reads as blocked — this state is derived, never declared, so do not write a declaration for it
- a node with no entries at all and nothing incomplete upstream, so it reads as ready
- a node that reads as invalid

Beyond the states, include:

- **a score entry**, so the score column, its threshold, its verdict, and its breakdown all have something to render
- **at least one retry** — the same node logged at two different attempt numbers — so the attempt counter is not uniformly one and a regression that drops it is visible

Timestamps must be ordered and plausible. The trail is read in write order, and last-write-wins for state declarations, so a trail whose lines contradict their own timestamps teaches the wrong thing to the author reading it.

### The script's correctness

The script is committed as a reference and **is not executed by this task**. Running a real workflow spends real tokens and needs the repo owner's separate authorization; that is recorded as a known gap on this plan, not as work deferred inside this task.

Not executing it is not licence for it to be approximate. It must be correct as written:

- It uses only the workflow globals — the metadata export, the phase declaration, the agent call, and the parallel and pipeline combinators. Nothing else exists in that runtime.
- It imports nothing. Not from this repo, not from anywhere.
- It touches no filesystem API. Every read and write happens inside an agent the script spawned, because the script itself has no such access.
- Every path in every prompt is an **absolute literal, interpolated into the string**. Never a shell variable, never a relative path. Workflow agents do not share a working directory: an agent that changed directory resolves a relative log path against its own location and silently splits the trail into a second, nested directory nobody is watching.
- Every agent's prompt **opens with its announce command and closes with its completion command**, and both carry identical values for the node, the role, and the attempt. That triple is the join key token attribution rebuilds from the prompt text; a prompt whose two commands disagree produces an agent whose spend attaches to nothing.
- The prompt text contains the run directory's absolute path — which it does for free, because the log file lives inside that directory. Point this out in a comment rather than leaving it to look incidental, because an author who "tidies" the path into a shorter form breaks attribution without any error appearing.
- The node a completion declares is declared with the state subcommand, not by editing the graph file. The graph file is never written after the run starts.

Model the prompt construction on the canonical orchestrator script in `packages/dispatch/skills/autopilot/references/orchestrator.md` — the announce-then-work-then-log shape, and the configuration block of absolute literals at the top. The example is a much smaller thing than that script and must not imitate its retry machinery, its gates, or its commit handling; take the prompt discipline and leave the rest.

### Where the fixture lives, and why it is not where it runs

This is the part most likely to be resolved wrongly by accident, so resolve it explicitly and write down the answer.

The dashboard reads a run directory in the user's data directory, outside any repository. A committed fixture cannot live there. The resolution:

- The five files are committed under the example directory named above, as a **template**.
- The README's placement step copies the graph and the trail into a run directory the reader creates, with the trail landing under the run directory's trail subdirectory.
- The test loads the graph and the trail **from their committed path directly**, never from a run directory. It is asserting that the committed template is valid, which is exactly the thing that can rot.

One trap in that layout: do not commit the trail inside a directory named for the trail subdirectory. That directory carries a self-ignoring rule written on first append, so a fixture committed there is invisible to version control on a fresh clone and the test fails for the next person with a file that exists on the author's machine.

The test reads real files from disk, so it follows the repository's filesystem-test convention rather than the in-memory one — see the test conventions in `../_context/shared.md`. It needs no temp directory, because it reads committed paths and writes nothing.

### The README's walkthrough

Written for someone who has not read this plan. It covers **two different
things**, and conflating them is how a reader ends up with a panel that renders
and a workflow that mis-attributes:

**A. Look at the example** — a fixture walkthrough, no run involved.

1. Create the run directory and its trail subdirectory.
2. Copy the graph, the identifier file, and the trail into place, and substitute the repository root value.
3. Start the dashboard server against that directory. The server takes an absolute directory argument and an optional port, defaulting to `5757`; give the exact command with a placeholder for the reader's own path.
4. Check each panel in turn.

**B. Adapt it and actually run it** — everything A does, plus the steps a real
run needs and a fixture does not:

5. Reset the trail: confirm nothing is still running, ask before touching an existing trail, then move it aside or delete it.
6. Write a fresh identifier value, and replace the placeholder identifier inside the script with that same value.
7. Substitute the three absolute paths the script carries. They are three different things and must not be collapsed into one instruction:
   - **the run directory** — where the trail and the identifier live, under the user's data directory; this is what the log-path argument points at
   - **the event-trail script** — wherever the flightplan skill's scripts are installed; the announce commands invoke it and it has nothing to do with the run directory
   - **the working repository** — where the agents actually do the job, which is also the value the graph declares as its repository root

   Say plainly that a path left as a shell variable expands to nothing in the child, and that this is the failure the step exists to prevent.

8. Run it, and watch the same panels update live.

Keep the two lists visibly separate. A reader who does A and believes they have
done B ships a workflow whose prompts still carry the example's identifier, and
the panel then counts the example's figures as their run's.

For step four, name what to look for **and** what a regression looks like, panel by panel:

- **the lanes panel** — every node present under its declared lane, and the lanes in the order the graph declares them. A regression here shows the lanes alphabetised.
- **the dependency graph** — the cross-lane dependency drawn as a crossover between two roads. A regression here shows that edge missing entirely, because a dropped reference is silently omitted from the layout by design.
- **the state of each node** — matching what the trail declares and derives. A regression here shows a node whose state contradicts its own trail lines, most visibly a node that never started reading as ready when its upstream is incomplete.
- **the fleet table** — one row per logged agent, the retry visible as a second attempt, and the score entry's verdict rendered.
- **the counts in the header** — the invalid node counted separately, so the run is not presented as complete.

A reader who follows the walkthrough and sees all five is looking at a working path. Say that; a checklist with no stated success condition gets abandoned halfway.

## Acceptance criteria

- [x] All five example files exist at the paths listed above — the script, the graph, the identifier, the trail, and the README — and the trail is not committed inside a self-ignoring directory.
- [x] The graph declares five or six nodes across two or three lanes, with at least one dependency whose two ends sit in different lanes.
- [x] The declared lane order is one that alphabetical sorting would change.
- [x] The trail produces all five displayed states across the graph's nodes: complete, in flight, blocked, ready, and invalid.
- [x] The trail contains at least one score entry and at least one node logged at two different attempt numbers.
- [x] The script uses only the workflow globals, imports nothing, and calls no filesystem API.
- [x] Every path in every prompt in the script is an absolute literal interpolated into the string, with no shell variable and no relative path.
- [x] Every agent prompt opens with an announce command and closes with a completion command carrying identical node, role, and attempt values.
- [x] A test loads the committed graph and trail from their committed path and asserts the graph validates with no errors and yields the declared number of nodes.
- [x] That test runs the committed trail against the committed graph through the existing derivation and asserts the expected displayed state for **every** node by name, plus the resulting counts. Node count and absence of errors are not enough: an emptied trail still satisfies those, and the fixture's whole value is the states it exercises.
- [x] The same test asserts the fleet result for the retry and for the score entry, so a trail that loses either fails rather than passing quietly.
- [x] The walkthrough separates looking at the fixture from adapting and running it, and the running list covers the trail reset, a fresh identifier, and the absolute-path substitution.
- [x] The example ships a run identifier file, and every prompt the script builds interpolates that same value — asserted by a test that reads both and compares, not by inspection. An example whose prompts omit it teaches the one mistake that silently mixes a previous run's token figures into the current one.
- [x] The README's walkthrough gives the placement steps, the exact server command, and a named check plus a named regression symptom for each of the five panels.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. Typecheck against the root config, never a file list — naming files on the command line drops the config and buries real errors among fake ones. The repo-wide run is not green: 86 pre-existing errors sit elsewhere, so a clean result is an empty grep, not a zero count.
- [x] Follow the README's own walkthrough end to end: create a run directory, copy the graph and trail into it, start the dashboard server against it, and confirm each of the five panel checks. Report which checks passed and quote any that did not.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                                     | 2–3 (below bar)                                                                                                                        | 4–5 (pass)                                                                                                                                                                                                                           |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correctness             | ×3     | The script would not run — an import, a filesystem call, or a global that does not exist; or the trail contradicts itself and would not render | Script runs but a prompt's announce and completion disagree, or the trail misses a displayed state, or a path is relative              | The script would run as written, and the trail renders every displayed state exactly as the walkthrough claims                                                                                                                       |
| Backward compatibility  | ×2     | The added test or files change how an existing task-tree directory loads or renders                                                            | New files sit apart, but the modified test file disturbs existing cases                                                                | Purely additive: existing loading and rendering are untouched, and the modified test file only gains cases                                                                                                                           |
| Test coverage           | ×2     | The example is committed but nothing asserts it                                                                                                | A test loads the graph but ignores the trail, or asserts only node count and absence of errors — which an emptied trail also satisfies | The committed trail is run against the committed graph through the existing derivation, asserting each node's displayed state by name, the counts, and the retry and score results, so losing any part of the fixture fails the test |
| Interface & readability | ×1     | The script reads as generated filler an author would delete rather than adapt                                                                  | Readable but the conformance rules are invisible in it — an author would have to read the specification to know why a line is there    | An author can adapt it directly, and each rule it follows is visible where it applies                                                                                                                                                |
| Assumptions & docs      | ×1     | The repository-root value and the fixture placement are left unstated, so the example works only on the machine that wrote it                  | Placement is described but the reason is not, so the next person moves it back                                                         | The placement decision and the repository-root substitution are both written down with the failure each prevents                                                                                                                     |

## Out of scope

- Executing a real workflow run — Deferred. It spends real tokens and needs the repo owner's separate authorization; the example is verified by loading and by the manual walkthrough instead, and the unproven end-to-end attribution is recorded as a known gap on this plan.
- Any change to how the dashboard renders — Deferred. **This task** edits no frontend file. One other task in the plan does take the declared road order as a layout input, and that work is already done by the time this starts; here, a panel that renders wrongly is a loader or a fixture defect, not a rendering one.
- A second example covering a differently shaped workflow — Deferred. One worked example that exercises every state is what an author needs to start; a second one is only worth writing once real usage shows which shape is missing.
