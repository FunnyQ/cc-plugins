# Eval rubric — shared scale & dimensions

> Each task's `## Eval rubric` carries its own threshold line + weighted table (that's what `lint-task.ts` / `score-task.ts` parse). This file pins the **scale** and the **generic dimension meanings** so per-task tables only fill in task-specific anchors.

## Scoring scale (0–5, per dimension)

- **0–1 (fail)** — wrong result, doesn't match spec, or absent.
- **2–3 (below bar)** — happy path works but edges drift, or quality is rough.
- **4–5 (pass)** — fully matches the spec, edge cases handled, clean.

## Generic dimensions

- **Correctness** — does it do what the task spec says, including the edge cases the task calls out?
- **Test coverage** — for code tasks: are happy path + failure paths tested? For **skill/doc tasks**, reinterpret as **Instruction clarity** — could a fresh fork/agent execute the SKILL.md correctly without guessing?
- **Interface & readability** — clear names, clear types, composes cleanly, matches surrounding style.
- **Assumptions & docs** — assumptions flagged, no unexplained magic, backward-compat notes where relevant.

## Scoring & pass line

- Weighted average = Σ(score × weight) ÷ Σ(weight), on the 0–5 scale.
- **Default pass**: weighted average **> 4.0**.
- **Hard-fail veto**: `Correctness < 4` is an automatic fail regardless of the average.

The closing **Final review** task scores different axes (Integration / Meets the PLAN goal / Consistency / No regressions) — see its own table.
