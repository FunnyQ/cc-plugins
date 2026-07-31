# UI-02: task lanes

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/hangar.md`
> - `../_context/rubric.md`
>
> **Depends on**: ui/01, server/04
> **Blocks**: ui/04, wiring/03
> **Status**: done

## Goal

The top half of the page shows the whole task tree as bucket lanes of cards, each card carrying its
derived state, attempt count, latest score, and what is blocking it.

## Files to create / modify

- `packages/dispatch/skills/autopilot/dashboard/dist/modules/lanes.js` (new) — the lanes component.
- `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (modify) — mount it into the top section
  and add the refresh cycle.
- `packages/dispatch/skills/autopilot/dashboard/dist/style.css` (modify) — lane and card rules.

## Implementation notes

The tree payload shape, the four derived states, and the score fields are specified in the data model
context file listed in Required reading. The colours, the status-dot shape, the score meter, the
breakdown bars, and the badge style are specified in the design context file. Both are authoritative.

### Layout

One column per bucket, ordered alphabetically, each headed by the bucket name and a count of finished
over total for that bucket. Cards stack vertically inside a lane, ordered by their two-digit sequence.

The lane strip scrolls horizontally inside its own container. The page body must never gain a horizontal
scrollbar — that is a stated rule, and a wide tree is exactly what would break it.

### The card

Each card shows, in this order:

- status dot plus the task ref, in monospace
- the title
- a badge row: attempt count when above 1, a final-review marker when the task carries that flag, and
  one blocked-by badge per unfinished dependency
- the score meter with its numeric value, when a latest score exists

A card with no score yet shows no meter. Do not render an empty track — a zero-width bar reads as a
score of zero, which is a different and much worse claim than "not yet judged".

The blocked-by badge names the dependency ref it is waiting on. Read those refs from the payload's
`blockedBy` array; never re-derive them in the browser, because the derivation already ran on the server
and two implementations will drift.

### Score meter

Threshold tick and fill colour rules are in the design context file. The numeric value must always be
printed beside the bar. Colour alone is not an acceptable channel for a number, and a bar alone cannot
be read precisely.

Clicking a card expands it to show the rubric breakdown — one thin bar per dimension, width proportional
to weight, fill proportional to score, dimension name beside it. Collapsed by default. Keep the expanded
state in the component, not in the URL.

### Refresh

Task files change on disk throughout a run, and the tree endpoint has no push channel. Re-fetch
`/api/tree` every 3s. Pause polling while `document.hidden` is true and re-fetch immediately when the
tab becomes visible again, so a backgrounded tab costs nothing.

A failed refresh must not blank the lanes. Keep the last good payload rendered and surface the failure
in the header's existing error slot. A transient failure during a daemon restart is expected, and
throwing away the view for it would make the screen flicker empty during exactly the moments worth
watching.

### Empty and degenerate trees

- A tree with no tasks renders an explicit empty state, not a blank strip.
- A bucket whose tasks all failed to parse still renders its lane heading with the error visible. The
  payload lists every bucket directory and tags each error with its bucket, so the heading and its errors
  can be placed without guessing.
- A task with a `null` status renders as `blocked`, matching the server's derivation, rather than
  crashing on a missing value.

## Acceptance criteria

- [x] One lane per bucket, alphabetically ordered, each with a finished-over-total count.
- [x] Cards within a lane are ordered by their two-digit sequence.
- [x] Each card shows a status dot coloured by derived state, the ref in monospace, and the title.
- [x] A task on attempt 2 or higher shows its attempt count.
- [x] A blocked task shows one badge per unfinished dependency, naming that dependency's ref.
- [x] A task with a score shows the meter, the threshold tick, and the numeric value.
- [x] A task with no score shows no meter at all.
- [x] Clicking a card reveals its rubric breakdown bars; clicking again collapses them.
- [x] The lane strip scrolls horizontally; the page body does not.
- [x] Polling pauses while the tab is hidden and resumes on visibility.
- [x] A failed refresh keeps the last good render and surfaces the error in the header.
- [x] An empty tree renders an explicit empty state.

## Verification

- [x] Start against a real tree with 6 tasks in 3 buckets, all done:
      `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan "$(git rev-parse --show-toplevel)/docs/waypoints-skill"`
      — confirm 3 lanes, 6 cards, every dot in the done colour.
- [x] Start against this plan's own tree, whose tasks are mostly unstarted, and confirm the mix of
      ready and blocked states with correct blocked-by badges.
- [x] Copy a plan tree to a scratch directory, edit one task's `Status` to `todo` and another's
      dependency so it cannot be satisfied, restart, and confirm the ready and blocked rendering.
- [x] In that scratch copy, corrupt every file in one bucket and confirm its lane heading still renders
      with the parse errors shown beneath it, rather than the bucket disappearing.
- [x] Click a card that has a score and confirm the breakdown bars appear with dimension names.
- [x] Background the tab for 30s, confirm no network requests fire, then focus it and confirm one fires
      immediately.
- [x] Stop the daemon while the page is open; confirm the lanes stay rendered and the header shows the
      error.
- [x] Confirm no horizontal page scrollbar at 1000px, 900px, and 600px wide.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong state colours, or a failed refresh blanks the view | Renders correctly but polling ignores visibility, or an unscored task shows an empty meter | States, badges, ordering, meter presence, visibility-aware polling, and refresh resilience all correct |
| Design fidelity | ×2 | Invents colours or spacing, or the page body scrolls horizontally | Uses tokens but density or radius drifts from the system | Every value from the token layer, correct dot and badge and meter forms, lane strip scrolls not the body |
| Test coverage | ×2 | No verification performed | Rendered one tree only | Both real trees checked, plus a hand-edited tree exercising ready, blocked, and dangling dependencies |
| Interface & readability | ×1 | Derivation duplicated in the browser | Component works but mixes fetch, state, and render | Renders the server payload as given, component split cleanly from the store |
| Assumptions & docs | ×1 | Poll interval is a bare literal | Named but unexplained | Comments explain why a failed refresh keeps the last render and why derivation is not repeated client-side |

## Out of scope

- The dependency graph view. It is a separate task in this bucket; the header toggle already exists but
  its second view can stay empty here.
- The agent fleet table. Separate task, bottom half of the page.
- Consuming the SSE stream. Lanes run on the polled snapshot; live agent state arrives through the fleet.
- Any control that mutates a task. flightdeck is read-only.
