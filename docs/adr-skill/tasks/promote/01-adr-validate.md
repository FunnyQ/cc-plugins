# PROMOTE-01: Validate a written ADR

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: foundation/02, foundation/04
> **Blocks**: promote/02
> **Status**: todo

## Goal

A script that says whether an ADR on disk is structurally valid, so a malformed or half-linked
record cannot survive a drafting run unnoticed.

## Files to create / modify

- `packages/chronicle/skills/adr/scripts/adr-validate.ts` (new) — the validator
- `packages/chronicle/skills/adr/scripts/adr-validate.test.ts` (new) — its unit tests

## Implementation notes

### Where this sits

The validator imports `parseAdr`, `buildIndex`, `formatAdrId`, and `adrFilename` from the ADR index
reader at `packages/chronicle/skills/adr/scripts/adr-index.ts`. That module already parses Markdown
into `AdrMeta` and already **reports** link problems. This validator **decides what fails**.

Keep that split explicit: do not re-parse Markdown here, and do not re-derive filenames or ids. If a
rule needs a fact the index does not expose, extend the index rather than growing a second parser
inside the validator.

Two of the rules below need body structure, and the index already supplies it — `AdrMeta` carries
`sections: string[]` (the H2 headings, in document order) and `evidenceEntries: number` (top-level
list items under `## Evidence`, `0` when the section is absent or empty). So `missing-section` is
a set difference against `sections`, and `empty-evidence` is `evidenceEntries === 0`. Neither rule
reads the file again.

Concretely, `validateOne` starts by calling `parseAdr(content, path)` and works from the returned
`AdrMeta`. A `null` return is itself a violation — an unparseable record fails `filename` or
`id-mismatch` depending on which part did not match — and every remaining rule short-circuits,
because there is nothing to check them against.

**`validateDir` must check `index.skipped`, not only `index.adrs`.** The index sorts every `.md` in
the directory into one of those two lists; a file that failed to parse lands in `skipped` with a
reason. Reading only `adrs` would mean a malformed record and a badly-named file are the two things
this validator can never see — they would pass by being unreadable, which inverts the entire point.
So enumerate both: every entry in `skipped` produces a violation under the rule its reason maps to
(`no-h1` and `bad-h1` → `id-mismatch`; a filename that does not match the pattern → `filename`),
except a file whose name is plainly not meant to be a record. Treat `README.md` as the one
exemption and say so, rather than inventing a general heuristic.

### Export surface

```ts
export type Severity = "error" | "warning";

export type Violation = {
  rule:
    | "filename"          // does not match NNNN-<kebab-title>.md
    | "id-mismatch"       // the H1 id does not match the filename's number
    | "missing-section"   // one of the five required sections is absent
    | "bad-status"        // status is absent or outside the four allowed values
    | "bad-date"          // date is absent or not YYYY-MM-DD
    | "superseded-no-link"// Superseded without a Superseded by line
    | "deprecated-linked" // Deprecated carrying a successor link
    | "link-missing"      // references an ADR id with no file
    | "link-not-mutual"   // supersession declared in only one direction
    | "self-link"         // references its own id
    | "empty-evidence";   // the Evidence section has no entries
  severity: Severity;
  path: string;
  detail: string;
};

export type ValidateResult = { checked: number; violations: Violation[]; ok: boolean };

/** Pure. Validates one already-parsed ADR against the rules that need no directory context. */
export function validateOne(content: string, path: string): Violation[];

/** Adds the cross-file link rules on top of validateOne. */
export function validateDir(dir: string): Promise<ValidateResult>;
```

`validateOne` is the pure function the tests lean on. It takes content and a path and covers every
rule that does not need to see sibling files — that is nine of the eleven. Only `link-missing` and
`link-not-mutual` need the directory, so only those live in `validateDir`.

`self-link` belongs in `validateOne`, not `validateDir`, and the reason is worth a line: a record
declaring itself its own successor is detectable from that record alone — its id and its lifecycle
targets are both right there, and no sibling file changes the answer. Putting it in the directory
pass would let `--file` call a self-referential record clean, which is exactly the mode someone uses
to check a draft before writing it.

Keeping `validateOne` filesystem-free is what makes the test suite cheap: a rule case is a string
literal, not a temp directory.

### The five required sections

Quoted here so the executor does not have to look them up. All five must be present, as level-two
headings, in any valid ADR:

```md
## Context
## Considered alternatives
## Decision
## Consequences
## Evidence
```

A missing heading is one `missing-section` violation per absent heading, with the heading name in
`detail`.

### The four statuses and the lifecycle rules

| Status | Link requirement |
| --- | --- |
| `Accepted` | none |
| `Proposed` | none |
| `Superseded` | **requires** a `Superseded by: ADR-NNNN` line, whose target must also exist |
| `Deprecated` | **must not** carry a successor link |

The two lifecycle rules are easy to invert, so state them as separate rule names rather than one
generic check:

- `superseded-no-link` — the status is `Superseded` and there is no `Superseded by:` line at all.
  Nothing more. Whether the named successor *exists* is a different question, answerable only with
  the directory in hand, and it already has its own rule — a link that names an absent id is
  `link-missing`, reported by `validateDir`. Folding the two together would put a rule that needs
  sibling files inside a function that is specified as pure, and would report one defect twice.
- `deprecated-linked` — the status is `Deprecated` and a `Superseded by:` line is present.
  Deprecation means nothing replaced it. A deprecated record carrying a successor is not a
  formatting slip; it means the author meant `Superseded` and the reader will be misled.

Anything outside those four values, including an absent status line, is `bad-status`.

### Severity split

This is the one judgment call worth writing down, because the obvious choice is wrong.

Everything structural is an `error`. A record that cannot be read reliably is worse than no record
at all: it looks authoritative and is not.

`empty-evidence` is a `warning`. An ADR written by hand, rather than promoted from the decision
trail, legitimately has nothing to cite. Failing those would push authors toward inventing
citations, which is the opposite of what the evidence section is for.

So: `ok` is true when the violation list contains no `error`. Warnings never fail a run.

### CLI shape

```
bun adr-validate.ts                 # validates docs/adr under the repo root
bun adr-validate.ts <dir>           # validates a specific directory
bun adr-validate.ts --file <path>   # validates one file, skipping the two cross-file link rules
```

Print one line per violation in the shape `path:rule: detail`, so the output reads like a linter
rather than a JSON dump. Exit code is 0 when `ok` is true and 1 when any `error` is present.

`--file` deliberately skips the two cross-file link rules — `link-missing` and `link-not-mutual`. A
single file has no directory context, and reporting a missing successor the caller never asked about
would be noise. `self-link` still fires: it needs nothing but the record itself, and a draft that
names itself its successor is exactly what this mode should catch before anything is written.

### Empty and missing directories are valid

`validateDir` against a directory that does not exist, or one holding no ADRs, returns
`{ checked: 0, violations: [], ok: true }` and exits 0. There is nothing wrong with a repository
that has no ADRs yet, and this script runs in repositories that never will.

It creates nothing. It writes nothing. It never renames.

## Acceptance criteria

- [ ] `packages/chronicle/skills/adr/scripts/adr-validate.ts` and its `.test.ts` both exist.
- [ ] The validator consumes the ADR index reader for parsing and link facts, and contains no second
      Markdown parser of its own.
- [ ] `validateDir` enumerates `index.skipped` as well as `index.adrs`, so a file that failed to
      parse produces a violation rather than disappearing; `README.md` is the only exemption.
- [ ] All eleven rule names in the `Violation` union are implemented and reachable.
- [ ] Every rule the ADR template's prose states is implemented here under the same name, and every
      rule implemented here appears there. Read the two side by side and confirm neither carries a
      rule the other lacks — the template is the human-readable rulebook and this script is its
      executable counterpart, so a rule in only one of them is a silent divergence.
- [ ] A `Superseded` record with no successor link, and a `Deprecated` record carrying one, each
      produce an `error`.
- [ ] `empty-evidence` is emitted with severity `warning` and does not make `ok` false.
- [ ] A missing or empty directory returns `checked: 0` with no violations and exits 0.
- [ ] The process exit code is 1 if and only if at least one `error` violation was produced.
- [ ] `validateOne` performs no filesystem access and is callable with a plain string.

## Verification

- [ ] `bun test packages/chronicle/skills/adr/scripts/adr-validate.test.ts` passes with zero
      failures, holding at least one case per rule plus a clean ADR that produces no violations.
- [ ] Write a temporary fixture directory holding one valid ADR and one `Superseded` ADR with no
      successor link, run `bun packages/chronicle/skills/adr/scripts/adr-validate.ts <that dir>`,
      and confirm exit code 1 with exactly one error line.
- [ ] Run `bun packages/chronicle/skills/adr/scripts/adr-validate.ts <empty temp dir>` and confirm
      exit code 0 with `checked: 0`.
- [ ] Run the validator with `--file` against a single ADR that names an absent successor and confirm
      no cross-file link rule fires; then run it against one that names itself and confirm `self-link`
      does fire.
- [ ] `git status --short -- packages/chronicle/skills/adr/scripts/adr-validate.ts packages/chronicle/skills/adr/scripts/adr-validate.test.ts`
      shows both paths dirty.
- [ ] Do not run `bunx tsc --noEmit`; it floods with pre-existing unrelated errors in this repo.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A lifecycle rule is inverted, or a repository with no ADRs is reported as failing | Catches missing sections and bad statuses, but gets a lifecycle rule backwards, treats `empty-evidence` as an error, or throws on an absent directory | All eleven rules fire on the right input, both lifecycle inversions are distinguished, and empty or missing directories exit 0 |
| Test coverage | ×2 | No tests, or only a single happy-path case | One case per rule name but no clean-file case, and no test that an empty directory passes | A case per rule, both lifecycle inversions, a clean ADR producing nothing, and the empty-directory and `--file` paths |
| Interface & readability | ×1 | `validateOne` reaches the filesystem, or rules are stringly-typed instead of the union | Types are present but violations carry unstructured messages instead of a `rule` field | `validateOne` is pure, the `Violation` union is exhaustive, and the split against the index reader is obvious from the code |
| Assumptions & docs | ×1 | The severity split is unexplained, so a later reader "fixes" the warning into an error | The severity split is noted but not justified | A comment states why `empty-evidence` is a warning, and why `--file` skips the cross-file link rules while still firing `self-link` |

## Out of scope

- Repairing violations — Deferred. Reason: this script reports; a human or the drafting agent fixes,
  and a validator that rewrites files would become a second writer in a plan that deliberately has
  exactly one.
- Judging whether an ADR's content is *good* — Deferred. Reason: that is what the promotion
  threshold and the human confirmation gate are for, and no script can do it.
- Renumbering or renaming files — Deferred. Reason: nothing here writes, and renumbering would break
  every `Supersedes` link already pointing at the old id.
- Validating that an evidence entry's session id resolves to a real log file — Deferred. Reason:
  session ids are historical labels, not lookup keys; the logs are gitignored and can be deleted by
  hand, so a resolvable-id rule would fail on every fresh machine.
