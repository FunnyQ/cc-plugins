# Waypoints Interview Guide

Interview at milestone depth. The output is `WAYPOINTS.md`, not a task tree.

## What to elicit

1. Project outcome: what the finished project enables, who uses it, and why it matters.
2. Vertical milestone legs: each leg should ship an observable slice of value, not a technical layer by itself.
3. Done-state for each leg: one clear acceptance summary after the ` — ` separator.
4. Dependency order: what must be true before the next leg can be planned or built.
5. Leg size: each leg should be one `flightplan` worth of work, not a whole project inside the project.

## Scope ladder

- `preflight`: one small goal or early clarification.
- `flightplan`: one feature or one coherent build slice that needs tasks now.
- `waypoints`: a whole project that should be planned as several milestone legs.

If the interview starts turning into task files, stop and move back up. `waypoints` names the legs; `flightplan` later decomposes the active leg.

## How to identify vertical slices

Prefer legs that leave the product in a usable or inspectable state:

- Good: "users can sign up / sign in with email"
- Good: "a logged-in user can create and edit one project"
- Weak: "database schema exists"
- Weak: "backend APIs are done"

Technical foundations can be legs only when their done-state is externally verifiable enough to guide a flightplan, such as "the app boots with authenticated sessions and deployment plumbing in place."

## How to order legs

Ask for dependencies in product terms:

- What must exist before a user can get value?
- Which leg creates the data or workflow the next leg needs?
- Which uncertain integration should land early enough to de-risk later work?
- Which polish or admin surfaces can wait until the core loop exists?

When two legs are independent, put the one that de-risks the project or unlocks feedback first.

## How to size a leg

A leg is the right size when:

- It has one crisp done-state.
- It can become one `docs/<proj>/legs/NN-slug/PLAN.md` with one `tasks/` tree.
- Its tasks would probably fit in a focused autopilot run.
- The next leg can be planned with better information after this one lands.

Split a leg when it has multiple unrelated user outcomes. Merge legs when one cannot be verified without the other.

## Walking the tree examples

### SaaS project

Start with the product spine:

1. "What is the first user-visible loop worth shipping?"
2. "Before billing, what must an account be able to do?"
3. "After the core loop works, what operational surface is needed to run it?"

Possible roadmap:

```markdown
- [~] 1. Auth foundation — users can sign up / sign in with email
      → legs/01-auth/
- [ ] 2. Workspace core loop — a logged-in user can create and update one workspace
      → legs/02-workspace/
- [ ] 3. Billing — paid plans can be purchased and reflected in workspace limits
      → legs/03-billing/
- [ ] 4. Admin operations — staff can inspect accounts, plans, and recent activity
      → legs/04-admin/
```

Notice the interview did not ask for auth tables, endpoint names, or UI components. Those belong to the active leg's flightplan.

### Data import tool

Walk by risk and observable value:

1. "What is the smallest import that proves the parser and storage model?"
2. "What validation or preview must exist before users trust it?"
3. "What automation turns it from a manual tool into the intended workflow?"

Possible roadmap:

```markdown
- [~] 1. Manual import path — an operator can upload one CSV and see parsed records
      → legs/01-manual-import/
- [ ] 2. Validation preview — invalid rows are explained before anything is committed
      → legs/02-validation/
- [ ] 3. Scheduled ingestion — imports can run on a schedule with an audit trail
      → legs/03-scheduled-ingestion/
- [ ] 4. Recovery tools — failed imports can be retried or rolled back safely
      → legs/04-recovery/
```

The first leg lands the riskiest parsing path early. Later legs are delayed until the real shape of import failures is known.

## Interview prompts

Use 1-2 questions per turn. Recommend an answer when the shape is apparent.

- "What is the first milestone that would make this project real enough to inspect?"
- "What would be true at the end of that leg, in one sentence?"
- "What does that leg unlock next?"
- "Which future milestone depends on unknowns from this one?"
- "Is this leg one flightplan worth of work, or does it contain two separate outcomes?"
- "Which leg can stay pending until we know what actually shipped?"

## Stop criteria

Stop interviewing when:

- The project has a stable slug for `docs/<proj>/`.
- Each leg has a number, title, mandatory `legs/NN-slug/` pointer, and done-state.
- Exactly one first leg is marked `[~]`; all later legs are `[ ]`.
- The order is defensible by dependency or risk.
- No leg is secretly a task breakdown.

Then write `docs/<proj>/WAYPOINTS.md` directly. Do not scaffold leg tasks until `flightplan` is invoked for the active leg.
