# `_context/` Files

`tasks/_context/` holds the **shared, decision-level** information that task files reference instead of duplicating. Every task file's `Required reading` header points here.

Think of `_context/` as a surgical extract from PLAN.md — only the parts an executor needs while writing code. PLAN.md remains the source of truth; `_context/` mirrors the slices that matter at execution time.

## Inline, don't link

`_context/` files must **inline** the substance executors need. Do not delegate to repo files with phrases like "see `eslint.config.js` for the rules" or "follow the convention in `app/components/`" — that breaks the self-containment contract, since an executor would have to open those files to know what to do.

Rules:

- **Inline the rule** as plain prose or a bulleted list (e.g. "use 2-space indent; no semicolons; prefer `const`").
- **Cite the source file** as a verification pointer ("authoritative source: `eslint.config.js`") so executors can confirm but don't have to read it.
- If a convention is long enough that inlining feels heavy, that's the signal to extract it into its own `_context/<topic>.md` and reference *that*, not the repo file.

Executors should never need to open a file outside `tasks/` to understand a decision.

## What always exists

### `shared.md` (always)

Every plan gets `_context/shared.md`. It carries the convention layer that all tasks rely on:

```markdown
# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

<2–3 sentences: what is being built, where it lives, who uses it.>

## Tech stack

- **Frontend**: <framework + version>
- **Backend**: <framework + version>
- **Storage**: <DB / cache>
- **Other**: <queues, CDNs, payment, auth, etc.>

## Code style

Inline the rules executors actually need:

- <Style rule 1>
- <Style rule 2>
- Authoritative source (for verification only): `<linter config path>`

## File / directory layout

<Inline the convention: where new components / routes / migrations / tests go. Don't just point at a folder — describe what lives there and how new entries are named.>

## Commit & branching style

- Branch off: <base branch>
- Commit format: <emoji + conventional, or whatever the team uses>
- PR target: <branch>
- Use `/odin-git:simple-commit` (single change) or `/odin-git:atomic-commit` (multiple logical changes).

## Verification baseline

Commands every task can rely on:

- `<build command>`
- `<test command>`
- `<lint command>`
- `<dev-server command>` (run by user, not by sub-agents)

## Decisions frozen during interview

Any decision the user made during flightplan's interview that affects multiple tasks. List as bullets with one-line context.

- **<Decision>** — <one-line context>
- **<Decision>** — <one-line context>
```

## What sometimes exists

Create additional `_context/*.md` files only when the same body of context is referenced by multiple tasks. Below are common patterns; create the ones that match the topic.

### `api-contract.md`

When frontend and backend (or client and server) need a shared interface definition.

Contents:

- Endpoint list with paths and methods
- Request/response schemas (TypeScript types or JSON Schema)
- Auth model (token shape, header names, refresh rules)
- Error envelope
- Fixture / mock state shape if applicable

### `backend-conventions.md`

When several backend tasks need the same scaffolding rules.

Contents:

- Framework-specific structure (Rails engine layout, Nuxt server dir, etc.)
- Resource / controller / serializer patterns
- Auth implementation pointers (e.g., Rodauth tables, Devise modules)
- Authorization patterns (Pundit, CanCan, etc.)
- Testing conventions

### `frontend-conventions.md`

When several UI tasks need the same scaffolding rules.

Contents:

- Component organization (atoms / molecules, feature folders, etc.)
- State management approach
- Routing patterns
- Styling system (CSS variables, design tokens, scoped styles)
- Accessibility baseline

### `data-model.md`

When tasks share a schema or domain model worth pinning.

Contents:

- ER diagram or table-by-table breakdown
- Field definitions and types
- Relationships
- Constraints (uniqueness, nullability, enums)

### `migration-plan.md`

For migration / refactor topics.

Contents:

- Phase definitions
- Cutover criteria for each phase
- Rollback steps
- What runs in parallel vs sequential

### `style-guide.md`

For writing topics.

Contents:

- Voice / tone rules
- Vocabulary preferences
- Forbidden phrases
- Length targets
- Reference examples

### `rubric.md`

When tasks share one quality bar — the common case. Each task's `## Eval rubric` carries its own threshold line + weighted table (that's what `lint-task.ts` / `score-task.ts` parse, per task), but the **scale and the generic dimension definitions** are worth pinning once here so tasks can reference `../_context/rubric.md` instead of re-explaining what a 4–5 means.

Contents:

- **Scoring scale** — what 0–1 / 2–3 / 4–5 mean in general (the bands every task reuses).
- **Generic dimensions** — what `正確性` / `測試涵蓋` / `介面與可讀性` / `假設與文件` look at, so per-task tables only need the task-specific anchors.
- **Scoring & pass line** — the weighted-average formula, the default pass threshold (`> 4.0`), and the hard-fail convention (`正確性 < 4 一票否決`).

Per-task rubrics still carry their own threshold line + weighted table (self-contained for the linter); this file just saves them from redefining the scale. See `task-template.md` → "`Eval rubric`" for the parseable contract.

## What does NOT belong in `_context/`

- **Task-specific details** — that goes in the task file's `Implementation notes`.
- **PLAN.md narrative** — context here is reference material, not justification.
- **History or "why we changed our mind"** — that lives in PLAN.md or commit messages.
- **TODOs** — those live in the task file as `Acceptance criteria` checkboxes.

## Sizing

- `shared.md` aims for ≤ 300 lines. Bigger means it's doing too much; split out a topic file.
- Each topic file aims for ≤ 400 lines. Bigger means the topic deserves multiple files.

## Update rules

When a decision changes mid-execution:

1. Update PLAN.md.
2. Update the relevant `_context/*.md`.
3. Notify executors (the task file itself usually doesn't need editing — it describes *what* to do, not *why*).

If a change *does* require editing task files, that's a signal the original task was leaking decision context. Move the decision to `_context/` and slim the task file.
