# INTENT.md Template

INTENT.md is what you wanted, written down before you decided how to build it. It is captured in one short session and then frozen: `flightplan` reads it later as the baseline the eventual PLAN.md must still be traceable to.

It is deliberately **not** a spec. Everything about *how* belongs in PLAN.md, written after the full interview.

## Template

```markdown
# <Topic Title>

> **Status**: captured | specced | dropped
> **Captured**: YYYY-MM-DD

## Problem

<What is wrong or missing today, in the terms you would use out loud. Two to
five sentences. Describe the situation, not a feature.>

## Outcome

<What is true once this exists that is not true now. Observable, not
implemented — "I can see X without opening Y", not "adds an X endpoint".>

## Who and what it touches

- **Users**: <who feels the problem>
- **Systems**: <existing surfaces, repos, or tools this lands near>

## Constraints

Only facts you do not get to choose. A choice you *made* is a decision, and
decisions belong to PLAN.md.

- <Hard fact — a deadline, a platform, a system that must keep working>
- <Hard fact>

## Non-goals

<The boundary as it looks now. Cheap to write here, expensive to recover later.>

- <Thing this is explicitly not>

## Open questions

Everything you have not actually decided. This section is the point of the
file — resist letting it come out empty.

1. **<Question>** — <why it is open, what would settle it>
2. **<Question>** — <why it is open, what would settle it>
```

## Capture rules

1. **Refuse to answer *how*.** No architecture, no stack, no file layout, no task breakdown, no API shape. Every one of those that surfaces goes into Open questions as a question, not into the body as an answer.
2. **An empty Open questions section is a failure, not a clean capture.** A vague idea rendered as confident structure reads as settled when nothing was settled. If nothing is open, the idea was already specced and belongs in a full `flightplan` run.
3. **Keep the originator's words.** Do not upgrade "the dashboard is slow to read" into "reduce time-to-first-insight". The point of capturing early is a record of what was actually meant.
4. **Stop at one page.** Capture is minutes, not an interview. Depth is `flightplan`'s job, and paying for it twice is how the second pass gets skipped.
5. **Constraints are facts, not preferences.** "Must run offline" is a constraint. "Should use SQLite" is a decision that has not been made yet — that is an Open question.

## After capture

INTENT.md sits at `docs/<slug>/INTENT.md` with nothing else in that directory, which is exactly what `scaffold.ts --check` reports as `INTENT: <path>`. The eventual `flightplan <slug>` run scaffolds around it and leaves it untouched.

Update it only when the underlying want changes. A PLAN.md that drifts from INTENT.md is a finding to surface, not a reason to rewrite the intent.
