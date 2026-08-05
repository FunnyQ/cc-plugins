# The cockpit trail and the ADR format

> Domain reference. Everything here is measured or quoted from the running system, not assumed.

## Where the trail lives

A project's decision trail is a `.cockpit/` directory anchored to the **repo**, not the current
working directory. The resolution rule, in order:

1. An already-existing `.cockpit/` between cwd and the git root — nearest wins.
2. The git root.
3. cwd, when not inside a git repo.

Rule 1 is an escape hatch: a hand-made `packages/x/.cockpit` keeps its own trail. **The walk-up is
bounded by the git root and must never cross it.** `~/.cockpit` is a real leftover directory from
the pre-XDG cockpit home, and an unbounded walk would collapse every repo under `$HOME` into one
trail.

Authoritative source (for verification only, not importable):
`packages/monitor/skills/cockpit/scripts/log-root.ts`.

Its shape, which the port should preserve:

```ts
export type LogRootDeps = {
  /** Injectable for tests; defaults to the real `git rev-parse`. */
  gitRoot?: (cwd: string) => string | null;
};

/** The git top level containing `cwd`, or null when `cwd` is not in a repo. */
export function gitRootOf(cwd: string): string | null;

/** The directory whose `.cockpit/` holds this project's decision trail. */
export function logRoot(cwd: string, deps?: LogRootDeps): string;
```

Two details that are easy to lose in a port:

- `git rev-parse --show-toplevel` reports a realpath, so cwd must be normalized with `realpathSync`
  too, or the two never compare equal under a symlinked tmpdir (`/tmp` on macOS).
- If cwd is not inside the reported root — a stale or renamed checkout, or an injected resolver —
  return the root immediately rather than walking cwd's own branch, or the walk could adopt a
  `.cockpit` outside the repo entirely.

## Directory layout

```
.cockpit/
├── logs/                inbox — not yet triaged. One `<session-id>.jsonl` per session.
└── archive/
    ├── done/            dispositioned; never returns on its own
    └── watch/           dispositioned; returns when new matching evidence arrives
```

`archive/` does not exist yet. This plan creates it.

Measured in this repository on 2026-08-06: **63 files in `.cockpit/logs/`, 636K total**, against
**27 matching registry entries**. That gap is the reason the trail must be read from the directory
rather than the registry — the registry reaps entries older than 14 days on every write, and the
oldest tail is exactly the part that can answer "has this decision held up".

`.cockpit/` is gitignored, so the archive is local-only.

## Decision record shape

Each log file is JSONL: one JSON object per line, append-only. Lines that fail to parse, or that do
not match the record shape, are skipped rather than fatal.

```ts
export type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: "decision" | "rationale" | "learning" | "caveat";
  source?: "agent" | "scribe";
  decision: string;
  reason: string;
  tradeoff: string;
  facets: { label: string; text: string }[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  diagram?: string;
  timestamp: string;
};
```

A real entry, abridged — note that `reason` is a full argument, not a sentence, and `diagram` can
hold a whole Mermaid graph:

```json
{"id":"4fbc8de9-f356-440d-9af3-401d977e0f35","type":"decision","kind":"learning",
 "source":"scribe","decision":"Agent(type) whitelist is inert in a subagent definition",
 "reason":"<~400 words of argument>","tradeoff":"","facets":[],"needs_your_call":false,
 "options":[],"files":["packages/chronicle/agents/lawspeaker.md"],
 "diagram":"flowchart TD\n  ...","timestamp":"2026-07-14T09:12:03.441Z"}
```

**Why two-pass loading is mandatory.** This repository alone holds roughly 352 entries. Loading
every `reason` and `diagram` at once does not fit in a useful context window.

- **Pass 1** emits skeletons only: `id`, `kind`, `decision`, `timestamp`, `files`. No `reason`, no
  `tradeoff`, no `facets`, no `diagram`, no `options`.
- **Pass 2** returns full records, but only for explicitly requested ids.

## The live-session bound

```ts
export const STALE_MS = 10 * 60 * 1000; // 10 min
```

Authoritative source (for verification only, not importable):
`packages/monitor/skills/cockpit/scripts/registry.ts`. It matches token-atlas live filtering.

**Never move a log file whose mtime is within `STALE_MS` of now.** Cockpit resolves the log path on
every single write, so moving an active session's log makes the very next write recreate an empty
file at the original path — splitting one session across two files, silently, with no error. This
is the single most damaging failure mode in the whole plan.

## The inbox model

Position in the filesystem *is* the state. There is no ledger and no database.

- `logs/` holds the unprocessed backlog.
- `archive/done/` holds sessions that were dispositioned `promote` or `skip`. Both land here: they
  behave identically, and "did this become an ADR" is answerable by grepping ADR evidence sections.
- `archive/watch/` holds sessions judged promising but not yet stable. They never re-queue on their
  own; only a fresh candidate cluster that matches one pulls it back for re-judging.

**Granularity is per file, not per entry.** Judgment is per entry, but archiving moves whole session
files, so triaging a session means dispositioning everything in it — entries not promoted are
implicitly skipped. Splitting files would mutate an append-only source; per-entry tracking would
reintroduce the ledger this model exists to remove.

**Archive, never remove.** Reconstructing a decision that spans an already-processed session
requires reading `archive/done/`, and a wrong ADR must be correctable. Nothing in this plan deletes
a log file.

## ADR format

ADRs live in `docs/adr/`, named `NNNN-<kebab-title>.md` with a four-digit zero-padded number. The
next number is the highest existing number plus one; an empty or missing directory yields `0001`.

```md
# ADR-0001: Title

- Status: Proposed | Accepted | Superseded | Deprecated
- Date: YYYY-MM-DD
- Supersedes: ADR-NNNN (optional)
- Superseded by: ADR-NNNN (optional)

## Context
## Considered alternatives
## Decision
## Consequences
## Evidence
```

### Status is implementation state, not review state

| Value | Means | Requires |
| --- | --- | --- |
| `Accepted` | Live in the code today | — |
| `Proposed` | Drafted ahead of the work | — |
| `Superseded` | Replaced by a named successor | a `Superseded by: ADR-NNNN` line |
| `Deprecated` | No longer applies, with no successor | no successor link |

The conventional ADR lifecycle tracks agreement between people and runs forward: draft `Proposed`,
review, `Accepted`, then build. This flow runs backward — a candidate only exists because the
decision was already made, implemented, and recorded. So `promote` writes `Accepted`.

Defaulting to `Proposed` was considered and rejected: no moment in this workflow would ever promote
them, so every ADR would sit at `Proposed` forever and the field would carry no information at all.

### Evidence must not point at `.cockpit`

`## Evidence` embeds a **stable summary** per source entry, plus the session id, the entry id, and
the date. It must not rely on the log file remaining readable. Logs can be deleted by hand and
`.cockpit/` never enters git, so a path reference is guaranteed to rot. Session ids are historical
labels, not lookup keys.

Exclude secrets, credentials, personal data, and raw transcript text from evidence.

## Promotion threshold

Require **at least one** of:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

**Plus at least one** of:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

Reject promotion when the material is a local implementation detail, a temporary workaround, a
mechanical convention, or a caveat that belongs in code or operational documentation.
