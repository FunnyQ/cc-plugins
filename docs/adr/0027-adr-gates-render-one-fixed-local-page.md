# ADR-0027: ADR gates render one fixed local page, and fallbacks follow the browser, not the harness

- Status: Accepted
- Date: 2026-08-07

## Context

Chronicle's ADR triage stops at two human gates: confirm the dispositions, then
approve the drafts. ADR-0013 records what `needs_your_call` gates on — explicit
`answer_here` intent plus subscriber liveness. This record is not about that
rule. It is about the surface a gate presents when it asks.

Two things forced the question. First, both of ADR-0013's factors are absent by
default, so `cockpit wait --require-watcher` exits `4` on an ordinary run and the
gate has nowhere to ask. Second, even when the wait succeeds, a gate may carry up
to twelve complete records, and twelve records do not fit a cockpit card that was
built for a one-line question.

Before this decision the main agent hand-built a review page at each gate. That
worked, and it was the wrong shape: two consecutive runs produced pages that
differed in layout, in wording, and — the part that matters — in which
consistency checks the page actually enforced.

## Considered alternatives

- **Retry `cockpit wait` in a loop.** Rejected: neither factor becomes true on
  its own. Intent is a manual toggle and liveness needs a live tab, so the loop
  degenerates into the infinite hang ADR-0013 already ruled out.
- **Fall back to `AskUserQuestion`.** Rejected: it bypasses the cockpit bridge,
  so the answer never lands in the decision trail and the session looks, from
  cockpit's side, as if nothing was ever asked.
- **Keep `cockpit wait` primary and treat the page as the fallback.** Rejected:
  the wait succeeds only under a manual toggle, which makes the "fallback" the
  common path and the primary the exception. Naming them that way around left the
  page under-specified precisely where it was used most.
- **Let the main agent design the page each run.** Rejected after the drift
  described above. A gate's consistency checks are part of its contract; a
  surface that re-derives them from prose each run enforces a different contract
  each run.
- **Publish the page through `Artifact` by default.** Rejected: the page is
  self-contained, so hosting buys nothing, and it sends a local repo's decision
  trail and its full draft text off the machine for a review that never leaves
  the desk.
- **Split the surface by harness — `Artifact` on Claude Code, terminal markdown
  on Codex.** Rejected: Codex writes files and spawns processes exactly as Claude
  Code does, so it runs the same Bun script and opens the same page. The split
  was never about the harness.

## Decision

`skills/adr/scripts/gate-page.ts` renders both gates. The main agent supplies a
payload JSON and nothing else — never markup, never styling. The script owns the
layout, the wording, and the consistency checks: gate 1 enforces the twelve-record
cap and the group-holds-a-non-promote-row contradiction; gate 2 shows every
proposed record verbatim with an approve-or-drop control and an editor whose edit
rides back as that verdict's `draftText`.

The surface cascade follows the browser:

1. Render the page and open it locally. This is the default on every harness.
2. If the platform opener fails — `--open` exits `3` for a headless run, a remote
   environment, or Claude Code on the web — publish the already-rendered file
   through `Artifact`, without rebuilding its markup.
3. If no `Artifact` tool exists either, print the same content as structured
   markdown in the transcript.

All three levels round-trip one fixed JSON reply schema per gate, so the main
agent runs the same consistency checks against any of them.

`cockpit wait` and `needs_your_call` are removed from both gates. The skill logs a
plain decision entry recording that the gate was reached, then ends the turn.
`AskUserQuestion` stays banned for the same reason it always was.

## Consequences

A gate's contract now lives in one testable script rather than in prose the main
agent re-interprets each run, so changing a check means changing code and its
tests, not re-reading a skill file. The reply schema is load-bearing: it is what
lets every fallback level be checked identically, so renaming a field means moving
the renderer, the client, and the main agent's parser together.

Nothing parks waiting for an answer any more. A gate ends the turn, which means
the run cannot strand on a call nobody will answer — and also that cockpit no
longer shows the run as blocked. The plain decision entry is the only signal that
a gate was reached.

The `Artifact` path is not gone; it is the level-2 fallback and the only surface
that works where there is no local browser. Dropping it would strand headless,
remote, and web runs on an unopenable file path.

## Evidence

- **A refused gate needs a fallback that is neither a retry nor
  `AskUserQuestion`** — on `cockpit wait --require-watcher` exit `4`, the gate
  renders its own review surface (gate 1 a disposition ledger with a copy-back
  button, gate 2 a per-record verbatim read-through), so the answer still returns
  through the same plaintext channel instead of a tool that would skip the
  decision trail.
  Session `0a5b24d4-1e03-4f37-bf99-ef39614c6dbc`, entry `60f60b11-d8a0-4bcb-95a9-13178f9357fd`, 2026-08-06.
- **The reply needs a fixed schema, because a gate's consistency checks have
  nothing to parse against free text** — gate 1 requires a complete
  `dispositions` array keyed by `entryIds` (candidates carry no separate id
  field) plus `conflictResolutions`; gate 2 requires one `verdicts` entry per
  draft with `approve`/`drop` and an optional replacement `draftText`.
  Session `0a5b24d4-1e03-4f37-bf99-ef39614c6dbc`, entry `82f8c87f-f980-4a2f-a6ba-361058fc4ae7`, 2026-08-06.
- **The cascade follows the browser, not the harness** — the earlier reading,
  that Codex needed a terminal-markdown branch because it lacks an `Artifact`
  tool, was wrong. Codex writes files and spawns processes as Claude Code does,
  so it runs the same script and opens the same local page. A missing tool had
  been over-read as a missing capability class.
  Session `55e1fac6-b27a-466f-a918-4d008fcac204`, entry `470240d3-5df8-4186-bae2-1490c0aadc0a`, 2026-08-07.
- **`cockpit wait` and `needs_your_call` leave both gates** — the wait needs the
  `answer-here` switch on and a subscribed tab, so it fails on an ordinary run,
  and twelve full records read badly in a cockpit card even when it succeeds. The
  skill logs a plain decision entry and ends the turn instead of parking.
  Session `55e1fac6-b27a-466f-a918-4d008fcac204`, entry `b3beb006-1bf3-4325-b06b-e2084f0d694d`, 2026-08-07.
