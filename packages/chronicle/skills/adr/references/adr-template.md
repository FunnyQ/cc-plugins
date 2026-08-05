# ADR format and validation rules

## Copyable template

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

### Substitution slots

Replace exactly three slots before saving a record:

- Replace `NNNN` with a four-digit, zero-padded number.
- Replace `Title` with a sentence-case title.
- Replace `YYYY-MM-DD` with a date in that format.

A record that carries any slot literally is broken. For example, a record with
`# ADR-NNNN:` is invalid. After all three slots are filled, the template is a valid
record without any other additions. Its empty Evidence section produces a warning,
not an error.

### Filled-in example

```md
# ADR-0001: Cockpit trail is an inbox

- Status: Accepted
- Date: 2026-08-06

## Context
## Considered alternatives
## Decision
## Consequences
## Evidence
```

## Lifecycle link additions

Add lifecycle links only when they describe an actual relationship. Write them
with the related record's real ID:

```md
- Supersedes: ADR-0003        ← add only when this record replaces ADR-0003
- Superseded by: ADR-0007     ← add only when ADR-0007 has replaced this one
```

Never leave either line as a placeholder containing `ADR-NNNN`. The literal
`ADR-NNNN` is a shape pattern, not a value. A record carrying it is invalid.

## Numbering

Store records at `docs/adr/NNNN-<kebab-title>.md`. Use a four-digit, zero-padded
number. Write the same four digits in the H1 ID as `ADR-NNNN`.

Choose the next number by adding one to the highest existing number. Use `0001`
when the directory is empty.

For example, this filename and H1 correspond:

- Filename: `docs/adr/0002-adr-status-reports-implementation-state.md`
- H1: `# ADR-0002: ADR status reports implementation state`

## Titles

Write titles in sentence case. Name the decision, not merely its area. A reader
scanning the directory should understand the decision without opening the file.

- Good: `ADR-0003: Chronicle owns its own trail reader`
- Bad: `ADR-0003: Trail reader`

## Status

| Value | Means | Requires |
| --- | --- | --- |
| `Accepted` | Live in the code today | — |
| `Proposed` | Drafted ahead of the work | — |
| `Superseded` | Replaced by a named successor | a `Superseded by: ADR-NNNN` line |
| `Deprecated` | No longer applies, with no successor | no successor link |

The conventional ADR lifecycle runs forward: draft, review, accept, then build.
This workflow runs backward because decisions are documented after implementation.
Calling an implemented decision `Proposed` describes its state wrongly. The promote
path therefore writes `Accepted`.

Defaulting to `Proposed` was considered and rejected. No moment in this workflow
would promote those records later. Every ADR would remain `Proposed` forever, so
the status would carry no information. Status therefore tracks implementation
state, not review state.

## Lifecycle links

**Rule 1:** `Superseded` requires a `Superseded by: ADR-NNNN` line naming a real
successor. A `Superseded` status with no successor link is invalid. This is the
`superseded-no-link` rule.

**Rule 2:** `Deprecated` carries no successor link. It means the decision no longer
applies and nothing replaced it. This is the `deprecated-linked` rule.

**Rule 3:** Write supersession in **both** directions. The replacement carries
`Supersedes: ADR-NNNN`. The original carries `Superseded by: ADR-NNNN`. This is the
`link-not-mutual` rule.

Create the replacement first. Then update the original's link. This ordering
prevents orphaned links temporarily.

When an ADR's lifecycle metadata changes, never rewrite its body. The `## Context`,
`## Decision`, and `## Consequences` sections describe what was true when the
decision was made. Editing them destroys the only record of that historical state.

## Evidence format

The Evidence section must hold at least one entry. An empty section triggers the
`empty-evidence` **warning**, not an error, because hand-written records legitimately
have nothing to cite.

Each entry embeds a **stable summary written into the ADR itself**, plus metadata.
The summary must carry the argument on its own without consulting the source log.

Evidence must never point at a `.cockpit` path because logs can be deleted by hand.
Session IDs and entry IDs are historical labels, not lookup keys. Exclude secrets,
credentials, personal data, and raw transcript text.

Use this shape:

```md
## Evidence

- **The registry sees under half the trail** — measured 63 log files against 27 registry
  entries; the registry reaps past 14 days on every write, and the lost tail is the only
  part that shows whether a decision held.
  Session `0b63c02f-3284-4c9c-a5e9-b346de643f21`, entry `4fbc8de9-…`, 2026-07-14.
```

This example stands alone: a reader who has never seen the source log can understand
both the finding and the measurement without opening anything.

## Validation rule summary

| Rule | Requirement | Severity |
| --- | --- | --- |
| `filename` | Records live at `docs/adr/NNNN-<kebab-title>.md`, with a four-digit, zero-padded number. | Error |
| `id-mismatch` | The H1's `ADR-NNNN` number equals the filename's number. | Error |
| `missing-section` | All five section headings are present: Context, Considered alternatives, Decision, Consequences, and Evidence. | Error |
| `bad-status` | The Status line is present and its value is exactly one of `Accepted`, `Proposed`, `Superseded`, or `Deprecated`. | Error |
| `bad-date` | The Date line is present and uses `YYYY-MM-DD`. | Error |
| `superseded-no-link` | A `Superseded` record carries a `Superseded by:` line. | Error |
| `deprecated-linked` | A `Deprecated` record carries no successor link. | Error |
| `link-missing` | Every referenced `ADR-NNNN` names a record that exists. | Error |
| `link-not-mutual` | Supersession is declared in both directions. | Error |
| `self-link` | A record never references its own ID. | Error |
| `empty-evidence` | The Evidence section holds at least one entry. | Warning |
