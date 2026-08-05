# FOUNDATION-04: Read the ADR directory into an index

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: foundation/02
> **Blocks**: triage/02, promote/01
> **Status**: todo

## Goal

A read-only index of the existing ADRs — their lifecycle metadata, the next free number, and any lifecycle link that does not resolve — so the triage and drafting paths can spot duplicates and pick a filename without re-parsing Markdown themselves.

## Files to create / modify

- `packages/chronicle/skills/adr/scripts/adr-index.ts` (new) — the index reader
- `packages/chronicle/skills/adr/scripts/adr-index.test.ts` (new) — its unit tests

## Implementation notes

### The ADR file shape being parsed

Quoted here so you do not have to go looking for it. An ADR opens with an H1 carrying its id, followed by a metadata list, followed by the fixed section headings:

```md
# ADR-0002: ADR status reports implementation state

- Status: Accepted
- Date: 2026-08-06
- Supersedes: ADR-0001
- Superseded by: ADR-0007

## Context
## Considered alternatives
## Decision
## Consequences
## Evidence
```

The H1 and the metadata list carry most of what this task needs. Two body facts come with them,
because `parseAdr` is the **single shared Markdown parser** for records — the structural validator
built later calls this function rather than parsing the file a second time, and it cannot check
"a required section is missing" or "the evidence section is empty" without them:

- `sections` — the H2 headings present, in document order. Names only; the prose under them is not
  read, kept, or interpreted here.
- `evidenceEntries` — how many top-level list items sit under `## Evidence`. A count, not content.

Nothing else about the body is parsed. Deciding what a missing section or an empty evidence list
*means* belongs to the validator; this function only reports what is there.

`Supersedes` and `Superseded by` may each carry more than one id (comma-separated), and either line may be absent. `Status` may be absent or hold an unrecognized word; that is a `null`, not an error.

### Export surface

Write exactly these exports. Use `type`, never `interface`.

```ts
export type AdrStatus = "Proposed" | "Accepted" | "Superseded" | "Deprecated";

export type AdrMeta = {
  id: string;               // "ADR-0002"
  number: number;           // 2
  title: string;            // "ADR status reports implementation state"
  status: AdrStatus | null; // null when the line is missing or unrecognized
  date: string | null;      // "2026-08-06"
  supersedes: string[];     // ["ADR-0001"]
  supersededBy: string[];   // ["ADR-0007"]
  path: string;
  /** H2 headings present, in document order — e.g. ["Context", "Decision", "Evidence"]. */
  sections: string[];
  /** Top-level list items under `## Evidence`. 0 when the section is absent or empty. */
  evidenceEntries: number;
};

export type BrokenLink = {
  from: string;             // "ADR-0002"
  to: string;               // "ADR-0099"
  reason: "missing" | "not-mutual" | "self";
};

export type AdrIndex = {
  dir: string;
  exists: boolean;
  adrs: AdrMeta[];          // ascending by number
  nextNumber: number;
  brokenLinks: BrokenLink[];
  /** Markdown files in the directory that `parseAdr` could not read, with why. Never dropped. */
  skipped: { path: string; reason: "no-h1" | "bad-h1" | "unreadable" }[];
};

export function formatAdrId(n: number): string;                  // 1 → "ADR-0001"
export function adrFilename(n: number, title: string): string;   // (1, "Cockpit trail is an inbox") → "0001-cockpit-trail-is-an-inbox.md"
export function parseAdr(content: string, path: string): AdrMeta | null;
export function buildIndex(dir: string): Promise<AdrIndex>;
```

`parseAdr` is the pure function the tests lean on — string in, structure out, no filesystem access. `buildIndex` is the only function that touches disk: it reads the directory and delegates every file to `parseAdr`. Keeping that split is what makes the parsing cases cheap to test.

`buildIndex` takes the directory path directly. Resolving `<git-root>/docs/adr` is the caller's job, not this module's, so tests can point it at a temporary fixture directory.

### Numbering and filenames

ADRs live at `docs/adr/NNNN-<kebab-title>.md`, four-digit zero-padded. `nextNumber` is the highest number present plus one. An empty or missing directory yields `1`, so the first ADR written is `docs/adr/0001-<title>.md`.

Numbering may have gaps. A directory holding `docs/adr/0001-a.md` and `docs/adr/0004-b.md` yields `nextNumber: 5` — the maximum plus one, never a count and never the first free slot. Reusing a gap would make an id ambiguous across git history.

`adrFilename` slugging, spelled out because it is silently lossy otherwise:

1. Lowercase the title.
2. Replace spaces with hyphens.
3. Drop every character outside `[a-z0-9-]`.
4. Collapse runs of hyphens into one.
5. Trim leading and trailing hyphens.

Worked example: `adrFilename(1, "Cockpit trail is an inbox")` returns `0001-cockpit-trail-is-an-inbox.md`.

### Link checking

Supersession is written in both directions: the successor declares `Supersedes: <old>` and the old one declares `Superseded by: <new>`. Three ways that can be wrong, each named in `BrokenLink.reason`:

- `missing` — the referenced id has no file in the directory.
- `not-mutual` — one side declares the relationship and the other does not. Report it once, `from` being the ADR that made the claim.
- `self` — an ADR names its own id in either link field.

The index **reports** broken links. It does not repair them, does not sort them into severities, and never throws on one. Enforcement belongs to the ADR validator, which is a separate component in this plan.

### Missing and malformed input

- A directory that does not exist returns `{ dir, exists: false, adrs: [], nextNumber: 1, brokenLinks: [], skipped: [] }`. It never creates the directory.
- An existing but empty directory returns the same, with `exists: true`.
- A file whose H1 does not match `# ADR-NNNN: Title` returns `null` from `parseAdr` and is left out of `adrs` by `buildIndex`. A stray `README.md` dropped into `docs/adr/` must neither crash the index nor occupy a number.

  **But it lands in `skipped`, not in a void.** "Skipped" here means "not a record", never "not seen". The validator discovers records through this index, so a file dropped silently would be a file no rule could ever fire on — a malformed record and a bad filename would both pass validation by being unreadable, which is precisely backwards. Every `.md` in the directory ends up in exactly one of `adrs` or `skipped`, and the caller decides what a skip means: harmless for a README, a violation for something that was meant to be a record.
- Nothing in this module writes, creates, renames, or deletes anything.

## Acceptance criteria

- [ ] `packages/chronicle/skills/adr/scripts/adr-index.ts` and `packages/chronicle/skills/adr/scripts/adr-index.test.ts` both exist and export the surface listed above.
- [ ] `formatAdrId` zero-pads to four digits: `1` → `ADR-0001`, `42` → `ADR-0042`.
- [ ] `adrFilename(1, "Cockpit trail is an inbox")` returns exactly `0001-cockpit-trail-is-an-inbox.md`.
- [ ] `parseAdr` returns `null` for a file whose H1 is not `# ADR-NNNN: Title`, without throwing, and `buildIndex` records that file in `skipped` with a reason — every `.md` in the directory appears in exactly one of `adrs` or `skipped`.
- [ ] `buildIndex` returns `adrs` sorted ascending by number, with `nextNumber` equal to the highest number plus one even when numbering has gaps.
- [ ] `buildIndex` on a directory that does not exist returns `exists: false`, an empty `adrs` array, `nextNumber: 1`, and no broken links.
- [ ] All three `BrokenLink.reason` values — `missing`, `not-mutual`, `self` — are produced by the detector against fixtures that trigger each.
- [ ] `parseAdr` fills `sections` with the H2 headings in document order and `evidenceEntries` with the count of top-level list items under `## Evidence`, returning `0` when that section is absent or holds no list.
- [ ] No exported function creates a directory, writes a file, or modifies one.

## Verification

- [ ] `bun test packages/chronicle/skills/adr/scripts/adr-index.test.ts` passes with zero failures, covering: a missing directory, an empty directory, a stray non-ADR file that lands in `skipped` with a reason rather than vanishing, a numbering gap (`0001` and `0004` present, expect `5`), a one-directional supersession link, a link to an absent id, and a self-reference.
- [ ] Run `bun packages/chronicle/skills/adr/scripts/adr-index.ts` against a temporary fixture directory and confirm the printed `nextNumber` equals the highest number in that fixture plus one.
- [ ] Confirm the run created nothing in this repository: `test ! -d docs/adr && echo "not created"` prints `not created`.
- [ ] Run `git status --short -- packages/chronicle/skills/adr/scripts/adr-index.ts packages/chronicle/skills/adr/scripts/adr-index.test.ts` and confirm both paths are dirty.
- [ ] Do **not** run `bunx tsc --noEmit`. `@types/bun` is not installed in this repo, so it floods with pre-existing `Cannot find name 'Bun'` errors unrelated to this change.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong id format, wrong slug, or `nextNumber` computed as a count instead of max plus one | Parses a well-formed directory but throws on a stray file or a missing directory, or misses a broken-link case | Every listed case handled: gaps, stray files, missing directory, all three link reasons; nothing written to disk |
| Test coverage | ×2 | No tests, or tests that only assert the return shape | Happy-path directory only; broken links or the gap case untested | All three broken-link reasons plus the numbering-gap, missing-directory, and stray-file cases each have a test |
| Interface & readability | ×1 | `parseAdr` reads the filesystem, or the exports differ from the surface above | Exports match but types are loose (`string` where the status union belongs) | `parseAdr` is pure, `buildIndex` holds the only I/O, `type` declarations match the surface exactly |
| Assumptions & docs | ×1 | Slug rules or the four-digit width appear as unexplained magic | Rules implemented but the reason for max-plus-one is not recorded | A comment explains why gaps are never reused and why a stray file is skipped rather than fatal |

## Out of scope

- Enforcing the lifecycle rules — Deferred. This index reports broken links; the ADR validator decides what actually fails.
- Writing, renaming, or renumbering an ADR — Deferred. This module only reads; the writing agent owns every change under the ADR directory.
- Reading the cockpit decision trail — Deferred. A separate collector owns the trail; this module only reads the ADR directory.
- Reading the prose *inside* the body sections — Deferred. `sections` and `evidenceEntries` report structure so the validator does not parse the file twice; nothing downstream needs the text itself to pick a number or spot a duplicate.
- Deciding whether a missing section or an empty evidence list is a defect — Deferred. This module reports structure; the ADR validator owns the judgment and the severity.
