# Authoring a Workflow for flightdeck

Use this reference to explain how to author a script, not to interview, scaffold, generate artifacts, or launch a run. Read [packages/dispatch/skills/autopilot/references/graph-contract.md](../../autopilot/references/graph-contract.md) before applying the guidance.

Keep the on-disk layout and directory naming in section 2 of that specification. Keep the graph shape, defaults, validation, event types, state resolution, and narrow node type in sections 3–5. Do not reproduce those definitions here. Copy the shell command templates from section 4 verbatim, because an author needs the exact flags in the prompt being prepared.

## 1. Declare the graph before writing the script

Fix all nodes and edges at authoring time. Prepare the graph according to the specification before writing orchestration. Keep runtime decisions within that declared topology. A graph whose shape depends on runtime data cannot be drawn: layout computes each node's depth from the whole node set, which would not exist until the run ends.

## 2. Keep writes inside spawned agents

Use only the Workflow globals `agent`, `phase`, `parallel`, `pipeline`, and `meta` to orchestrate the script. Do not import modules or access the filesystem from the script. Prepare the graph and run identity outside the script before starting it. During the run, put every write inside a spawned, tool-capable agent and spell its shell command out in full in the prompt. A script that tries to write the trail itself has no such capability; the author may discover the missing events only when the panel is empty after the run.

## 3. Bake absolute paths into prompts

Resolve the installed CLI path, run directory, log path, and working repository before building prompt strings. Interpolate the resolved absolute values into every initial prompt. Expand home-directory notation and environment variables before recording the prompt. Never pass a shell variable through for a child to resolve. An unset child-shell variable expands to the empty string and reports the path as "not set"; this has already cost a real run in this repo.

Include the current run identifier literally in each initial prompt. Name the working repository consistently with the graph's repository setting, following section 6 of the specification. Membership uses the first message, so later shell expansion cannot repair missing attribution text.

## 4. Open and close every agent

Put the announce command first in every agent's instructions. Require the agent to execute it before work. Put the completion command last and require it on both successful and unsuccessful exits, with a message describing the outcome. Copy these templates verbatim from graph-contract section 4:

```bash
bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" --phase start

bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" \
  --phase end --message "<what happened>"

bun <flightplan-scripts>/flightlog.ts state <logfile> \
  --task <ref> --state done --agent "<label>"
```

Replace `<flightplan-scripts>` with the absolute installed `packages/dispatch/skills/flightplan/scripts` path or its installed equivalent. Replace `<logfile>` with the resolved absolute log path for this run. Replace the remaining placeholders with the actual ref, role, attempt, label, and message before handing the prompt to an agent. Quote resolved shell arguments where needed.

Keep `--task <ref> --role <role>` adjacent, in that order, with single spaces. Include the 1-based attempt number. Use the same node ref, role, and attempt in the prompt's commands and the entries the agent writes. Keep the agent label identical between announce and completion. The token join is computed independently from prompt text and trail entries; a mismatch on any identity value produces a row with no spend attached, indistinguishable from an agent that used no tokens.

## 5. Declare completion with a state entry

After the unit of work meets its completion condition, have its responsible agent append the state command above. Close individual agents with end notes even when more roles or retries remain on the same node. Do not treat an agent's end note or score as the node's completion declaration.

For blocked or failed work, change `--state done` to `--state blocked` or `--state failed` and add `--message "<why>"`, as specified in section 4. Never edit the graph or rewrite an existing trail entry to record progress. Parallel agents safely append lines to one trail; parallel agents rewriting one JSON object race and lose writes.

## 6. Use one node per unit of work

Keep development, verification, judging, and retries as roles and attempts against the same declared node. Give independently meaningful work its own node before the script exists. Creating a node for every agent call grows the graph during the run, forces the panel to lay it out again, and shifts every downstream node's depth under the reader.

## 7. Use labels the fleet table can enrich

Follow the conventions parsed by [autopilot/scripts/fleet.ts](../../autopilot/scripts/fleet.ts):

- Use `dev:<ref>#<attempt>` for development, or `dev-<engine>:<ref>#<attempt>` with a lowercase alphabetic engine name for an external developer.
- Use `verify:<ref>#<attempt>`, `reverify:<ref>#<attempt>`, `requalify:<ref>#<attempt>`, `judge:<ref>#<attempt>`, or `fix:<ref>#<attempt>` for those roles.
- Use `review:<lens>#<attempt>` for a review lens.
- Use `done:<ref>` or `block:<ref>` for terminal helpers.
- Use `scout-wave-<number>` for wave scouting and `commit-post-loop` for the post-loop commit helper when those activities exist.

Keep the entry's role accurate even when using a custom label. An unparsed label loses display enrichment for ref, attempt, and lens; the entry's own role still classifies the row. Treat this as a display-quality loss, not a broken run or a harmless naming choice. Keep the explicit prompt/trail identity from rule 4 regardless of label parsing.

## 8. Print the full watch command

Close the authoring explanation with the exact invocation in [Deckplan's closing step](../SKILL.md#closing-step-show-how-to-watch). Replace its placeholders with the absolute installed script path and this run's absolute directory. Account for the installed reader limitation described there. There is deliberately no run-listing command and no default path; omitting the invocation leaves the reader with a conforming run and no way to find it.

## 9. Reset before a re-run, never during one

Before a re-run, confirm the previous run has stopped. Ask the user before touching the existing trail. On approval, move it aside using the archive naming in graph-contract section 4, or delete it. Preserve the graph unless its topology changed. Only then prepare to start the new run. The fixed workflow slug reuses the same directory, so an uncleared trail makes every previously completed node read as done before this run touches it.

Before any new agent starts, write a fresh run identifier beside the graph as specified in section 2. Interpolate that same value into every initial prompt the script builds. Clearing the trail alone does not reset attribution: transcript membership is matched from first-message text, and the directory path is identical on each run. A fresh run identifier separates last run's spend from this run's nodes. An elapsed-time window cannot separate a failed run from an immediate re-run.

Once the run begins, allow agents only to append to the trail. Never let an agent inside the run reset, move, delete, or rewrite it. This prevents inherited completion, inherited spend, two runs interleaving into an unreadable trail, and silent destruction of the audit record.

## Before the first run

Work through graph-contract section 7's conformance checklist for the graph, the run identifier, and the prepared prompts. It is the single copy; do not restate it here. Then check the three items this guide adds about the script itself:

- [ ] Is the complete graph fixed before the script, so layout has the whole node set?
- [ ] Does the script use only Workflow globals, with no imports or filesystem access?
- [ ] Do roles and retries reuse their declared node, with labels following the fleet convention?
