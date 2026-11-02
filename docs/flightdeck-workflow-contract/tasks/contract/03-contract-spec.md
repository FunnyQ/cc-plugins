# CONTRACT-03: Write the graph contract specification

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01, contract/02
> **Blocks**: deck/01, skill/01
> **Status**: done

## Goal

A workflow author who has never seen this project can read one document, satisfy
the graph-and-trail format, and get a rendered dashboard — without opening a
single source file.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/graph-contract.md` (new) — the
  normative specification

The path is relative to the repo root `/Users/funnyq/Projects/q-lab/cc-plugins`.

## Implementation notes

### Why the document lives here

The specification sits with the **reader**, not the writer. `flightdeck` owns
the format it parses, so the format's definition belongs beside its loader. The
authoring skill that teaches people to produce conforming workflows will point
at this file rather than restate it — one normative source, and a second
document that references it. State this placement rationale in the document's
opening section, so a later contributor does not "helpfully" move it next to the
authoring skill and fork the definition in two.

### This is not a copy job

The shared context file listed under Required reading already carries every
substantive rule: the on-disk layout, the `graph.json` shape and its validation
list, the three trail entry kinds, the CLI surface, the narrow node type, the
state-resolution order, and the prompt-text conventions token attribution
depends on. Read it as the source of truth and do not contradict it.

But that file is written for executors who already know why this plan exists.
The reference is written for a stranger who arrived from a search result. The
work is re-framing: lead with what the reader needs first, mark every field
required or optional, and make each normative statement testable. If a
statement in the context file is ambiguous when read cold, resolve the ambiguity
in the specification and note that you did.

### Required sections

Write all seven, in this order.

**1. Purpose and scope.** One paragraph on what the format is for. Then the
sentence a reader needs before anything else: the graph is declared **before**
the run and the events are written **during** it, because a Workflow script has
no filesystem access and cannot import anything. Every other rule in the
document follows from that constraint, so a reader who skips this paragraph will
find the rest arbitrary.

**2. On-disk layout.** The directory tree, including the per-run identifier file
that sits beside the graph. The `XDG_DATA_HOME` override rule.
And why the slug is chosen by the author rather than taken from the Workflow
tool's own run id: that id does not exist until the run starts, and the script —
which must already contain the absolute path — is written before that.

**3. `graph.json`.** A complete annotated example. Every field marked
**required** or **optional with its default**. The node-ref shape given as a
regex. Then the full validation list, every entry of it.

Two rules govern failure here, and they must be presented as one deliberate
asymmetry with its reason, never as two unrelated bullets:

- A **malformed file** yields no nodes at all. A partly loaded graph renders as
  a run in progress, which misleads worse than an empty panel carrying the
  error.
- A **dangling dependency ref** inside an otherwise valid file is removed from
  that node's dependency array and reported. The spec must say _removed_, not
  merely "ignored" or "dropped from the drawing" — the distinction is load
  bearing. The readiness rule counts an unresolvable ref as unmet, so a ref left
  in the array would block its node forever on something that does not exist.
  Removing it is what makes the layout and the readiness rule describe the same
  graph.

The first is a broken contract; the second is ordinary incompleteness. Say so.

**4. The event trail.** All three entry kinds as TypeScript types, copied
exactly. The CLI commands verbatim. The append-only rule — **scoped to a single
run**, with the re-run reset procedure stated alongside it, or a reader
re-running a workflow has a prohibition and no way to obey it. And the two
prohibitions, each with its reason: nothing may rewrite the trail mid-run, and no agent
may edit the graph file — a JSONL append is concurrency-safe under parallel
agents, a JSON rewrite is not.

Also state what an older reader does when it meets a trail containing the newest
entry kind: it drops those lines and degrades to the picture the remaining
entries support. It does not throw. That is the back-compat guarantee in both
directions, and an author needs to know their trail stays readable.

**5. State resolution.** The five-step order, numbered, in order. Close with the
guarantee it exists to provide: a run is never presented as complete while any
node reads invalid.

**6. Token attribution.** Three prompt-text facts, each paired with the concrete
thing the author must do about it. This section alone decides whether a reader's
workflow shows real token figures or `N/A` everywhere, so write it as
instructions, not as description. A reader must finish this section knowing
exactly what to put in an agent prompt and why each part is there.

**7. Conformance checklist.** A short list an author walks before their first
run. Every item must be checkable by looking at their own files — not by
running the dashboard and squinting at it.

### The worked example

Include one small graph: three or four nodes across two lanes, with a
dependency crossing between them, plus the first few matching trail lines. The
reader has to see both halves fit together, because the two files are written at
different times by different actors and nothing in either one points at the
other.

Keep the example small enough to read in one screen. It is an illustration, not
a test fixture.

### Style

Match the prose-first house style of the sibling reference documents in the same
directory. One instruction per sentence. Condition before instruction. Warning
before the step it affects. Copy every identifier, command, and path exactly.

**Every rule states the failure it prevents.** A rule whose reason is missing
gets ignored the first time it is inconvenient — that is the single most
important stylistic requirement here, because this document's whole job is to be
followed by someone with no other context.

## Acceptance criteria

- [x] The file `packages/dispatch/skills/autopilot/references/graph-contract.md` exists and opens by stating that the graph is declared before the run and the events are written during it, with the no-filesystem-access reason.
- [x] All seven required sections are present, in the specified order.
- [x] Every `graph.json` field is explicitly marked required, or optional with its default stated.
- [x] The node-ref shape appears as a regex, and every ref in the document matches it.
- [x] The validation list is complete and matches the loader's stated behaviour, with no rule added and none omitted.
- [x] The all-or-nothing rule and the drop-and-report rule are presented together as one asymmetry, with the reason for each side.
- [x] All three trail entry kinds appear as TypeScript types, and every CLI command is reproduced verbatim.
- [x] The state-resolution order appears as five numbered steps, followed by the never-complete-while-invalid guarantee.
- [x] Each of the three attribution facts is paired with a concrete author action.
- [x] The worked example carries both a graph and matching trail lines.
- [x] No instruction in the document requires opening source code to follow.

## Verification

This task writes prose, so its gates are read-throughs — but each one is a
concrete check, not an impression.

- [x] Read the document beside `../_context/contract.md` and confirm no normative statement contradicts it. List any place the specification resolves an ambiguity the context file left open.
- [x] For every identifier, type name, CLI flag, and path quoted in the document, grep the source file it comes from and confirm the spelling matches exactly. A type that has drifted from its source is a correctness failure, not a typo.
- [x] Check every node ref in the worked example against the ref regex the document itself states.
- [x] Walk the conformance checklist against the worked example and confirm the example passes every item.
- [x] Confirm the document names no task file and no plan document — it must stand alone for a reader outside this project.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                | 2–3 (below bar)                                                                                  | 4–5 (pass)                                                                                                          |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A normative claim contradicts the code or the shared context, or a validation rule is invented or dropped | Claims are broadly right but a field's requiredness, a default, or a type is wrong or unstated   | Every normative claim matches the code and the shared context; requiredness and defaults are stated for every field |
| Backward compatibility  | ×2     | Describes existing behaviour as changing, or omits what an old reader does with a newer trail             | States the old-reader behaviour but leaves the guarantee vague, or blurs which path is unchanged | States the degrade-not-throw guarantee explicitly and makes clear the existing task-tree path is untouched          |
| Test coverage           | ×2     | Rules are asserted with no example and no checklist item                                                  | Some rules demonstrated; the worked example or the checklist is thin or partial                  | Every rule is demonstrated by the worked example or checkable from the conformance checklist                        |
| Interface & readability | ×1     | Reference-manual dump with no reading order; a stranger cannot find the rule they need                    | Complete but unordered, or reasons missing from several rules                                    | Sections in a deliberate order, one instruction per sentence, every rule carrying the failure it prevents           |
| Assumptions & docs      | ×1     | Resolves an ambiguity silently, or leaves a normative statement ambiguous                                 | Resolves ambiguities but does not flag which ones were open                                      | Every ambiguity resolved from the shared context is called out where a reader will hit it                           |

## Out of scope

- **The authoring skill that teaches people to write conforming workflows** — Deferred. A separate task in the skill bucket owns it, and it will link to this document rather than restate the rules. Writing both here would fork the definition.
- **Any implementation** — Deferred. This task produces prose only. The loader, the new entry kind, and the narrow node type are each owned elsewhere; a specification that also changes code cannot be reviewed as a specification.
- **Documenting the existing markdown task-file format** — Deferred. That path is unchanged by this work and already documented in the flightplan skill's own references. Re-documenting it here would create a second source that drifts.
