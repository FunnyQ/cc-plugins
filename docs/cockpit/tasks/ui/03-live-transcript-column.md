# UI-03: Live-transcript column

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: ui/01, server/04
> **Blocks**: —
> **Status**: done

## Goal

The left column renders the selected session's live transcript — adapting token-atlas's transcript renderer (markdown, tool pairing, diffs, syntax highlight) into a persistent column (not a modal).

## Files to create / modify

- `cockpit/skills/cockpit/dashboard/dist/modules/transcript.js` (new) — EventSource client + entry renderer for the transcript column.
- `cockpit/skills/cockpit/dashboard/dist/app.js` (modify) — mount the column.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (modify) — transcript styling (adapt from token-atlas `live.css`).

## Implementation notes

### Data source

`EventSource` to `/api/transcript/stream?session=<selectedSessionId>` (the transcript SSE endpoint). Re-open on selection change; close the previous.

### Renderer — lift from token-atlas

Copy the transcript-rendering logic from `cc-plugins/token-atlas/skills/dashboard/dashboard/dist/modules/dashboard-app.js` (see engine-reuse.md). Keep:

- **Pre-render once**: each entry → HTML on receipt, cached on the entry (keyed by a stable per-line key); never re-run markdown on reactive updates.
- **Segments**: prose → `marked` then `DOMPurify.sanitize` (GFM tables, new-tab-safe links); `thinking` → muted "💭 thinking" badge; `tool_use`/`tool_result`/JSON → escaped `<pre>` highlighted with `highlight.js`; `Read` results → line-number gutter; `Edit`/`MultiEdit`/`Write` → inline color-coded diffs.
- **Tool pairing**: `reconcileToolResults()` — merge a `tool_result`-only entry into the entry holding its `tool_use` (by `tool_use_id`), drop the standalone bubble.
- **Type allowlist**: only conversation entries stream; filter metadata noise (`file-history-snapshot`, `queue-operation`, `last-prompt`, …).
- **Scroll**: auto-scroll only when bottom-pinned.

Import `marked.esm.js`, `purify.es.mjs`, `highlight.esm.js` from `./vendor/`.

### Trim

- No Codex-specific rendering (cockpit streams Claude only).
- This is a **column**, not a modal — no open/close overlay; it fills its grid cell and scrolls internally.
- Empty state when no session selected / no transcript: "No live transcript."

## Acceptance criteria

- [x] Selecting a session streams its transcript backlog then live appends into the left column.
- [x] Prose renders as sanitized markdown; `thinking` shows a muted badge; tool calls/results render as highlighted code; file edits render as diffs.
- [x] A `tool_result` is paired into its `tool_use` entry (no orphan bubbles).
- [x] Metadata-noise entry types are filtered out.
- [x] Column auto-scrolls only when bottom-pinned; switching sessions resets it and closes the old EventSource.
- [x] No Codex code paths in the cockpit copy.

## Verification

- [x] Daemon running, pick a real session: load SPA (Q), select it → transcript renders with markdown/diffs/tool blocks.
- [x] Continue working in that Claude session → new entries append live in the column.
- [x] `grep -i codex modules/transcript.js` returns nothing.

## Out of scope

- Reverse-pagination / scroll-to-top history — Optional; add only if needed (the transcript SSE endpoint left it optional).
- Decision-log / info columns — Deferred to the decision-log and info column tasks.
