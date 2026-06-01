# Interview Guide

Topic-specific question banks. Use these as a starting point; adapt to what the user says. Every question must go through `AskUserQuestion` with structured options — never plain text, and every question must include a recommended answer as the first option.

## Interview philosophy

Don't stop interviewing the user until both sides fully understand every part of the plan. Treat the design as a tree of decisions — walk one branch at a time, and when one choice depends on another, resolve the upstream one first. For every question, propose the answer you'd pick and explain why; the user reacts to it.

There is no round cap. Stop when the tree is fully walked, not when a counter expires.

## Stop criteria (apply to every topic)

Stop when **all** of these hold:

- A `topic-slug` is agreed.
- Every requirement has writable acceptance criteria.
- Every task has a quality bar captured as an Eval rubric (dimensions + weights + pass line). See **Eval rubric (ask per task)** below.
- MVP vs later is explicit, with a one-line reason for each "later".
- Bucketing has been decided (`ui/backend/api`, by phase, by feature, or single-bucket `work/`) with a clear reason. Task files always live one level deep under `tasks/<bucket>/` — never flat under `tasks/`.
- Cross-bucket dependencies, if any, are mapped.
- Conventions worth freezing are captured (commit style, code style, naming, etc.).
- Failure modes and rollback paths are acknowledged.
- Edge cases are acknowledged (resolved or explicitly deferred to "Open Questions").
- Reading back the running summary produces no new corrections from the user.

When in doubt, ask one more question. The cost of one extra round is small; the cost of a missing decision discovered mid-execution is large.

## Project (new system or app)

Focus: scope a buildable MVP and the buckets that will get it there.

**Round 1 — problem framing**

- What problem does this solve, and who feels the pain today?
- What's the smallest version that delivers value? (MVP vs later)

**Round 2 — surface area**

- What major surfaces does this touch? (CLI / web UI / mobile / API / data pipeline / etc.)
- Are there existing systems to integrate with, or is this greenfield?

**Round 3 — tech stack**

- Required stack or free choice?
- Deployment target? Hosting constraints?
- Languages / frameworks / DBs already decided?

**Round 4 — bucketing**

- Do the surfaces map to bucket-able layers (ui / backend / api / infra)? Or is it phase-based (foundation → core → polish)? Or feature-based?
- Which bucket can start first, and which depends on which?

**Round 5 — conventions**

- Code style, commit style, branching, testing approach — anything that should be uniform across tasks?

**Round 6+ — gap-filling**

- Specific acceptance criteria for each requirement.
- Verification steps a sub-agent could run.
- Known unknowns to record as gaps.

## Feature (addition to existing system)

Focus: precise behavior definition that fits into the current codebase.

**Round 1 — user story & current state**

- Who needs this, and why? What's broken or missing today?
- What happens currently when a user tries this?

**Round 2 — desired behavior**

- What should happen instead? Walk through the happy path.
- What are the edge cases or failure modes?

**Round 3 — scope boundary**

- What's explicitly NOT in this feature?
- Any related work that's tempting to bundle but should stay separate?

**Round 4 — codebase context**

- Which files / modules / services does this touch?
- Existing patterns or conventions in this area to mirror?

**Round 5 — bucketing**

- Frontend-only, backend-only, or both? Worth splitting into buckets?
- For small features, single-bucket (`tasks/work/`) is often correct — still one bucket directory, not files directly under `tasks/`.

**Round 6+ — acceptance & verification**

- How does the user know it works? Tests? Manual QA steps?
- Any rollout concerns (feature flag, migration, etc.)?

## Migration / refactor

Focus: define done, and avoid scope creep.

**Round 1 — motivation**

- What's the trigger? (Tech debt, performance, compliance, deprecation, new requirement?)
- What hurts today that this fixes?

**Round 2 — current state**

- What's in place now? Pointers to current implementation.
- What's broken about it (besides "it's old")?

**Round 3 — target state**

- What does "done" look like? Specific behaviors / interfaces / files.
- What's preserved vs replaced?

**Round 4 — migration strategy**

- Big-bang or incremental? Can both coexist during transition?
- Backwards compatibility required, or is this a breaking change?

**Round 5 — bucketing**

- Migrations often phase-bucket: "01-prepare", "02-shift-traffic", "03-cleanup".
- Identify the natural cut points.

**Round 6+ — safety & verification**

- How do we verify each step before moving to the next?
- Rollback plan if something goes wrong mid-migration?

## Writing (spec, outline, documentation)

Focus: audience and structure. Replace bucketing with section-bucketing.

**Round 1 — audience & purpose**

- Who reads this? What should they take away?
- What action do you want them to take after reading?

**Round 2 — key message**

- What's the one thing this must communicate, even if everything else is cut?

**Round 3 — structure**

- Chronological? Problem-solution? Reference-style? Tutorial?
- Required sections, or freeform?

**Round 4 — tone & length**

- Formal / casual / technical? Length target?
- Any house style or examples to mirror?

**Round 5 — bucketing**

- For long pieces: bucket by section or by audience. Task files become "draft section X".
- For short pieces: single-bucket (`tasks/draft/`) is fine; tasks are "outline", "draft", "revise".

**Round 6+ — verification**

- How is the writing evaluated? Reviewer? Style guide? Examples to match?

## Eval rubric (ask per task)

A required dimension across **every** topic. Acceptance criteria answers "is it done?"; the rubric answers "is it good enough?" — the graded bar a judge agent or a workflow loops against. Don't skip it: a task with no rubric can't be scored, and `lint-task.ts` will reject it.

For each task (or each bucket, if the bar is uniform), settle:

- **Dimensions** — what quality axes matter here? Default four, adapt freely: **正確性 / correctness**, **測試涵蓋 / test coverage**, **介面與可讀性 / interface & readability**, **假設與文件 / assumptions & docs**.
- **Weights** — which axis dominates? Default `×3 / ×2 / ×1 / ×1`. Correctness usually leads.
- **Pass line** — weighted average threshold. Default `> 4.0` on a 0–5 scale.
- **Hard-fail veto** — any axis that fails the whole task regardless of average? Default `正確性 < 4 一票否決` (a wrong answer can't be redeemed by style).
- **Anchors** — for the axes that matter most, what does a 0–1 vs 2–3 vs 4–5 concretely look like *for this task*? (e.g. "基準容積算不出 5,264" = 0–1.) Concrete anchors are what make the score reproducible.

Recommend these defaults via `AskUserQuestion` (first option, `(Recommended)`), and only dig deeper when the user wants a different bar. Capture the result in each task's `## Eval rubric` per `task-template.md`; if the bar is shared, also write `_context/rubric.md` and have tasks reference it.

## Walking the design tree

Each decision opens child decisions. Walk one branch to completion before returning to the next sibling. Example for a new web app:

```
stack? ─→ Nuxt 3
          ├─ render mode? ─→ SSR
          │                  ├─ deploy target? ─→ Cloudflare
          │                  └─ session storage? ─→ KV
          ├─ state mgmt? ─→ Pinia
          └─ styling? ─→ scoped CSS + design tokens
                         └─ tokens source? ─→ ...
```

If the user defers a branch ("not sure yet, default to X"), record it as an Open Question in PLAN.md and move on. Don't abandon the walk; just mark the unresolved node.

## Recommendation requirement

Every `AskUserQuestion` call must include a recommended answer as the **first** option, suffixed `(Recommended)`. The description of that option explains the rationale ("default to X because Y is the cheaper safe path"). If genuinely undecided between two options, name the safer / more-reversible one as the recommendation and say so in the description.

This is not optional. Asking without a recommendation forces the user to design from scratch; asking with one lets them react, which is much faster and produces better answers.

## Question-design checklist

Before sending an `AskUserQuestion` call, verify:

- [ ] 2–4 mutually exclusive options (multiSelect only when truly non-exclusive).
- [ ] **First option is the recommendation, suffixed `(Recommended)`.**
- [ ] Each option has a `label` (≤ 5 words) and a `description` (the trade-off + rationale).
- [ ] Header chip ≤ 12 chars.
- [ ] No "Other" option — the harness adds that automatically.
- [ ] The question targets the current branch of the design tree, not an unrelated topic.
- [ ] If asking 2 questions in one call, they are tightly coupled (else split into separate turns).
