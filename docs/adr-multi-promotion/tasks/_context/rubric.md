# Shared eval rubric

> Every task carries its own `## Eval rubric` with a threshold line and a weighted table.
> This file pins the scale and the dimension definitions, so a task table only needs its
> own anchors.

## Scoring scale

Each dimension scores 0–5.

- **0–1 (fail)** — the change is wrong, or it is absent.
- **2–3 (below bar)** — the change is present but incomplete, ambiguous, or contradicted
  somewhere in the same file.
- **4–5 (pass)** — the change is complete, unambiguous, and internally consistent.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

- Pass: weighted average **> 4.0**.
- Hard-fail veto: **Contract fidelity < 4** is an automatic veto, whatever the average.

The threshold is strict, so read the bands accordingly. A score of 4 means the dimension
**meets** the bar. A score of 5 means it clears the bar. A task scoring 4 on every
dimension averages exactly 4.0 and does not pass. A passing task therefore scores 5 on at
least one weighted dimension, and in practice on `Contract fidelity`, which carries ×3.

The veto sits on `Contract fidelity` because this whole change is a contract change. A
task that ships readable prose describing the wrong field names has failed, not scored
low.

## Shared dimensions

| Dimension | Weight | What it looks at |
| --- | --- | --- |
| Contract fidelity | ×3 | Every payload shape, field name, and rule matches `contract.md` exactly. No stale singular field survives in the edited file. |
| Completeness | ×2 | Every item the task's `## Files to create / modify` and `## Acceptance criteria` name is done. No half-converted section. |
| Readability | ×1 | The edited text follows the STE-lite rules in `shared.md`, and reads as one voice with the surrounding file. |
| Assumptions and docs | ×1 | Non-obvious rules carry their reason. Nothing invents a behavior `contract.md` does not define. |

## Anchors that apply everywhere

- **Contract fidelity 0–1** — a field name differs from `contract.md`, or a shape the task
  owns is missing.
- **Contract fidelity 2–3** — the shapes match but a rule is dropped, softened, or stated
  only by implication.
- **Contract fidelity 4–5** — shapes and rules match, and the file names the failure each
  rule prevents.
- **Completeness 2–3** — one section converted to the batch contract while a sibling
  section in the same file still reads in the singular.
- **Readability 2–3** — correct content, but sentences over 25 words, stacked em dashes, or
  a new term for a thing `contract.md` already named.
- **Assumptions and docs 2–3** — a rule stated with no reason, so a later editor cannot
  tell whether it is load-bearing.

## What no task is scored on

- Test coverage. No task in this tree writes a test, because no task changes code.
- Performance. The deliverable is instruction text.
