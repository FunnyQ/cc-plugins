# ORCHESTRATOR-04: an opt-in vendor-switch last rung

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: orchestrator/03
> **Status**: done

## Goal

A Claude dev ladder can be configured to end on a genuinely different vendor, appended after its Opus rung
rather than replacing it.

**Opt-in and off by default.** With the new field empty the ladder stays sonnet → sonnet → opus,
byte-identical to today. Off by default because the extra rung costs one more attempt on every failing task,
which is the operator's call rather than a silent new default. Do not write a criterion that requires the
rung to fire in a default run — it must be inert there.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the fenced
  ```` ```javascript ```` block: a new config field, its resolution, and the dispatch plus cap logic for an
  appended external rung.
- The same file, **outside** the fenced block (modify) — the prose this change makes stale. The
  external-engine gotcha states that the last attempt before the cap escalates to Claude-Opus, which stops
  being the whole story once a Claude ladder can end on an external engine. The new config field also needs
  its behaviour and its off-by-default value described where the other config fields are. Prose that
  contradicts the script is worse than no prose: the next author trusts it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — allow a config field
  to be overridden, and cover the appended rung plus both inert cases.

## Implementation notes

**Every edit to the executable script must land INSIDE the fenced ```` ```javascript ```` block.** The prose
corrections listed above are the deliberate and only exception — they belong outside the block by
definition. The fixture locates the script by string search — `doc.indexOf("```javascript")` to the next
`"\n```"` — and runs the slice through `new Function`, so script logic written in the surrounding prose is
invisible to both the runtime and the test.

### The defect

An external dev engine already ends on a different vendor:

```js
const lastShot = attempt >= cap && cap > 1
if (devEngine && !lastShot) { /* external driver */ } else { /* claude */ }
```

A Claude ladder does not. `devModel = attempt >= cap ? MODEL.devEscalated : MODEL.dev` escalates only
sonnet → opus, so a task that fails for a Claude-shaped reason never gets a genuinely different attempt.

### The config field

Add beside the existing engine fields:

```js
  lastShotEngine:        '',   // 'codex' | 'opencode' | '' (off) — appends ONE external rung to the END of a Claude dev ladder
```

Resolve it once, next to where `devEngine` is resolved:

```js
// Appended, never substituted: replacing the Opus rung would lose every task that
// only Opus clears. Null whenever devEngine is already external — that ladder
// already ends on Claude-Opus, so it is already a vendor switch.
const lastShotEngine = (!devEngine && CFG.lastShotEngine)
  ? withModel(CFG.lastShotEngine, CFG.opencodeDevModel)
  : null
```

Reuse `withModel` rather than reading `ENGINES` directly. It throws on an unknown key, so a typo in the new
field fails loudly at script start instead of spreading `undefined` and dying much later inside a dev driver
prompt.

### The cap, and the trap that turns "append" into "replace"

```js
const cap = finalReview ? FINAL_MAX : MAX + (lastShotEngine ? 1 : 0)
```

and in the dev branch:

```js
// The appended rung is the final attempt, and only exists on a Claude ladder.
const vendorRung = !!lastShotEngine && attempt === cap
// The last CLAUDE rung. With an appended rung cap is MAX + 1, so the escalation
// tier must key off the Claude cap. Keying off `cap` makes `attempt >= cap` false
// at attempt MAX, so the ladder would run sonnet, sonnet, sonnet, external and
// Opus would never execute — silently turning this append into a replace.
const claudeCap = cap - (lastShotEngine ? 1 : 0)
```

**This is the whole correctness risk in the task.** The existing escalation test reads `attempt >= cap`.
Raising `cap` without introducing `claudeCap` produces a ladder that looks right from the outside — it still
ends on the external engine — while quietly deleting the Opus attempt that the "append, don't replace"
decision exists to preserve. A test must pin the Opus rung explicitly, not just the final label.

Dispatch order: `vendorRung` first (external driver on `MODEL.devExternal`, label
`dev-${lastShotEngine.label}:${ref}#${attempt}`), then the existing `devEngine && !lastShot` external
branch, then the Claude branch with `devModel = attempt >= claudeCap ? MODEL.devEscalated : MODEL.dev`.

Consequences to keep true:

- With `MAX: 3` and the field off, the ladder is unchanged: sonnet, sonnet, opus.
- With `MAX: 3` and the field set to `codex`, it becomes sonnet, sonnet, opus, codex.
- With `devEngine` set to an external engine, `cap` and every dev label are byte-identical to today.
- With `MAX: 1` and the field set, the cap becomes 2: one Claude attempt then the external rung. The
  existing `cap > 1` guard on `lastShot` belongs to the `devEngine` branch and must not be confused with
  this one.
- A parked quality failure returns `attempt: cap`, so it may now report `MAX + 1`. That is correct — the
  compute was consumed, and reporting less would misrepresent the run.
- The closing review round is untouched: it keeps `FINAL_MAX` and its own multi-lens fan-out, which is
  already cross-vendor.

### Fixture capability this task must add

**Config override.** Config is baked into the block as literals, so no test can vary a field. Give
`loadScript()` an optional map of field name to replacement literal, applied by targeted line replacement —
the same technique it already uses to rewrite `export const meta` into `const meta`. Thread it through
`runOrchestrator`.

It **must throw when a named field is not found in the block.** A silently no-op override would make the
vendor-rung test pass while never enabling the rung — the test would be asserting current behaviour and
reporting it as the new feature working.

### Out of scope for this task

- The attempt-history record and its rendering. That landed in the preceding change in this bucket; reuse it
  as-is and do not alter its shape.
- Prompt capture in the fixture. Also already present from that change.
- Any change to the wave loop, the scout, the commit step, or the guard order.
- Any change to the schemas, to `score-task.ts`, or to the scoring arithmetic.
- Reading the Workflow `budget` global.
- Changing the closing review round's cap, its lenses, or its fixer model.
- Making the rung on by default, or deriving it from `reviewEngine`. It is an explicit operator choice.

## Acceptance criteria

- [x] A new config field defaults to `''`, and with it unset every dev label, model choice, and cap is
      identical to current behaviour.
- [x] With the field set and a Claude dev engine, the effective cap is `MAX + 1` and the final attempt runs
      the external dev driver under a `dev-<engine>:<ref>#<attempt>` label.
- [x] Opus still runs as the last **Claude** rung when the field is set — the appended rung does not replace
      it. At `MAX: 3` the ladder is sonnet, sonnet, opus, then the external engine.
- [x] The escalation tier keys off a separate Claude cap, not off the raised cap.
- [x] With `devEngine` set to an external engine, the new field is inert: the cap and every dev label match
      current behaviour exactly.
- [x] With `MAX: 1` and the field set, the cap is 2 — one Claude attempt, then the external rung.
- [x] An unrecognised value in the new field surfaces as the existing `withModel` throw, not as a later
      failure inside a dev prompt.
- [x] A parked quality failure reports the attempt that actually ran, which may be `MAX + 1`.
- [x] The closing review round's cap and dispatch are unchanged.
- [x] The fixture can override a named config field, and throws when the named field is absent from the
      script block.
- [x] Every change to the executable script sits inside the fenced ```` ```javascript ```` block; the only
      edits outside it are the prose corrections listed above.
- [x] The external-engine gotcha in `orchestrator.md` accounts for a Claude ladder that can now end on an
      external engine, and the new config field's behaviour and default are documented alongside the other
      config fields.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` green — no regression in the sibling
      dashboard suites.
- [x] A fixture case with the new field overridden to `codex` asserts a final `dev-codex:`-prefixed label at
      attempt `MAX + 1`, **and** that the attempt before it ran the Claude dev agent on the escalated model.
      Assert the Opus rung explicitly — asserting only the final label passes even when Opus was skipped.
- [x] A fixture case with the field left at its default asserts the dev labels and their count are identical
      to the current ladder.
- [x] A fixture case with an external `devEngine` and the field set asserts the dev labels and cap are
      unchanged from the external-engine ladder.
- [x] A fixture case asserts the config override throws when handed a field name that does not exist in the
      block.
- [x] `bun -e "const d=await Bun.file('packages/dispatch/skills/autopilot/references/orchestrator.md').text(); const s=d.indexOf('\`\`\`javascript'); const b=d.indexOf('\n',s)+1; const e=d.indexOf('\n\`\`\`',b); new Function(d.slice(b,e).replace(/^export const meta/m,'const meta'))"`
      exits 0 — the block still parses as a function body.
- [x] `grep -c "lastShotEngine" packages/dispatch/skills/autopilot/references/orchestrator.md` is ≥ 3 (the
      config field, its resolution, and the dispatch branch), confirming the change landed in the script
      rather than only in prose.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The appended rung silently replaces Opus, or a default-config run changes any label or cap. | The rung works at `MAX: 3` but a boundary is wrong (`MAX: 1`, an external `devEngine`, or the reported attempt number). | Every stated boundary holds, and the Claude-cap keying provably preserves the Opus rung. |
| Test coverage | ×2 | No test, or tests that would pass without the change. | The final label asserted without pinning the Opus rung — the exact case that hides an append-turned-replace. | Appended rung with Opus pinned, inert-by-default, external-engine inertness, `MAX: 1`, and the override's throw are all covered, and each would fail without the change. |
| Interface & readability | ×1 | `ENGINES` read directly instead of `withModel`. | Works but the two caps are hard to tell apart at a glance. | `withModel` reused, and `cap` vs the Claude cap named so the distinction is obvious to the next reader. |
| Assumptions & docs | ×1 | The append-not-replace choice and the Claude-cap trap are left silent. | Noted somewhere. | Both are *why* comments next to the code, and the new config field carries a one-line comment matching the style of its neighbours. |
