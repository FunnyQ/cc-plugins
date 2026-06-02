# Log schema + scribe CLI contract

> Shared by `backend/01` (producer) and `ui/01` (consumer). Inline source of truth for the record shape and the new CLI surface.

## Record types (in `cockpit.ts`)

One JSON object per line in `<project>/.cockpit/logs/<sessionId>.jsonl`. Three existing record kinds, discriminated by `type`:

```ts
type GoalRecord = { type: "goal"; session_goal: string; ts: string };

type Facet = { label: string; text: string };

type DecisionRecord = {
  id: string;            // crypto.randomUUID()
  type: "decision";      // record discriminant — DO NOT overload for the lens
  kind?: DecisionKind;   // NEW — the lens; default "decision" when absent
  source?: DecisionSource; // NEW — who wrote it; default "agent" when absent
  decision: string;      // headline ("what you chose" / scribe --title)
  reason: string;        // markdown body ("why" / scribe --text)
  tradeoff: string;
  facets: Facet[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  timestamp: string;     // ISO
};

// ResponseRecord (broker.ts) is unchanged: { id, type:"response", call, answer, ts }
```

## New fields

```ts
type DecisionKind = "decision" | "rationale" | "learning" | "caveat";
type DecisionSource = "agent" | "scribe";
```

- Both are **optional** for backward compatibility. Readers (CLI, dashboard) apply defaults: `kind ?? "decision"`, `source ?? "agent"`.
- `cmdLog` (manual `cockpit log`) now sets `kind:"decision"`, `source:"agent"` explicitly.
- `cmdScribe` (new) sets `kind` from `--type`, `source:"scribe"`, `needs_your_call:false`.
- **No change to `log-stream.ts`** — `emitLines()` re-serializes each record verbatim, so the new fields reach the dashboard automatically.

## `cockpit scribe` CLI surface

```
cockpit scribe --type <kind> --text <body> [--title <headline>] [--file <path>]... [--session <id>] [--provider <p>]
cockpit scribe --recent [N]
```

Write mode (`--type` present):
- `--type` (required) — one of `decision|rationale|learning|caveat`; reject anything else with a non-zero exit + clear error.
- `--text` (required) — maps to `reason` (markdown body).
- `--title` (optional) — maps to `decision` (headline). Empty when omitted.
- `--file` (repeated, optional) — maps to `files[]`.
- `--session` / `--provider` (optional) — else auto-resolve via `findSession(provider, project)`; error if unresolved (same as `cmdLog`).
- Side effects, in order: `upsertSession(...)` (auto-register, so `tracked:true`) → `mkdirSync(logs)` → `appendFileSync(line)` → **concurrency-safe persistence guard** (a line with `id === rec.id` must exist *somewhere* in the file — NOT a tail check; background forks interleave writes, so the tail may belong to another writer) → `refreshHeartbeat(...)`. **No goal record is written.**

Recent mode (`--recent`, no `--type`):
- Prints the last N (default 8) records with `source === "scribe"`, one per line, compact: `kind · title · relative-or-ISO time`. Used by the scribe fork to dedup. Exits 0 (prints nothing if the log is absent/empty).
- `--recent` takes an optional numeric value: bare `--recent` → 8; `--recent 3` → 3; a following non-numeric flag (e.g. `--recent --provider codex`) must NOT be consumed.

## Existing helpers to reuse (in `cockpit.ts`, do not reinvent)

- `parseArgs(argv)` → `{ single, repeated, flags }`. Add `type`, `text`, `title` to `SINGLE_FLAGS`; add `recent` handling (it may carry an optional value — treat a following non-`--` token as N, else default 8).
- `logPathFor(project, sessionId)` — the log path.
- `findSession(provider, project)` — auto-resolve the live session id.
- `upsertSession(entry: RegistryEntry)` — registry write (`{ provider, project, sessionId, logPath, lastHeartbeat }`).
- `refreshHeartbeat(project, sessionId, provider)` — timestamp the registry entry.
- The read-back guard block in `cmdLog` (lines ~317–332) — copy its shape.

## Dashboard consumption (`decision-log.js` `decisionCard(rec)`)

- Add a kind class: `card.classList.add("is-kind-" + (rec.kind || "decision"))`.
- Add a source badge when `rec.source === "scribe"` (agent/default entries render as today — no new badge, zero visual churn).
- The card already reads `decision` (headline), `reason` (md body), `tradeoff`, `facets`, `files`, `needs_your_call`. `--title`/`--text` land in `decision`/`reason`, so they render with no extra wiring.
