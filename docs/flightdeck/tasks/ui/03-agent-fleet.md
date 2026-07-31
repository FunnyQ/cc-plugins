# UI-03: agent fleet and score meters

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/hangar.md`
> - `../_context/rubric.md`
>
> **Depends on**: ui/01, server/05
> **Blocks**: wiring/03
> **Status**: done

## Goal

The bottom half of the page shows every agent the run has seen as a live table — role, task, attempt,
elapsed time, verdict — with in-flight agents pinned to the top and updating over the event stream.

## Files to create / modify

- `packages/dispatch/skills/autopilot/dashboard/dist/modules/fleet.js` (new) — the fleet component and
  the event-stream client.
- `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (modify) — mount it into the fleet section.
- `packages/dispatch/skills/autopilot/dashboard/dist/style.css` (modify) — table and meter rules.

## Implementation notes

The event frame sequence, the entry types, the agent-label taxonomy, and the fleet row shape are all
specified in the data model context file listed in Required reading. The colours, the status dot, the
pulse animation, the score meter, and the breakdown bars are specified in the design context file.

### This component renders; it does not derive

The stream delivers fully aggregated rows. Pairing, ordering, label parsing, and score attachment all
happened on the server, where they are unit-tested once. **Do not reimplement any of them here.** Take
`rows` as given and render it in the order received. A second implementation would drift from the first
and the two would disagree about something the user is watching live.

The one derived value this component owns is the ticking elapsed display for an in-flight row. A row
that is still in flight arrives with `startedAt` set and `elapsedMs` undefined; tick it against the
browser clock once per second. That is a rendering concern, which is exactly why the server-side
function stays pure and leaves it undefined.

For a finished row, print `elapsedMs` as given. Never recompute it.

### Connecting

Open an `EventSource` on `/api/events` at mount. Each `fleet` event carries the complete current row
set, so handling is simply: replace the local rows with the payload's rows. There is no accumulation,
no dedup, and no replay protocol to get wrong.

That also makes reconnection free. `EventSource` reconnects on its own after a drop, and the first
snapshot it receives afterwards is already complete and current. Nothing special is needed.

Show connection state in the section header, driven by the `EventSource` ready state plus the payload's
`logPresent` flag:

- **waiting for the run** — connected, `logPresent` false. Normal and common; a user opens the page
  before the first agent writes anything. This must not read as an error.
- **live** — connected, `logPresent` true.
- **reconnecting** — the connection dropped and the browser is retrying.

Also surface `entryCount` somewhere small. It tells the viewer the run is producing output even during a
stretch where no row changes.

### The table

Columns, left to right: status dot, role, task ref, attempt, elapsed, verdict, message.

- **role** — the parsed role, as a badge.
- **task ref** — monospace. Blank for a scout or the post-loop commit, which carry no ref.
- **attempt** — blank when absent rather than shown as zero.
- **elapsed** — `12.4s` under a minute, `3m 20s` above it. Blank until a start timestamp exists.
- **verdict** — the score meter with its numeric value, only on rows that carry a score. Rows without a
  score show nothing here, never an empty meter.
- **message** — the end entry's message, truncated to one line with the full text available on hover.

In-flight rows pin above finished rows and pulse their status dot in amber. Only the dot animates;
pulsing a whole row makes the text unreadable.

A row whose label did not parse renders with role `unknown` and its raw label in the role column. That
is deliberate: an agent writing an unexpected label is worth seeing, not hiding.

### Score display

A row's score arrives already attached. Render the meter when it is present and nothing at all when it
is not. Clicking a row with a score expands its rubric breakdown, matching the card behaviour in the
lanes above. A hard-failed score uses the alert colour and states the failure in words beside the bar;
colour alone must not carry it.

### Volume

A long run produces hundreds of entries. Cap the rendered table at the most recent 200 rows and show a
count of how many are hidden. Never silently truncate — a table that quietly stops at 200 reads as a
complete list.

## Acceptance criteria

- [x] The table renders the rows in the order received, without re-sorting or re-deriving them.
- [x] No pairing, label-parsing, ordering, or score-attachment logic exists in this component.
- [x] A snapshot replaces the local row set; a reconnect produces no duplicate rows.
- [x] An in-flight row shows a pulsing amber dot and an elapsed value ticking once per second.
- [x] A finished row prints the elapsed value from the payload without recomputing it.
- [x] Elapsed formats as seconds under a minute and minutes plus seconds above it.
- [x] `entryCount` is visible somewhere in the section.
- [x] A row with a score shows the meter, the threshold tick, and the numeric value; a row without one
      shows nothing in that column.
- [x] A hard-failed score is stated in words as well as colour.
- [x] Clicking a scored row expands its rubric breakdown.
- [x] An unparseable agent label renders as role `unknown` with the raw label visible.
- [x] Connection state is visible, and the pre-run waiting case does not read as an error.
- [x] Above 200 rows, the count of hidden rows is shown.

## Verification

- [x] Copy a real trail to a scratch plan directory and start the daemon against it:
      `docs/chronicle/.flightlog/run.jsonl` holds real score and note entries and no start entries,
      so every row must render as finished with a verdict.
- [x] Append a start entry by hand with the flightlog CLI and confirm a pulsing in-flight row appears
      within 2s with an elapsed value that ticks upward.
- [x] Append the matching end entry and confirm the row moves to finished with a fixed elapsed value.
- [x] Restart the daemon while the page is open; confirm the table repopulates without duplicate rows.
- [x] Open the page against a plan whose flightlog does not exist yet; confirm the waiting state renders
      and no error is shown.
- [x] Append an entry with a nonsense agent label and confirm it renders as `unknown` with the raw text.
- [x] Confirm the reduced-motion setting stops the pulse: enable it at the OS level and reload.
- [x] Confirm no derivation leaked into the client:
      `rg -n "agentLabel|attempt.*#|sort\(" packages/dispatch/skills/autopilot/dashboard/dist/modules/fleet.js`
      shows no pairing, label-splitting, or re-sorting of the payload rows.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Reimplements pairing or ordering, or in-flight rows never appear | Renders the payload but re-sorts it, or recomputes a finished row's elapsed value | Renders rows as given, replaces on each snapshot, ticks only in-flight rows, all three connection states correct |
| Design fidelity | ×2 | Invents colours, or animates whole rows | Uses tokens but the meter or badge form drifts | Only the dot pulses, meter and badge match the specs, reduced-motion honoured |
| Test coverage | ×2 | No verification performed | Rendered a static trail only | Static trail, live append, reconnect, missing-log waiting state, unknown label, reduced motion |
| Interface & readability | ×1 | Stream handling and rendering tangled | Separated but the component carries derivation helpers it should not own | Stream client separate from the component, component is a pure renderer over the payload |
| Assumptions & docs | ×1 | The server-owns-derivation split is undocumented | Noted but not explained | Comments explain why rows are rendered as given and why the live tick is the one exception |

## Out of scope

- Rendering agent transcripts or reasoning. The cockpit plugin owns that surface; flightdeck shows fleet
  state only, and the verify and judge stages appear as markers rather than streamed output.
- A staleness ceiling on in-flight rows. Deferred: an agent that dies without an end entry reads as in
  flight for the rest of the run, which is the accepted v1 behaviour.
- Filtering or searching the table. Deferred until a real run shows it is needed.
- Any control that sends anything to an agent. flightdeck is read-only.
