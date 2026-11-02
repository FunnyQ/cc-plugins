# DECK-04: Honor the declared repo root when locating transcripts

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: deck/01, deck/03
> **Blocks**: skill/02
> **Status**: done

## Goal

Token and tool-call figures work for a run whose directory sits outside any git
repository, by using the repo root the graph declares instead of walking up from
the run directory to find one.

## Why this task exists

This is not visible from the code, so read it before touching anything.

Attribution never reads the event trail to find an agent's spend. It locates
agent transcripts on disk by mapping a **repo root** to a directory under the
Claude Code projects tree:

```
<projectsRoot>/<projectSlug(repoRoot)>/<sessionId>/subagents/workflows/wf_*/agent-*.jsonl
```

That repo root is found today by `repoRootOf(planDir)` — a walk up from the run
directory looking for a `.git` entry. Under the contract in
`../_context/contract.md`, the run directory lives under the user's XDG data
directory, outside any repository. The walk reaches the filesystem root and
returns `null`.

What happens then is the whole point of this task. In `createTranscriptSource`,
`resolveSlugDir()` returns `null`, `read()` returns `[]`, and every agent's
tokens and tool calls are absent. In the events handler, the same `null` makes
`readAgents()` skip the codex join entirely. **Nothing throws and nothing is
logged.** The panel renders correctly in every other respect and simply reports
that this run spent nothing.

A run that legitimately spent nothing looks identical. That silence is the
failure mode this task removes.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/usage-source.ts` (modify) — accept
  an explicit repo root and skip the walk when given one
- `packages/dispatch/skills/autopilot/scripts/usage-source.test.ts` (modify) —
  cover the four cases below
- `packages/dispatch/skills/autopilot/scripts/events-api.ts` (modify) — thread
  the declared root through to both consumers of it
- `packages/dispatch/skills/autopilot/scripts/events-api.test.ts` (modify) —
  cover the pass-through

## Implementation notes

### The transcript source

Current signature and the internals that matter:

```ts
export function createTranscriptSource(
  planDir: string,
  projectsRoot?: string,
): TranscriptSource {
  const root = projectsRoot ?? join(homedir(), ".claude", "projects");
  let cachedSlugDir: string | null = null;

  function resolveSlugDir(): string | null {
    if (cachedSlugDir !== null) return cachedSlugDir;
    const repoRoot = repoRootOf(planDir);
    if (repoRoot === null) return null;
    cachedSlugDir = join(root, projectSlug(repoRoot));
    return cachedSlugDir;
  }
  // …
}
```

Widened signature:

```ts
export function createTranscriptSource(
  planDir: string,
  projectsRoot?: string,
  repoRoot?: string,
): TranscriptSource;
```

`resolveSlugDir()` uses the passed `repoRoot` when it is a non-empty string and
skips `repoRootOf` entirely; otherwise it behaves exactly as it does now.

A third positional optional is acceptable here because only two call sites
exist — the events handler and the tests. If you prefer an options object as the
third parameter, that is fine too, but then update every call site in the same
task; leaving a mixed convention behind fails the readability dimension.

Two subtleties worth a one-line comment each in the source:

- **`planDir` stays the membership anchor.** The repo root only chooses _which
  directory to enumerate_. Whether a discovered transcript belongs to this run
  is still decided by `mentionsPlanDir(text, planDir)` against the run
  directory. Do not substitute one for the other.
- **The existing "failure to resolve is not cached" comment still holds, and now
  has a second half.** With an explicit root, resolution always succeeds, so the
  cache is populated on the first call and the directory may legitimately not
  exist yet. That is fine — enumeration of a missing directory already yields
  `[]` through `listNames`, and a later call picks it up once it appears.

### The events handler

`eventsHandler` builds both consumers of the repo root:

```ts
const usageSource =
  options?.source ?? createTranscriptSource(planDir, options?.projectsRoot);
// …
const repoRoot = repoRootOf(planDir);
```

`repoRoot` there is not decorative. It gates the codex join:

```ts
function readAgents(): AgentUsage[] {
  const agents = usageSource.read();
  if (repoRoot === null) return agents;
  return attachCodexUsage(agents, codexSource.read(), repoRoot, { … });
}
```

**So the codex side needs the same treatment, and this is the finding to act
on**: with no repo root, external-engine usage is dropped silently by the same
`null`, on top of the Claude figures being empty. Both are fixed by one change.

Add `repoRoot?: string` to the handler's `options`, resolve it once, and use
that one value in both places:

```ts
export function eventsHandler(
  request: Request,
  logPath: string,
  planDir: string,
  options?: {
    projectsRoot?: string;
    source?: TranscriptSource;
    codexRoot?: string;
    codexSource?: CodexSource;
    repoRoot?: string;
  },
): Response;
```

```ts
const repoRoot = options?.repoRoot ?? repoRootOf(planDir);
const usageSource =
  options?.source ??
  createTranscriptSource(planDir, options?.projectsRoot, repoRoot ?? undefined);
```

The caller that supplies this option is the server route for a contract-backed
run; it reads the value from the loaded graph. This task only has to accept and
use it — wiring the route is not yours.

### What must not change

For a run directory that **is** inside a repository and passes no explicit root,
every behaviour stays identical: the walk still runs, the same slug directory is
computed, the same transcripts are discovered, the same figures appear, and the
codex join still fires.

This is the regression that would be hardest to notice later, because
attribution failing is indistinguishable from a run that spent nothing. Prove it
with a test rather than leaving a reviewer to assume it.

### Membership and the join stay prompt-text rules

Locating the transcript directory is necessary but not sufficient, and this task
changes neither of the two rules stacked on top of it:

1. A transcript counts toward this run only when its **first message** contains
   the run directory's absolute path, matched at a segment boundary.
2. It is joined to a specific node only when that same first message carries the
   announce flags naming the node, the role, and the attempt.

State this in a comment where you touch the resolution, because the two failure
modes look different on the panel and the difference is what makes the next
problem diagnosable:

- **Directory never located** — no agents at all, plan totals zero.
- **Located but unattributed** — plan totals are non-zero, individual rows read
  as having no matching transcript.

A workflow whose prompts omit the conventions produces the second. This task
changes neither rule.

### A third rule this task does add: keep last run's spend out of this run

Rule 1 above tests for the run directory's absolute path, and that path is
identical on every run of the same workflow, because the slug is fixed. So once
the trail has been reset for a second run, the first run's transcripts still
match rule 1 and land in this run's totals and per-node figures — with a clean
trail, correct-looking numbers, and no symptom at all.

The discriminator is the run id: a one-line `run.id` file beside the graph file,
rewritten by the author before each run, whose value the author also
interpolates into every prompt. A transcript belongs to this run only when its
first message carries the current run id. Read the file, and add that string to
the membership test.

**Re-read it per snapshot, and key the membership cache on it.** The transcript
reader is built once and reused for the whole SSE connection, and it caches each
transcript's membership verdict — so a run id read only at construction would
leave a connected dashboard showing the previous run's attribution after a
re-run, or excluding the new run's agents entirely. Neither reports an error.
The example's own walkthrough has the reader open the panel first and start a
run second, so this is the ordinary path, not an edge case.

Read the file when each snapshot is built — it is one short file, and the
snapshot is already debounced — and include the value in whatever key the
membership cache uses, so a changed id invalidates the verdicts rather than
outliving them. The two transitions that must work on one live connection are
no id becoming an id, and one id becoming another.

**Do not use an elapsed-time window instead.** It was the obvious alternative
and it does not work: a run that fails and is immediately re-run puts both runs
inside any window wide enough to absorb the gap between an agent being spawned
and its announce landing, and nothing forces a minimum interval between runs.
Identity separates them; time cannot. Record that reasoning where the check
lives, or it gets "simplified" back into a timestamp comparison.

**Scope the whole rule on the source field, never on whether a file exists.**
The events handler's options carry `deckSource: "tasks" | "graph"`, set once by
detection. It is deliberately not called `source` — that name is already taken
by the options' `source?: TranscriptSource` injection point, which stays exactly
as it is. Branch on `deckSource`:

- `"tasks"` — the check never runs. Attribution behaves exactly as it does
  today, whatever files happen to sit in the directory.
- `"graph"` with a run id — a transcript must carry that id.
- `"graph"` with no run id — nothing is attributed. Under this contract a run
  that has begun has an id; its absence means no run has started, and reporting
  a previous run's figures as this one's is worse than reporting none.

The two `"graph"` rows differ from the `"tasks"` row, and that is the point.
Inferring the source from file presence collapses them: a task tree that happens
to hold a run id file would start filtering, and a contract run missing one
would fall through to today's unfiltered behaviour — each taking the other's
branch, silently. Getting the `"tasks"` row wrong zeroes every autopilot run's
usage, which is the silent regression this task's rubric weighs most.

Test it with two fixture transcripts against one run directory: one carrying a
previous run id, one carrying the current one. The stale one must appear in
neither the totals nor any node's figures; the current one must appear in both.
Then test a task-file directory with no run id present and transcripts of every
age, and assert the figures are unchanged from today's.

## Acceptance criteria

- [x] `createTranscriptSource` accepts an explicit repo root and, when given
      one, resolves the slug directory without calling `repoRootOf`.
- [x] An explicit root that sits outside any git repository resolves the
      transcript directory and returns that run's agents.
- [x] An explicit root takes precedence over whatever a walk from the run
      directory would have found.
- [x] With no explicit root, resolution falls back to the walk and behaves
      exactly as before — asserted by a test, not by inspection.
- [x] A transcript carrying a previous run id is excluded from the plan totals
      and from every node's figures; one carrying the current run id is included
      in both.
- [x] The graph source with no run id attributes nothing.
- [x] The task-file source never applies the check, and its figures are
      identical to today's even when a run id file is present in the directory —
      asserted by a test, since this is the silent regression path.
- [x] The branch reads the deck-source field and never infers the source from a
      file's presence, and the existing transcript-reader injection point is
      unchanged.
- [x] On one live connection, an identifier appearing where there was none, and
      an identifier changing to another, both take effect on the next snapshot
      rather than persisting the previous verdicts.
- [x] The reason identity is used rather than an elapsed-time window is recorded
      where the check lives.
- [x] An explicit root whose **computed transcript directory** does not exist
      returns an empty list rather than throwing.
- [x] An explicit root naming a repository directory that no longer exists, but
      whose computed transcript directory is still present, still returns those
      transcripts. The root is a key for computing the project slug, not a path
      that has to be on disk — adding an existence check on it would silently
      lose readable usage for a repo the user has since deleted or moved.
- [x] `eventsHandler` accepts an optional repo root and uses that one value both
      for the transcript source and for the codex join, so external-engine usage
      is no longer dropped when the run directory is outside a repository.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/usage-source.test.ts`
      passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/events-api.test.ts`
      passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes — the whole
      autopilot suite, to catch a regression in a neighbouring consumer.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. Run the
      typecheck against the root `tsconfig.json` with no file list. The
      repo-wide run is **not** green — 86 pre-existing errors sit outside this
      plan — so a zero total is not the bar; an empty grep for these paths is.

Fixture shape for the tests, following the style already in the neighbouring
test file — real temp directories, never mocks:

```ts
function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "usage-source-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Build a fake projects root and a fake repo root as two sibling temp directories,
with the agent transcript at
`<projectsRoot>/<projectSlug(repoRoot)>/session-1/subagents/workflows/wf_1/agent-a.jsonl`.
For the precedence case, give the run directory a real `.git` entry so a walk
would succeed, then pass a different explicit root and assert the explicit one
won.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                   | 2–3 (below bar)                                                                                       | 4–5 (pass)                                                                                                                                                     |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | The explicit root is accepted but not used, or the walk still runs and wins                  | Works for the plain case but a non-existent root throws, or precedence is decided the wrong way round | Explicit root always wins, absent root falls back exactly as before, a missing directory yields an empty list, and the codex join uses the same resolved value |
| Backward compatibility  | ×2     | An existing in-repository run changes behaviour, or an existing call site no longer compiles | Behaviour is preserved but only argued for, with no test that would catch a regression                | A test pins the no-explicit-root path against the walk, and the whole autopilot suite passes untouched                                                         |
| Test coverage           | ×2     | No test, or one that would still pass with the change reverted                               | Only the happy path — an explicit root that resolves                                                  | All four named cases covered with real temp directories, plus the handler pass-through                                                                         |
| Interface & readability | ×1     | Mixed conventions left behind, or the root threaded through as a second source of truth      | Works but the new parameter's meaning is unclear at the call site                                     | One resolved value used by both consumers, the parameter's purpose obvious, no call site left on the old shape                                                 |
| Assumptions & docs      | ×1     | The silent-failure reason is nowhere in the source                                           | The change is made but the reader cannot tell why an explicit root exists                             | A one-line comment records why the walk cannot work here and that the run directory stays the membership anchor                                                |

## Out of scope

- **Proving attribution end to end against a real workflow run** — Deferred. It
  requires executing a real Workflow, which costs tokens and needs separate
  authorization; it is recorded as a known gap for the run as a whole. The tests
  here prove the directory is located, not that a live run's prompts satisfy the
  membership and join rules.
- **Changing how agent prompts are written** — Deferred. The announce
  conventions belong to the authoring reference, not to the reader.
- **Any change to how token figures are displayed** — Deferred. The frontend is
  already data-driven and out of scope for this plan.
- **Wiring the server route that supplies the declared root** — Deferred. This
  task accepts and uses the value; producing it belongs to the loader and the
  route.
