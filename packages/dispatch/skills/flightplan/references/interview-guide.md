# Interview Guide

Topic-specific checklists. They list what to cover, not a script: the design tree's dependencies set the order. Adapt them to what the user says.

## Stop criteria (apply to every topic)

Stop when **all** of these hold:

- A `topic-slug` is agreed.
- Every requirement has writable acceptance criteria.
- Every task has a quality bar captured as an Eval rubric (dimensions + weights + pass line). See **Eval rubric (ask per task)** below.
- The plan ends with one **final review task** (marked `Final review: true`) that depends on all leaf tasks. This is the holistic closing gate. Confirm what it reviews: integration, meets-goal, consistency, regressions. Single-task plans are exempt.
- MVP vs later is explicit, with a one-line reason for each "later".
- Bucketing has been decided (`ui/backend/api`, by phase, by feature, or single-bucket `work/`) with a clear reason. Task files always live one level deep under `tasks/<bucket>/`. They never live flat under `tasks/`.
- Cross-bucket dependencies, if any, are mapped.
- Conventions worth freezing are captured (commit style, code style, naming, etc.).
- Failure modes and rollback paths are acknowledged.
- Edge cases are acknowledged (resolved or explicitly deferred to "Open Questions").
- Reading back the running summary produces no new corrections from the user.

A missing decision discovered mid-execution costs far more than one more round, so keep asking while any item above is unmet, and stop once they all hold.

## Per-topic coverage

- **Project (new system or app)** — scope a buildable MVP and the buckets that get there: the problem and who feels it, the smallest valuable version, the surfaces touched (CLI / web / mobile / API / pipeline), greenfield or integrating, stack and deployment constraints, then bucketing by layer, phase, or feature and which bucket starts first.
- **Feature (addition to an existing system)** — precise behavior that fits the current codebase: what happens today, the desired happy path and its edge cases, what is explicitly not in the feature, which files and patterns it touches, rollout concerns (flag, migration). Small features are usually one `tasks/work/` bucket.
- **Migration / refactor** — define done and prevent scope creep: the trigger, what is preserved vs replaced, big-bang or incremental, backwards compatibility, how each step is verified before the next, and the rollback plan mid-migration. Migrations usually bucket by phase (prepare → shift → cleanup).
- **Writing (spec, outline, documentation)** — audience, the one message that must survive every cut, structure, tone, length, house style, and how the writing is evaluated. Bucket long pieces by section or audience (tasks become "draft section X"); a short piece is one `tasks/draft/` bucket with outline / draft / revise tasks.

## Per-task models (ask during decomposition)

Recommend omitting the Models header by default. Ask only when a task has dense hidden edge cases — a sanitizer, a parser, concurrency, numerical code, storage or a migration, a brownfield bug fix, a behaviour-preserving refactor. The rules and syntax live in `task-template.md` under `### Models`.

For such a task, ask via `AskUserQuestion`: "This task has many hidden edge cases. Should dev run at high effort?"

- **dev=opus/high (Recommended)** — Dev spends effort testing its own work and hunting edge cases.
- **Use the defaults** — Omit the Models header; dev runs at low and only the last attempt runs at high.

When a task has two plausible readings, do not offer higher effort. Ask which reading is meant, and write the answer into the task file.

## Eval rubric (ask per task)

Acceptance criteria answers "is it done?". The rubric answers "is it good enough?" — the graded bar a judge agent or a workflow loops against. `lint-task.ts` rejects a task without one.

For each task (or each bucket, if the bar is uniform), settle:

- **Dimensions** — what quality axes matter here? Default four, adapt freely: **Correctness**, **Test coverage**, **Interface & readability**, **Assumptions & docs**.
- **Weights** — which axis dominates? Default `×3 / ×2 / ×1 / ×1`. Correctness usually leads.
- **Pass line** — weighted average threshold. Default `> 4.0` on a 0–5 scale.
- **Hard-fail veto** — any axis that fails the whole task regardless of average? Default `Correctness < 4 is an automatic veto` (a wrong answer can't be redeemed by style).
- **Anchors** — pick the axes that matter most. What does a 0–1 vs 2–3 vs 4–5 look like *for this task*? (e.g. "the computed total doesn't match the spec's 5,264" = 0–1.) Concrete anchors are what make the score reproducible.

Recommend these defaults, and dig deeper only when the user wants a different bar.

Capture the result in each task's `## Eval rubric` per `task-template.md`. If the bar is shared, also write `_context/rubric.md`. Have tasks reference it.

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

If the user defers a branch ("not sure yet, default to X"), record it as an Open Question in PLAN.md, mark the node unresolved, and keep walking.

## Question-design checklist

Before sending an `AskUserQuestion` call, verify:

- [ ] 2–4 mutually exclusive options (multiSelect only when truly non-exclusive).
- [ ] **First option is the recommendation, suffixed `(Recommended)`**, its description giving the rationale. When genuinely torn between two, recommend the safer or more reversible one and say so.
- [ ] Each option has a `label` (≤ 5 words) and a `description` (the trade-off + rationale).
- [ ] Header chip ≤ 12 chars.
- [ ] No "Other" option — the harness adds that automatically.
- [ ] The question targets the current branch of the design tree, not an unrelated topic.
- [ ] If asking 2 questions in one call, they are tightly coupled (else split into separate turns).
