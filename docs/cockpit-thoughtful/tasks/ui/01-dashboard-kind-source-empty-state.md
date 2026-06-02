# UI-01: Dashboard kind, source, and empty-state

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/log-schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/01
> **Blocks**: release/01
> **Status**: todo

## Goal

Render the new `kind` (decision/rationale/learning/caveat) and `source` (agent/scribe) fields in the cockpit dashboard's decision cards, and update the off-the-cockpit empty-state copy to advertise `/thoughtful`.

## Files to create / modify

- `packages/monitor/skills/cockpit/dashboard/dist/modules/decision-log.js` (modify) — `decisionCard()` kind class + scribe source badge; empty-state CTA copy.
- `packages/monitor/skills/cockpit/dashboard/dist/style.css` (modify) — `.decision-card.is-kind-*` accents + kind label + `.decision-card__source-badge`.

> Frontend is committed as-is — **no build step**. Edits ship directly.

## Implementation notes

### `decisionCard(rec)` (decision-log.js ~359)

Reader defaults: treat absent fields as `rec.kind || "decision"` and `rec.source || "agent"` so old logs render exactly as today.

- After `card.className = "decision-card";`, add the kind class — but **whitelist first** (a malformed `kind` with a space would make `classList.add` throw `InvalidCharacterError` and break the whole card):
  ```js
  const KINDS = ["decision", "rationale", "learning", "caveat"];
  const kind = KINDS.includes(rec.kind) ? rec.kind : "decision";
  card.classList.add("is-kind-" + kind);
  ```
- Render a source badge **only when `rec.source === "scribe"` exactly** (any other / absent value → no badge; agent/default entries stay visually unchanged — zero churn). Add it next to the existing `needs_your_call` badge slot in the `card.innerHTML` template:
  ```js
  ${rec.source === "scribe" ? '<div class="decision-card__source-badge is-scribe">✍ scribe</div>' : ""}
  ```
- `decision` (→ `--title`) and `reason` (→ `--text`) already render via the existing head/reason template — no change needed for the body of scribe entries. A scribe entry with an empty `decision` will show an empty headline; that's acceptable, but the kind label (below) gives it a visible header.

### Kind label

Give non-decision kinds a small uppercase label so the lens reads at a glance. **Before adding one, grep `style.css` for any existing `.decision-card__decision::before` (or similar) that already injects a label on every card** — if one exists, extend *that* rule per kind (don't add a second inline label, or cards get a double header). Pick ONE mechanism (preferably the existing `::before` if present, gated by the `is-kind-*` class) and wire it consistently in both files. Keep `decision` kind at its current appearance (default/baseline) so legacy cards don't change.

### `style.css` (Night Flight tokens — reuse, don't invent colors)

Available tokens (from `:root`): `--aurora` (cool accent), `--positive` (green), `--danger` (caution), `--signal` (warm reserve, used by open calls), `--edge` (border), `--ink-muted` (dim text), `--font-mono`. Add a left-border accent per kind plus the badge:

```css
.decision-card.is-kind-rationale { border-left: 3px solid var(--aurora); }
.decision-card.is-kind-learning  { border-left: 3px solid var(--positive); }
.decision-card.is-kind-caveat    { border-left: 3px solid var(--danger); }
/* is-kind-decision: no extra accent — preserves current look */

.decision-card__source-badge {
  display: inline-block;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  border: 1px solid var(--edge);
  border-radius: 999px;
}
```

Match the existing `.decision-card__badge` spacing conventions so the two badges sit nicely when both render (a scribe entry never has `needs_your_call`, so in practice only one shows).

### Empty-state copy (decision-log.js ~318–332)

In `renderEmptyState()`'s `isUntracked()` branch, update only the CTA line (keep badge + title + body). Change:

```js
// from:
<span class="decision-log__invite-cta">Run <code>/cockpit</code> to set a goal. From there, every decision worth remembering lands here.</span>
// to (wording can be refined, must mention both):
<span class="decision-log__invite-cta">Run <code>/cockpit</code> to set a goal, or <code>/thoughtful</code> to auto-log as you work. Either way, decisions worth remembering land here.</span>
```

## Acceptance criteria

- [ ] `decisionCard()` adds `is-kind-<kind>` (defaulting to `decision`) for every card.
- [ ] A scribe entry renders a `✍ scribe` source badge; an agent/default entry renders no source badge (unchanged look).
- [ ] `style.css` has `is-kind-rationale/learning/caveat` accents using existing tokens and a `.decision-card__source-badge` rule; `is-kind-decision` keeps the current appearance.
- [ ] Non-decision kinds show a visible lens label; decision kind does not.
- [ ] Empty-state CTA mentions both `/cockpit` and `/thoughtful`; badge/title/body unchanged.
- [ ] Old records (no `kind`/`source`) render identically to before (regression-free).
- [ ] A record with a malformed `kind` (e.g. unexpected/space-containing value) does NOT throw — it falls back to `decision` and still renders.
- [ ] No double kind-label: confirmed against the existing `::before` (if any) before adding a label.

## Verification

- [ ] Run the daemon on an isolated port (`COCKPIT_HOME=/tmp/cockpit-dev bun .../cockpit-server.ts --port 5999`), hand-append a few records to a log (one each `kind`, one `source:"scribe"`, one legacy with neither), open the dashboard, confirm accents + badge + legacy parity.
- [ ] Confirm the untracked empty-state shows the new CTA (view a live session that was never `cockpit start`'d / scribed).
- [ ] Grep the two files to confirm no other decision-card behavior changed.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | breaks existing cards or misreads fields | renders new fields but legacy/default drifts | kind + scribe badge + empty-state all correct, legacy untouched |
| Test coverage | ×2 | not viewed at all | one kind eyeballed | all kinds + scribe + legacy + empty-state verified in a running dashboard |
| Interface & readability | ×1 | hardcoded colors, messy classes | works but off-system | uses Night Flight tokens, class naming matches `decision-card__*` |
| Assumptions & docs | ×1 | silent visual churn on defaults | partial | default/legacy parity explicitly preserved |

## Out of scope

- SSE/stream changes — Deferred. Reason: `log-stream.ts` passes records verbatim; new fields already flow.
- Producing the data — Deferred. Reason: the `cockpit scribe` writer is the backend task; this task only renders the fields.
