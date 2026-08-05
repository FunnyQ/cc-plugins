# ADR forward-test fixtures

These fixtures make ADR triage judgments repeatable without pretending that the judgments are automated tests. Run each case independently and check its stated outcome by hand.

## Setup

```sh
# Example setup for a single case
CASE=single-decision
SCRATCH=$(mktemp -d)
cp -R "packages/chronicle/skills/adr/references/fixtures/$CASE/." "$SCRATCH/"
git -C "$SCRATCH" init -q
find "$SCRATCH" -name '*.jsonl' -exec touch -t 202601010000 {} +
# Now run the triage skill from $SCRATCH
```

For `watch-wake`, copy the base fixture first, then copy exactly one variant into the same scratch directory. Never install both variants in one run.

| Case name | What to run | Expected result | Verified |
| --- | --- | --- | --- |
| `empty-repo` | Run `triage-flow.ts` from the scratch copy. | Report an empty inbox, exit 0, and do not create `.cockpit/`. | [ ] |
| `single-decision` | Run `triage-flow.ts` from the scratch copy. | Return exactly one candidate with disposition `promote`; the reason cites both coordinated scope and the cost of reversal. | [ ] |
| `spread-decision` | Run `triage-flow.ts` from the scratch copy. | Return one clustered candidate with evidence from all four sessions, not four candidates. | [ ] |
| `local-detail` | Run `triage-flow.ts` from the scratch copy. | Mark every entry `skip` or `watch`; promote nothing. | [ ] |
| `already-recorded` | Run `triage-flow.ts` from the scratch copy. | Mark the decision `skip` and name `docs/adr/0001-centralize-authorization-policy.md`; do not draft a duplicate. | [ ] |
| `watch-wake` matching variant | Copy the base and `variant-matching`, then run `triage-flow.ts`. | Pull `session-watched` back into consideration and re-judge it with `session-trigger`. | [ ] |
| `watch-wake` quiet variant | Copy the base and `variant-quiet`, then run `triage-flow.ts`. | Leave `session-watched` asleep and omit it from candidates. | [ ] |
| Conflicting evidence | Inspect the `spread-decision` result. | Surface the rejected opposite conclusion in `session-004` for human judgment; do not silently prefer the newer entry. | [ ] |

## Why the setup matters

Backdate every JSONL file because archiving refuses logs whose modification time is within ten minutes of now. Git does not preserve modification times, so a fresh clone otherwise looks like a live session.

Initialize Git inside the scratch directory because trail resolution walks to the Git root and writes results there. Without the local root, a run can resolve to this repository's trail and pollute the real one.

The gitignore negation must cover all `.cockpit/` directories under fixtures, including nested variants like `fixtures/watch-wake/variant-matching/.cockpit/`. A negation that fails silently loses all fixture trails on commit, making it impossible to run tests from a clone.

When running a case, if the outcome disagrees with the stated expectation, record the disagreement in the checklist. Do not edit the fixture to match the run — these fixtures are templates, and editing them would corrupt the test cases themselves and prevent future runs from detecting the same issues.

The `spread-decision` fixture deliberately includes a later caveat that states the wrong conclusion. Correct behavior surfaces that conflict for human judgment instead of silently accepting the latest text.
