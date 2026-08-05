# FOUNDATION-02: Freeze the ADR template and conventions

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: foundation/03, foundation/04, promote/01
> **Status**: done

## Goal

Every field an ADR carries — sections, status vocabulary, numbering, evidence format — is specified in one file on disk: the prose rulebook the drafting agent reads, and the reference the validator's rules are written against.

The validator does not parse this file at run time; it encodes the same rules in code, because a rule expressed as prose is not executable and a rule expressed twice drifts. **That drift is a real risk, so make the file diffable against the rule list**: state every rule under the name the validator uses, so a reader can line the two up in one pass. All eleven, each with the prose requirement it enforces:

| Rule name | What the file must state |
|---|---|
| `filename` | Records live at `docs/adr/NNNN-<kebab-title>.md`, four-digit zero-padded. |
| `id-mismatch` | The H1's `ADR-NNNN` number equals the filename's number. |
| `missing-section` | All five section headings are present: Context, Considered alternatives, Decision, Consequences, Evidence. |
| `bad-status` | Status is exactly one of `Accepted`, `Proposed`, `Superseded`, `Deprecated`, and the line is never absent. |
| `bad-date` | Date is present and `YYYY-MM-DD`. |
| `superseded-no-link` | A `Superseded` record carries a `Superseded by:` line. |
| `deprecated-linked` | A `Deprecated` record carries no successor link — deprecation means nothing replaced it. |
| `link-missing` | A referenced `ADR-NNNN` names a record that exists. |
| `link-not-mutual` | Supersession is declared in both directions. |
| `self-link` | A record never references its own id. |
| `empty-evidence` | The Evidence section holds at least one entry — a **warning**, not an error, because a hand-written record legitimately has nothing to cite. |

Changing a rule here means changing it there. The matching names are what make an omission visible instead of invisible.

## Files to create / modify

- `packages/chronicle/skills/adr/references/adr-template.md` (new) — the template plus the rules that govern each field

This is a documentation task. It writes no TypeScript and no tests. Create the parent directories as needed; `packages/chronicle/skills/adr/` does not exist yet.

Write the file in English, matching the rest of the plugin's shipped files.

## Implementation notes

The reference file has two jobs, and both must be in it: it is the **shape** a drafting agent copies, and it is the **rulebook** a validator enforces. Write the template first, then one short section per rule.

### The template body

Ship it so that copying it and filling the three marked slots yields a valid record — and so that **the only invalid state is a slot left unfilled**. The obvious shape fails that: a literal `- Supersedes: ADR-NNNN (optional)` line is a real supersession link pointing at a record that does not exist, and both the index reader and the validator read it exactly that way. A default output that fails validation teaches the drafter to ignore validation.

So the block carries only what every record has, with exactly three substitution slots and nothing else:

```md
# ADR-NNNN: Title

- Status: Accepted
- Date: YYYY-MM-DD

## Context
## Considered alternatives
## Decision
## Consequences
## Evidence
```

State the three slots explicitly right under it — `NNNN`, `Title`, and the date — and say that a record still carrying any of them is broken. `ADR-NNNN` is a shape, not a value; the parser rejects it as an id, which is the correct behaviour and not something to work around.

Then show it once filled in, so there is a concrete target rather than only a pattern:

```md
# ADR-0001: Cockpit trail is an inbox

- Status: Accepted
- Date: 2026-08-06
```

All five section headings are required in every record. `Status` shows `Accepted` because that is what the promote path writes; the other three values and when each applies are in the status table below.

Then, immediately after, document the two lifecycle lines as additions rather than fields to fill in — and say what each looks like filled in, so nobody transcribes a placeholder:

```md
- Supersedes: ADR-0003        ← add only when this record replaces ADR-0003
- Superseded by: ADR-0007     ← add only when ADR-0007 has replaced this one
```

Spell out the rule in a sentence: never leave `ADR-NNNN` literally in a record. It is a shape, not a value, and a record carrying it is broken in a way that looks deliberate.

### Numbering

Files live at `docs/adr/NNNN-<kebab-title>.md`, with a four-digit zero-padded number. The ID written in the H1 is `ADR-NNNN`, using the same four digits.

The next number is the highest existing number plus one. An empty or missing `docs/adr/` directory yields `0001`.

Give a worked example in the file so there is no ambiguity between the filename form and the ID form. For instance, the file `docs/adr/0002-adr-status-reports-implementation-state.md` opens with the heading `# ADR-0002: ADR status reports implementation state`.

### Titles

Titles are sentence case and name the **decision**, not the area.

- Good: `ADR-0003: Chronicle owns its own trail reader`
- Bad: `ADR-0003: Trail reader`

A reader scanning the directory listing should be able to tell what was decided without opening anything.

### Status is implementation state, not review state

Reproduce this table in the file:

| Value | Means | Requires |
| --- | --- | --- |
| `Accepted` | Live in the code today | — |
| `Proposed` | Drafted ahead of the work | — |
| `Superseded` | Replaced by a named successor | a `Superseded by: ADR-NNNN` line |
| `Deprecated` | No longer applies, with no successor | no successor link |

Record the reasoning, not just the table. The conventional ADR lifecycle tracks agreement between people and runs forward: someone drafts `Proposed`, the team reviews, it becomes `Accepted`, then the work starts. This flow runs backward — a candidate only exists because the decision was already made, already implemented, and already recorded in the trail. Calling that `Proposed` describes it wrongly. So the promote path writes `Accepted`.

Also record what was rejected: defaulting everything to `Proposed` was considered and turned down, because no moment in this workflow would ever promote them later. Every ADR would sit at `Proposed` forever and the field would carry no information at all.

### Lifecycle links

State all three rules:

1. `Superseded` requires a `Superseded by: ADR-NNNN` line naming a real successor. A `Superseded` status with no successor link is invalid.
2. `Deprecated` carries no successor link. It means the decision no longer applies and nothing replaced it.
3. Supersession is written in **both** directions: the replacement carries `Supersedes: ADR-NNNN`, and the original carries `Superseded by: ADR-NNNN`.

State the ordering too: create the replacement first, then update the original's link. And state the preservation rule — when an ADR's lifecycle metadata changes, its body is never rewritten. Its `## Context`, `## Decision`, and `## Consequences` describe what was true when the decision was made, and editing them to look cleaner destroys the only record of that.

### Evidence format

This is the field most likely to be got wrong, so specify it concretely rather than describing it.

Each evidence item embeds a **stable summary written into the ADR itself**, plus the session id, the entry id, and the date. The summary has to carry the argument on its own.

It must never point at a `.cockpit` path. Those logs can be deleted by hand, and the directory never enters git, so a path reference is guaranteed to rot. Session ids and entry ids are **historical labels, not lookup keys** — they say where the reasoning came from, they do not promise it is still fetchable.

Include a filled-in example so the drafting agent has a shape to copy:

```md
## Evidence

- **The registry sees under half the trail** — measured 63 log files against 27 registry
  entries; the registry reaps past 14 days on every write, and the lost tail is the only
  part that shows whether a decision held.
  Session `0b63c02f-3284-4c9c-a5e9-b346de643f21`, entry `4fbc8de9-…`, 2026-07-14.
```

Note the test the example passes: a reader who has never seen the source log understands both the finding and the measurement behind it.

### What evidence excludes

State the exclusion list plainly: no secrets, no credentials, no personal data, and no raw transcript text. An evidence entry is a written summary, not a quotation of a session.

## Acceptance criteria

- [x] `packages/chronicle/skills/adr/references/adr-template.md` exists.
- [x] Its copyable template block contains all five section headings, **no** placeholder lifecycle links, and exactly three substitution slots — `NNNN`, `Title`, and the date. Filling those three and nothing else produces a record that passes validation; leaving any of them is the only way the copied shape can fail. The two optional link lines appear separately, each shown filled in with a real id, alongside the rule that a literal `ADR-NNNN` must never survive into a written record.
- [x] It states the numbering rule and shows one worked example pairing a `docs/adr/` filename with its `ADR-NNNN` heading.
- [x] It reproduces the four-row status table with the "Requires" column filled for every row.
- [x] It records why the promote path writes `Accepted`, including the rejection of a `Proposed` default and the reason that rejection stands.
- [x] It states the bidirectional supersession rule, the create-replacement-first ordering, and the rule that an ADR's body is never rewritten when its lifecycle metadata changes.
- [x] It contains a filled-in example evidence entry carrying a summary, a session id, an entry id, and a date, and citing no filesystem path.
- [x] It states the exclusion list: secrets, credentials, personal data, and raw transcript text.
- [x] All eleven rule names appear in the file, each stating the requirement it enforces: `filename`, `id-mismatch`, `missing-section`, `bad-status`, `bad-date`, `superseded-no-link`, `deprecated-linked`, `link-missing`, `link-not-mutual`, `self-link`, `empty-evidence` — with `empty-evidence` marked a warning rather than an error.

## Verification

- [x] Run `grep -n '^## \(Context\|Considered alternatives\|Decision\|Consequences\|Evidence\)$' packages/chronicle/skills/adr/references/adr-template.md` and confirm all five ADR section headings are present.
- [x] Run `grep -n 'Supersede' packages/chronicle/skills/adr/references/adr-template.md` and confirm every hit sits in the lifecycle addendum or the rules prose — **none inside the copyable block**. A link line in that block is the placeholder defect this task exists to prevent.
- [x] Confirm the copyable block's only substitution slots are `NNNN`, `Title`, and the date, and that a worked filled-in example (`# ADR-0001: …` with a real date) appears beside it.
- [x] Run `grep -n 'cockpit' packages/chronicle/skills/adr/references/adr-template.md` and confirm every hit is prohibition or provenance prose — none inside the example evidence entry.
- [x] Read the example evidence entry and confirm a reader could understand the decision and its measurement from it alone, without opening any log file.
- [x] Hand a copy of the file to a fresh reader (or reread it cold) and draft one throwaway ADR from it without consulting anything else. If a field's rule had to be guessed, the file is incomplete.
- [x] Run `git status --short -- packages/chronicle/skills/adr/references/adr-template.md` and confirm the path is dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

This task ships no code, so two dimensions are retargeted. Read **Test coverage** as *specification coverage*, and **Interface & readability** as *usability by a drafting agent*. The weights are unchanged.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A stated rule contradicts the frozen decisions — e.g. the promote path is described as writing `Proposed`, or evidence is told to cite a log path | Rules are right but incomplete: the status table is present without its "Requires" column, or numbering is described without a worked filename-and-ID pair | Every rule matches the frozen decisions, and the numbering, status, lifecycle, and evidence sections are each usable without interpretation |
| Test coverage | ×2 | Only the happy shape is specified; no rule says what makes an ADR invalid | The valid cases are covered, but the failure cases are not — nothing says a `Superseded` without a successor is invalid, or that a `Deprecated` must not carry one | Every field an ADR can carry has a stated rule, including the failure cases: `Superseded` with no successor, `Deprecated` with one, and evidence that points at a path instead of embedding a summary |
| Interface & readability | ×1 | The template is described in prose rather than given literally, so it cannot be copied | The template is present but the rules are scattered, so a drafter must piece the format together across sections | A drafting agent could produce a valid ADR from this file alone: the template is literal, and each rule sits under a heading naming the field it governs |
| Assumptions & docs | ×1 | Rules are asserted with no reasoning, so a later reader cannot tell which are load-bearing | The reasoning is present but partial — the `Accepted` choice is stated without the rejected `Proposed` default | Each non-obvious rule carries its *why*: why status tracks implementation state, why `Proposed` as a default was rejected, and why evidence embeds a summary instead of a reference |

## Out of scope

- Writing any actual ADR — Deferred. Reason: the first real one comes from a live triage run, after this plan is executed; drafting one now would be inventing content to fit the template.
- Implementing validation of these rules — Deferred. Reason: a separate task in the promote bucket owns the validator script; this task only has to state the rules precisely enough for that script to enforce them.
- Choosing MADR, adr-tools, or any external ADR framework — Deferred. Reason: the design pins a small repository-owned Markdown format for the first version, and the plugin takes no external dependencies.
- Creating the `docs/adr/` directory or any index of ADRs — Deferred. Reason: a separate reader owns discovering existing ADRs and computing the next number; this task defines the format that reader will parse.
