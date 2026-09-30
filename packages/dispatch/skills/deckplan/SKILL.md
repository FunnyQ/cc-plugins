---
name: deckplan
version: 0.1.0
description: >-
  Reference-only guide that explains how to author Workflow scripts whose runs
  can be watched on flightdeck. Runs no interview, scaffolds nothing, generates
  no artifacts, and bundles no scripts.
when_to_use: >-
  When the user asks for guidance on authoring a Workflow script for flightdeck,
  or invokes dispatch:deckplan. Do NOT trigger for running an existing task tree
  (use autopilot), or for a passing mention of a workflow, such as reporting
  that a workflow returned an error.
---

# Deckplan

Use this reference-only skill to explain Workflow script authoring for flightdeck. Run no interview, scaffold nothing, and generate no script or other artifact. Treat the steps below as guidance for the author, not actions this skill executes.

## Read the right reference

Read [authoring guidance](references/authoring.md) for prompt construction, lifecycle commands, labels, reset discipline, and the before-run checklist.

Read the normative specification at [packages/dispatch/skills/autopilot/references/graph-contract.md](../autopilot/references/graph-contract.md) for the on-disk layout, directory naming, graph shape, field defaults, validation, event types, and state resolution. This skill points at it rather than restating it, so the two cannot drift. Copy its shell command shapes verbatim, because the prompts being prepared need the exact flags.

## Short-form rules

1. Declare the complete graph before writing the script; runtime-dependent topology cannot be drawn because depth requires the whole node set.
2. Use only the Workflow globals; filesystem access and imports are unavailable, so attempted script-side trail writes leave an empty panel. Put every run-time write in a spawned agent's fully spelled-out shell command.
3. Interpolate resolved absolute paths into prompts; shell variables passed to a child can expand to empty and produce a path reported as "not set".
4. Open every agent with its announce command and close it with its completion command; mismatched node ref, role, or attempt between prompt and trail leaves a row without spend.
5. Declare node completion through a state entry; concurrent JSON rewrites race and lose writes, while trail appends are safe.
6. Assign one node per unit of work; making roles or retries new nodes grows the graph during the run and shifts downstream depths.
7. Follow the fleet label convention; an unparsed label loses ref, attempt, and lens enrichment while the entry's role still classifies the row.
8. Close the explanation with the full watch command below; there is no run-listing command or default run path to help the reader find it.
9. Reset only before a re-run: confirm the previous run stopped, ask the user, then archive or delete the trail. Write a fresh `run.id` beside the graph and interpolate it into every initial prompt. Never reset inside a run; otherwise old completion and spend leak into new work, live runs interleave, or the audit record is destroyed.

## Closing step: show how to watch

Use the resolved absolute installed `autopilot/scripts` path and run directory to print this full invocation, with both placeholders replaced and no shell variables left:

```bash
bun "<absolute autopilot/scripts path>/flightdeck.ts" --plan "<absolute run directory>"
```

Check the installed reader's graph support before describing the invocation as usable: a launcher that reports `--plan must contain a tasks/ directory` predates graph support. A graph-capable build names both sources in that message. Use a graph-capable flightdeck build for graph runs; do not scaffold a dummy task tree to bypass that check.
