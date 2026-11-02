# The contract

> This file is the single thing every task in this plan must agree on. If an
> implementation needs to deviate, the deviation is recorded here and in
> PLAN.md **before** the code lands, never after.

## On-disk layout

```
~/.local/share/q-lab/flightdeck/<slug>/
├── graph.json
├── run.id                # this run's identifier, one line, rewritten per run
└── .flightlog/
    ├── .gitignore        # "*", written automatically on first append
    └── run.jsonl
```

`<slug>` is kebab-case, chosen by the workflow's author, fixed for that
workflow. It cannot be the Workflow tool's `wf_<runId>`: that id does not exist
until the run starts, and the script — which must contain this absolute path —
is written before that.

The environment variable `XDG_DATA_HOME` overrides `~/.local/share` when set,
following the same rule the rest of this repo uses for XDG paths.

## `graph.json`

Written once by the author, before the run. Never edited by an agent.

```jsonc
{
  "version": 1,

  // Rendered as the panel's title. Falls back to <slug> when absent.
  "title": "Refactor the pricing resolver",

  // REQUIRED. Absolute path to the repo the workflow's agents work in.
  // Token attribution locates agent transcripts from this — see below.
  "repoRoot": "/Users/q/Projects/example",

  // Road order, top to bottom. A lane naming no node is still drawn.
  // A node whose lane is absent from this list is an error.
  "lanes": ["scout", "build", "verify"],

  "nodes": [
    {
      // REQUIRED. Unique. Must match /^[a-z][a-z0-9-]*\/\d{2}$/ — the same
      // `bucket/NN` shape autopilot uses, because `fleet.ts`'s label grammar,
      // `compareTaskOrder`, and the berth-plate width all assume it.
      "ref": "build/01",

      // REQUIRED. Must appear in `lanes`.
      "lane": "build",

      // REQUIRED, a string. Shown on the lanes panel, which gives it one line
      // of room — so keep it to one line. That is advice to the author, not a
      // validation rule: the loader checks the type and nothing more.
      "title": "Extract the resolver",

      // Optional, default []. Refs this node waits for. A ref not present in
      // `nodes` is dropped from the graph, exactly as the renderer already
      // does for a dangling task dependency — it is reported, not fatal.
      "dependsOn": ["scout/01"],

      // Optional, default []. Advisory only; nothing derives readiness from it.
      "blocks": ["verify/01"],

      // Optional, default false. Exactly one node may set it.
      "finalReview": false,
    },
  ],
}
```

**Validation rules.** Every violation is returned as data, never thrown, and
surfaces in `TreePayload.errors`. The list is exhaustive — a loader may not add
a rule of its own, and a shape not named here is accepted:

- the file is not valid JSON, or its root is not an object
- `version` is absent or is not the number `1`
- `title` present but not a string. It is the one optional top-level field:
  absent is fine and falls back to the directory's name, but a present value of
  the wrong type is an error like any other.
- `repoRoot` absent, not a string, empty, or not an absolute path
- `lanes` absent, not an array, empty, holding a non-string, or holding a
  duplicate
- `nodes` absent, not an array, or empty
- a node that is not an object
- a node missing `ref`, `lane`, or `title`, or holding a non-string in any of
  the three
- a `ref` not matching `/^[a-z][a-z0-9-]*\/\d{2}$/`, or repeating
- a `lane` not listed in `lanes`
- `dependsOn` or `blocks` present but not an array of strings
- `finalReview` present but not a boolean
- more than one node with `finalReview: true`

Nothing is coerced. A field of the wrong type is an error, never a cast — a
graph that silently reinterprets its author's mistake is how a panel comes to
show a shape nobody declared.

A file that fails validation yields **no nodes**, not partial ones. A partly
loaded graph would render as a run in progress, which is worse than an empty
panel carrying the error.

**A dangling `dependsOn` ref is removed from the array and reported.** It is not
a whole-file failure — the rest of the graph is well-formed and worth drawing —
but it must not survive into the node's `dependsOn`, because the readiness rule
counts a ref it cannot resolve as unmet, which would leave the node blocked
forever on a dependency that does not exist. Removing it makes the layout and
the readiness rule agree on the same graph. Reporting it means the mistake is
still visible.

## `.flightlog/run.jsonl`

Append-only JSONL, one entry per line, written by tool-capable agents over
Bash. The schema is `flightplan/scripts/lib/flightlog.ts` — the same file
autopilot uses. Two kinds exist today:

```ts
export type ScoreEntry = {
  kind: "score";
  ts: string; // ISO timestamp
  task: string; // node ref, e.g. "build/01"
  attempt: number; // 1-based
  agentLabel?: string;
  weighted: number;
  passed: boolean;
  hardFailed: boolean;
  missing: string[];
  threshold: number;
  passOp: ">" | ">=";
  breakdown: { name: string; weight: number; score: number }[];
  rationale?: string;
};

export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  role: string; // free-form: dev / verify / judge / …
  attempt?: number;
  agentLabel?: string;
  phase?: "start" | "end"; // absent means "end", for back-compat
  message: string;
};
```

### The new kind

```ts
export type StateEntry = {
  kind: "state";
  ts: string;
  /** Node ref. A ref absent from graph.json yields a payload error and marks nothing. */
  task: string;
  /** The declared state. Any other value makes the node read `invalid`. */
  state: "done" | "blocked" | "failed";
  agentLabel?: string;
  /** One line of why. Required for `blocked` and `failed`. */
  message?: string;
};

export type FlightlogEntry = ScoreEntry | NoteEntry | StateEntry;
```

`parseLines` currently keeps a line only when `kind` is `"score"` or `"note"`
and silently drops everything else. It gains `"state"`. That asymmetry is the
back-compat guarantee in both directions: a new trail read by an old flightdeck
loses its state lines and degrades to the note-derived picture, and a future
fourth kind read by this one does the same. Neither throws.

Nothing else in `flightlog.ts` may change meaning. In particular `renderRunlog`
groups by `task` and drops `phase: "start"` notes — a `state` entry must not
break that grouping.

### Writing an entry

Agents call the existing CLI. `state` gains a subcommand alongside `log`:

```bash
bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" --phase start

bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" \
  --phase end --message "<what happened>"

bun <flightplan-scripts>/flightlog.ts state <logfile> \
  --task <ref> --state done --agent "<label>"
```

Appends are plain POSIX `appendFile`, unlocked. Concurrent agents are safe
because each line is written in one call. **Nothing may rewrite the file while a
run is in flight**, and no agent may ever edit `graph.json` — a JSONL append is
concurrency-safe, a JSON rewrite is not.

### Re-running the same workflow

The append-only rule governs a run, not the file forever. A workflow keeps one
fixed slug, so a second run would otherwise append to the first run's trail and
inherit its `state` declarations — every node the previous run finished would
read `done` before the new run had touched it, which is the most misleading
thing this panel can show.

So a re-run starts from a clean trail, and the transition happens **before the
run begins, by the author, never by an agent**:

1. Confirm the previous run has stopped. Appending beside a live run interleaves
   two runs into one unreadable trail.
2. Ask the user before touching the existing trail. It is the only record of
   what happened.
3. On approval, move `run.jsonl` aside — `run.jsonl.<ISO timestamp>` beside it
   is enough — or delete it. Either way the run starts with no trail, and
   `readLog` treats an absent file as an empty one.
4. Leave `graph.json` alone unless the graph itself changed.
5. Write a fresh `run.id` beside it, and interpolate that value into every
   prompt the script builds. See below for why.

Nothing inside the run ever does this. Once the first agent starts, the file is
append-only again until the run ends.

**Clearing the trail is not enough on its own.** Attribution decides a
transcript belongs to this run by finding the run directory's absolute path in
its first message — and that path is identical across runs, because the slug is
fixed. So a second run would count the first run's agents in its totals and
against its nodes, with a clean trail and no symptom. This is not the unproven
end-to-end gap; it is a defect two fixture transcripts can demonstrate.

### The run id

Each run carries an identifier, and membership requires it. A one-line file
`run.id` sits beside `graph.json`, holding an opaque token — an ISO timestamp is
fine, so is a nonce; only uniqueness across runs matters.

The author writes it as step 5 of the reset above, and interpolates the **same**
value into every prompt the script builds. A transcript belongs to this run only
when its first message carries the current run id. A previous run's transcripts
carry the previous id and are excluded, deterministically.

An elapsed-time window was the obvious alternative and does not work: a run
that fails and is immediately re-run puts both runs inside any window wide
enough to absorb the skew between an agent being spawned and its announce
landing. Nothing forces a minimum gap between runs, so no window can separate
them. Identity can.

A missing `run.id` under the graph source means no run has been started, so
nothing is attributed. The task-file source is never subject to this check at
all and keeps attributing exactly as it does today.

Those are two different rules for two different sources, and telling them apart
by whether a file happens to exist is exactly the mistake that makes one of them
silently swallow the other.

### Which source produced this — say it, do not infer it

The payload carries the answer explicitly:

```ts
/**
 * Added to TreePayload, and to the events handler's options.
 *
 * Named `deckSource`, not `source`: the events handler's options already carry
 * a `source` for injecting a TranscriptSource in tests, and reusing that name
 * fails the typecheck rather than merely reading badly.
 */
deckSource: "tasks" | "graph";
```

Detection runs once, when the directory is first read. Everything downstream
reads this field and never re-derives it from a file's presence. Three
behaviours depend on it, and each is wrong under the other source:

|                         | `"tasks"`                              | `"graph"`                                      |
| ----------------------- | -------------------------------------- | ---------------------------------------------- |
| Bucket list             | sorted; directory order is meaningless | declared order, verbatim                       |
| Empty lane              | not drawn as a road                    | drawn as a road                                |
| Run-id membership check | never applies                          | applies; a missing `run.id` attributes nothing |

The empty-lane row is the one that looks harmless and is not. A task tree can
hold a bucket directory with no task files in it, so feeding its bucket list to
the panel as declared lanes would grow roads on autopilot runs that never had
them, and change the panel's height with it.

## The narrow node type

`deriveTaskViews` currently takes `Record<string, ParsedTask>` — a rich
markdown-derived shape carrying `rubric`, `sections`, `body`, and
`requiredReading` that it never reads. It is narrowed to exactly what it uses,
and both loaders produce that:

```ts
export type NodeValidity =
  | { kind: "complete" }
  | { kind: "unfinished"; status: string | null }
  | { kind: "invalid"; rule: string; reason: string };

export type GraphNode = {
  ref: string;
  bucket: string; // the lane
  nn: string; // zero-padded, kept as a string
  title: string;
  status: string | null; // raw declared status; null when none
  dependsOn: string[];
  blocks: string[];
  finalReview: boolean;
  /** Whether this node counts as complete for a dependent. */
  validity: NodeValidity;
};
```

`NodeValidity` mirrors `taskValidity`'s existing return shape exactly, so the
task-file loader produces it by calling what it already calls.

`bucket` keeps its name rather than becoming `lane`: it is what
`TaskView.bucket`, `TreePayload.buckets`, `lanes.js`, and `graph.js` already
read, and renaming it would reach into the frontend, which is out of scope.

## Node state resolution

The contract's only real logic. Every consumer resolves a node's `TaskState`
(`"done" | "in-progress" | "ready" | "blocked" | "invalid"`) in this order:

1. The **latest `state` entry** for the node wins. `done` → `done`;
   `blocked` → `blocked`; `failed` → `invalid`.
2. Otherwise an **unclosed `start` note** reads `in-progress`. Counting is by
   `(task, role, attempt)` identity, and by count rather than presence — one
   `end` cancels exactly one `start`, because parallel agents can share an
   identity.
3. Otherwise a node with any **incomplete dependency** reads `blocked`. A
   dependency is complete only when rule 1 resolved it to `done`.
4. Otherwise `ready`.
5. A node whose latest `state` entry carries a value outside the known set reads
   `invalid`.

An event naming a `task` that is **not a node in the graph** is a different
case, and must not be confused with rule 5. There is no node to mark, so no
state changes; the event is reported as an error instead. Both guards then hold
at once: `counts.invalid` covers declared nodes in a bad state, and a non-empty
`TreePayload.errors` covers events that name nothing — and the dashboard already
refuses to read a payload carrying errors as a clean run.

**That membership check spans all three kinds, not just `state`.** A misspelled
ref on a `note` or a `score` loses that agent's row and its verdict just as
silently as a misspelled `state` does, and a trail full of typos would otherwise
render as a run where nothing ever happened. Check every parsed entry's `task`
against the declared nodes once, report one error per unknown ref, and only then
apply the state mapping — which still concerns `state` entries alone.

`invalid` is counted separately in `TreePayload.counts` so the dashboard can
never present the run as complete while one exists. That is the guarantee
autopilot's tree already makes, and this path must make it too.

The autopilot path keeps its own rule unchanged: the task file's `Status:`
plus `taskValidity` outrank everything, with an open `start` note promoting a
`todo` file to `in-progress`.

## Token attribution — the prompt-text conventions

Attribution does **not** join on the event trail. It joins on prompt text, and a
workflow that ignores these conventions still renders — its token figures just
read `N/A`. Three facts, all in
`packages/dispatch/skills/autopilot/scripts/usage-source.ts`:

1. **Membership.** `decideMembership` reads an agent transcript's _first_
   message and requires it to contain the run directory's absolute path,
   matched at segment boundaries. Every prompt must therefore mention
   `~/.local/share/q-lab/flightdeck/<slug>` — which it does for free, because
   the announce command's log path is inside it.

   Under this contract membership also requires **this run's id**, for the
   reason given under "The run id" above: the directory path alone cannot tell
   two runs of the same workflow apart. So every prompt carries the run id too,
   and it is the author's job to put it there. This second requirement applies
   to the graph source only — the task-file source has no run id and is
   unaffected.

2. **The join key.** `parseAgentPrompt` regexes that same first message for
   `--task (\S+) --role (\S+)`, plus `--attempt (\d+)`. The identity it builds,
   `` `${task}|${role}|${attempt ?? "-"}` ``, is computed independently from the
   trail side and the transcript side and then paired by nearest start time.
   So the announce command in the prompt and the entry it writes must carry the
   **same** `--task`, `--role`, and `--attempt` values.

3. **The transcript location.** `createTranscriptSource` maps a repo root to
   `~/.claude/projects/<slug>/<session>/subagents/workflows/wf_*/agent-*.jsonl`.
   It finds that root today by walking up from the plan directory for `.git`.
   Under this contract the run directory is in XDG, outside any repo, so the
   walk finds nothing — which is why `graph.json` declares `repoRoot` and the
   loader passes it through instead.

## Workflow script constraints

Not negotiable, and the reason the contract is shaped this way at all:

- A Workflow script has **no filesystem access**. It cannot write `graph.json`
  and cannot append an event.
- It **cannot import** anything, from this repo or elsewhere.
- Its entire vocabulary is `agent`, `phase`, `parallel`, `pipeline`, and
  `meta`.
- Therefore: the graph is declared by the author before the run, and every
  event is written by a spawned agent that was told, in its prompt, the exact
  absolute command to run.
