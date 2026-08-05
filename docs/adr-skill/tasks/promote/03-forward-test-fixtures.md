# PROMOTE-03: Build the hand-judged forward-test fixtures

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: promote/02
> **Blocks**: promote/04
> **Status**: done

## Goal

A set of fixture repositories and a written checklist that make the judgment half of this skill repeatable by hand, instead of re-invented every time someone wonders whether triage still behaves.

## Files to create / modify

- `packages/chronicle/skills/adr/references/fixtures/README.md` (new) — the manual checklist and how to run each fixture
- `packages/chronicle/skills/adr/references/fixtures/empty-repo/` (new) — no trail at all
- `packages/chronicle/skills/adr/references/fixtures/single-decision/` (new) — one clearly promotable decision
- `packages/chronicle/skills/adr/references/fixtures/spread-decision/` (new) — one decision across four sessions
- `packages/chronicle/skills/adr/references/fixtures/local-detail/` (new) — the false-positive guard
- `packages/chronicle/skills/adr/references/fixtures/already-recorded/` (new) — trail plus a matching ADR
- `packages/chronicle/skills/adr/references/fixtures/watch-wake/` (new) — a watched session plus `variant-matching/` and `variant-quiet/`, staged one at a time
- `.gitignore` (modify) — an exception so the fixture trails can be committed at all

## Implementation notes

### Why fixtures instead of tests

Some of what this skill does cannot be asserted in a unit test. Clustering, threshold judgment, and duplicate detection are quality of *judgment*, not behaviour — a test that pinned them would pin one model's opinion and start failing the moment the model got better.

What *can* be made repeatable is the input: a fixed corpus, plus a written expectation of what a good run looks like. So the deliverable is fixtures plus a checklist. The checklist states what a correct run produces; a human reads the run against it.

**This task is graded on whether the fixtures are complete and runnable, not on whether any particular judgment came out right.** Do not weaken a fixture because a trial run disagreed with the stated expectation — record the disagreement in the checklist and leave the fixture alone.

### The six cases

Each is its own directory holding a `.cockpit/` trail, and where the case needs it, a `docs/adr/` directory.

| Case | What it holds | A correct run produces |
|---|---|---|
| `empty-repo/` | No `.cockpit/` at all | An empty inbox reported cleanly, exit 0. No crash, no created directory. |
| `single-decision/` | One session, one clearly promotable decision | Exactly one candidate, disposition `promote`, and a reason that cites both halves of the threshold. |
| `spread-decision/` | The same decision argued across four sessions, settled only in the last | **One** candidate carrying evidence from all four sessions — not four candidates. |
| `local-detail/` | One session of genuine but local choices | Everything `skip` or `watch`. Nothing promoted. |
| `already-recorded/` | A session whose decision is already captured by an ADR in the fixture's own `docs/adr/` | Disposition `skip`, naming that ADR — not a near-duplicate draft. |
| `watch-wake/` + `variant-matching/` | A session in the watched bucket; stage the matching entry into the inbox | The watched session is pulled back and the combined evidence is re-judged. |
| `watch-wake/` + `variant-quiet/` | Same watched session; reset the inbox, then stage the unrelated entry instead | The watched session stays asleep and does not appear among the candidates. |

`empty-repo/` is the case most likely to crash a collector that assumes a trail exists, so it earns its own directory despite holding almost nothing. `local-detail/` is the false-positive guard: a variable rename, a test helper, and a workaround with a linked upstream fix are all real decisions, and none of them is architecture. `spread-decision/` is the case that proves clustering happens by decision rather than by session.

### The seventh condition: conflicting evidence

Do not give this its own directory. Put two entries inside one existing fixture — `spread-decision/` is the natural home — that reach opposite conclusions about the same question, with the later entry being the *wrong* one. Record in the checklist that the correct behaviour is to surface the conflict for a human, not to silently take the newer entry.

### Fixture construction rules

A careless fixture is worse than none, so:

**Use realistic record shapes.** Log files are JSONL, one record per line, named `<session-id>.jsonl` under `<case>/.cockpit/logs/` (or `<case>/.cockpit/archive/watch/` for the watched session). A real `reason` is a multi-paragraph argument, not one sentence — write them that way, because a skeleton-only pass must visibly avoid loading them and a one-line `reason` makes that invisible. The record shape:

```ts
type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: "decision" | "rationale" | "learning" | "caveat";
  source?: "agent" | "scribe";
  decision: string;
  reason: string;
  tradeoff: string;
  facets: { label: string; text: string }[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  diagram?: string;
  timestamp: string;
};
```

**Backdate every mtime — on the staged copy, never on the committed tree.** The archiver refuses any file whose mtime is within ten minutes of now, so a freshly checked-out fixture is indistinguishable from a live session and the archiving half of the checklist can never be exercised. Git does not preserve mtimes, so this is not something that can be fixed once and committed; it is part of staging, every time. The checklist's setup step:

```sh
CASE=single-decision
SCRATCH=$(mktemp -d)
cp -R "packages/chronicle/skills/adr/references/fixtures/$CASE/." "$SCRATCH/"
git -C "$SCRATCH" init -q
find "$SCRATCH" -name '*.jsonl' -exec touch -t 202601010000 {} +
# run the skill from $SCRATCH
```

The `git init` is not incidental. Trail resolution walks up to the git root and records are written under that root's `docs/adr/`, so a fixture run without its own root would resolve to whatever repository encloses it. Backdating the committed files instead would mutate the source fixtures, leave them dirty for no reason, and still be undone by the next clone.

**Scrub the content.** These fixtures are committed. No real credentials, no personal data, no verbatim transcript from a real session. Write plausible synthetic decisions rather than copying from the live trail.

**Keep each fixture legible.** A handful of entries per session, not hundreds. The volume argument is already made by the real trail; these exist to be read.

### The gitignore exception, and its trap

`.gitignore` currently carries a bare `.cockpit/` directory rule, which would otherwise swallow the entire fixture tree silently. Add an exception below it:

```
!packages/chronicle/skills/adr/references/fixtures/*/.cockpit/
```

**Verify it actually holds before writing any fixture content.** Git cannot re-include a file whose parent directory is excluded, so a negation aimed at the files rather than the directory itself does nothing at all — and it fails quietly, leaving a committed tree that is missing everything that matters.

If the negation does not hold, fall back: name the directory `cockpit-fixture/` inside each case, and have the staging step rename it to `.cockpit/` in the scratch copy. That is unconditionally reliable, and it costs nothing here — the setup step already copies the case to a scratch root, so the rename is one more line in a command that has to run anyway. Given that, prefer the fallback outright unless the negation is verified to work.

### The checklist itself

`README.md` in the fixtures directory. Structure it as:

1. A short statement of what these are and what they are not — repeatable inputs and stated expectations, not automated tests.
2. The setup step: copy the case to a scratch directory, `git init` it, backdate the copied logs — run once per case, every time, and never against the committed tree.
3. A table with four columns — case, what to run, what a correct result looks like, and a checkbox — one row per case plus one for the conflicting-evidence condition.
4. A closing note on what to do when a run disagrees with an expectation: record the disagreement, do not edit the fixture to match.

### Every case runs from an isolated repository root

The fixtures live inside this repository, but they must never be **run** inside it. Trail resolution
walks up to the git root, and records are written under that root's `docs/adr/`. A run started in
`fixtures/single-decision/` therefore resolves to this repository's own `.cockpit/` and writes its
test record into this repository's `docs/adr/` — the fixture would be inert and the real trail would
be the thing under test.

So the checklist's setup step, once, for every case: copy the case directory to a scratch path,
`git init` it, backdate the log mtimes there, and run the skill from that root. The fixture on disk
is a **template**; the scratch copy is what executes. Two things follow, and both belong in the
README: the backdating step runs on the copy rather than on the committed files, which sidesteps
git's failure to preserve mtimes entirely; and a fixture's own `docs/adr/` is only ever indexed
because the copy is its own git root.

## Acceptance criteria

- [x] All six case directories exist. Five carry the `.cockpit/` trail layout described (and a `docs/adr/` directory for the already-recorded case); `empty-repo/` deliberately carries **no** `.cockpit/` at all — that absence is the condition it tests, and shipping a trail there would make the case test nothing.
- [x] The spread-decision case really spans four separate session files, not one file with four entries.
- [x] The already-recorded case ships an ADR inside its own `docs/adr/` directory, following the four-digit numbering.
- [x] The watch-wake case ships the watched session plus the two inbox variants as **separately installable** subfixtures — `variant-matching/` and `variant-quiet/` — with a setup command that stages exactly one into the inbox per run. Both must be executed and verified independently; leaving both in place at once means the matching entry wakes the session while the quiet behaviour is supposedly being observed, so the negative half is never actually tested.
- [x] At least one fixture contains two deliberately conflicting entries, with the later one being the wrong conclusion.
- [x] The checklist carries a runnable setup step that copies the case to a scratch directory, `git init`s it, and backdates the copied log mtimes beyond the ten-minute live-session window — and every case is run from that copy, never in place. Do not assert on the mtimes of the committed files themselves: git does not preserve mtimes, so a fresh clone stamps every fixture with the checkout time and a correct artifact would fail.
- [x] The checklist covers all six cases plus the conflicting-evidence condition, each with a stated expected result and a checkbox.
- [x] The fixture tree is committable — the gitignore exception holds, or the documented fallback is in place.

## Verification

- [x] `ls packages/chronicle/skills/adr/references/fixtures/` lists all six case directories plus `README.md`.
- [x] `find packages/chronicle/skills/adr/references/fixtures -name '*.jsonl' | wc -l` prints at least 9.
- [x] Every fixture log parses: `bun -e 'for (const f of new Bun.Glob("packages/chronicle/skills/adr/references/fixtures/**/*.jsonl").scanSync(".")) { const t = await Bun.file(f).text(); t.split("\n").filter((l) => l.trim()).forEach((l) => JSON.parse(l)); }' && echo "all JSONL valid"`
- [x] `git check-ignore -v packages/chronicle/skills/adr/references/fixtures/single-decision/.cockpit/logs` exits non-zero — the fixture trails are not being ignored. If it exits 0, the negation did not hold; apply the documented fallback.
- [x] Stage one case with the README's setup step — copy to a scratch directory, `git init`, backdate
      — then `find <scratch> -name '*.jsonl' -newermt '-10 minutes' | wc -l` prints 0. Run this
      against the copy, never against the committed tree: the committed mtimes are whatever the last
      checkout stamped, and mutating them in place would both break the no-assert rule and leave the
      source fixtures dirty for no reason.
- [x] Run the triage flow by hand against a staged copy of the spread-decision fixture and confirm the result is one candidate, not four. Record the outcome in the checklist.
- [x] Run the triage flow by hand against a staged copy of the empty-repo fixture and confirm it exits cleanly without creating a `.cockpit/` directory in that copy.
- [x] `git status --short -- packages/chronicle/skills/adr/references/fixtures .gitignore` shows the fixture tree and the ignore rule dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

Grade the **fixtures**, not the judgment they provoke. A run that disagrees with a stated expectation is a finding to record, not a defect in this task.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A case is missing, or the fixture tree is silently swallowed by the ignore rule and nothing was actually committed | Cases exist but do not isolate what they claim — the spread case is one file, or the logs are not backdated so the archiving half cannot be exercised at all | Every case is runnable exactly as written and isolates the one condition it names; the ignore exception is verified, not assumed |
| Test coverage (case coverage) | ×2 | Only the cases that succeed are present | The happy cases are complete but the negative half is thin — no false-positive guard, or the wake condition ships only its matching variant | Both guards present: the local-detail case and the non-matching wake variant, plus the conflicting-evidence pair |
| Interface & readability | ×1 | The checklist is prose with no stated expectations | A table exists but expectations are vague ("looks reasonable") | Each row states a concrete, checkable outcome a reader can judge without opening the fixture |
| Assumptions & docs | ×1 | The backdating requirement is unstated, so a fresh clone silently fails | Setup steps listed without saying why they are needed | The mtime trap, the ignore trap, and the do-not-edit-the-fixture rule are each stated with their reason |

## Out of scope

- Asserting a particular clustering or disposition outcome in an automated test — Deferred. Reason: that would pin one model's judgment rather than the skill's contract, and the design deliberately splits these from the unit-testable half.
- Running the fixtures in CI — Deferred. Reason: they are hand-judged, and a green check would misrepresent what was actually verified.
- Writing a real ADR into this repository's `docs/adr/` — Deferred. Reason: the fixtures' ADRs live inside fixture directories only; the first real ADR comes from a live run.
- Building fixtures at realistic scale (hundreds of entries) — Deferred. Reason: legibility beats volume here, and the real trail already demonstrates the scale problem.
