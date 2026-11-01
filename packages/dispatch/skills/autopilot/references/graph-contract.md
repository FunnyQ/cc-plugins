# Graph contract

## 1. Purpose and scope

Declare the graph **before** the run and write events **during** it: a Workflow script has no filesystem access and cannot import anything. This format lets a workflow author describe nodes, lanes, and dependencies for flightdeck, then let spawned agents report progress into a shared event trail. Its normative definition lives beside flightdeck's loader, in the autopilot references, because the reader owns the format it parses. Authoring skills reference this document instead of restating it, so writers and readers cannot acquire competing definitions.

Use the Workflow vocabulary `agent`, `phase`, `parallel`, `pipeline`, and `meta` to orchestrate the run. Give each spawned, tool-capable agent the exact absolute command to execute over Bash, because the script itself cannot create the graph or append events.

## 2. On-disk layout

Keep the graph and trail under one author-chosen workflow directory, so the reader can associate them without a filename pointer in either file:

```text
~/.local/share/q-lab/flightdeck/<slug>/
├── graph.json
├── run.id                # one line; a fresh identifier for each run
└── .flightlog/
    ├── .gitignore        # "*", created automatically on first append
    └── run.jsonl
```

When `XDG_DATA_HOME` is set, replace `~/.local/share` with its value, so the writer and reader use the same data directory. Choose a kebab-case `<slug>` and keep it fixed for the workflow, so subsequent runs use the same location. Do not use the Workflow tool's `wf_<runId>` as the slug: that identifier does not exist until the run starts, but the script must already contain the absolute directory path before it starts.

Before the first run, write `graph.json` and a one-line `run.id`, so both topology and attribution identity exist before agents start. Use an opaque identifier unique across runs, such as an ISO timestamp or nonce, so an immediate retry cannot inherit previous token totals. A missing `run.id` means no run has started and attributes no transcripts. For later runs, use the reset procedure in section 4 to avoid inheriting completed nodes.

The worked example uses slug `resolver-demo`, no XDG override, home directory `/Users/q`, and run identifier `2026-09-06T05:25:09.000Z`. Its absolute run directory is `/Users/q/.local/share/q-lab/flightdeck/resolver-demo`. These are illustrative values to replace with your own resolved paths and fresh identifier.

## 3. graph.json

Write the file once before the run, so the topology exists when the first event arrives. The annotated example is JSONC for explanation; remove the comments when saving `graph.json`, because the loader accepts JSON.

```jsonc
{
  // REQUIRED. The supported format version prevents misreading another schema.
  "version": 1,
  // OPTIONAL, default: directory name (the slug). Labels the panel.
  "title": "Extract the resolver",
  // REQUIRED. Absolute agent repository path; enables transcript discovery.
  "repoRoot": "/Users/q/Projects/example",
  // REQUIRED. Road order, top to bottom; preserves the author's layout.
  "lanes": ["scout", "build"],
  // REQUIRED. Declares all nodes before events can refer to them.
  "nodes": [
    {
      // REQUIRED. Unique node identity; prevents ambiguous event joins.
      "ref": "scout/01",
      // REQUIRED. A declared lane; prevents an unplaceable node.
      "lane": "scout",
      // REQUIRED. String displayed on the node; prevents a missing label.
      "title": "Inspect the resolver",
      // OPTIONAL, default: []. Dependencies determine readiness.
      "dependsOn": [],
      // OPTIONAL, default: []. Advisory only; never determines readiness.
      "blocks": ["build/01"],
      // OPTIONAL, default: false. At most one node may be the final review.
      "finalReview": false
    },
    { "ref": "build/01", "lane": "build", "title": "Extract the resolver", "dependsOn": ["scout/01"] },
    { "ref": "build/02", "lane": "build", "title": "Review the result", "dependsOn": ["build/01"], "finalReview": true }
  ]
}
```

The annotations apply to every node. All five top-level fields except `title` are REQUIRED and have no default. Each node's `ref`, `lane`, and `title` are REQUIRED and have no default. Each node's `dependsOn` and `blocks` are OPTIONAL with default `[]`. Each node's `finalReview` is OPTIONAL with default `false`.

Use refs matching `/^[a-z][a-z0-9-]*\/\d{2}$/`, so label parsing, node ordering, and the fixed-width display agree on identity. The suffix is exactly two digits. The ref prefix does not have to equal `lane`; lane membership is checked separately, so the loader does not invent an extra naming constraint. Keep node titles to one line to fit the panel; this is display advice, not validation.

Lanes render in declared order, including lanes with no nodes, so intentionally empty roads remain visible. Use `dependsOn` to express waiting, because `blocks` is advisory and cannot make a node wait. Zero final-review nodes are allowed; “at most one” prevents competing final reviews without requiring one.

Every validation violation is returned as data, never thrown, and surfaces in `TreePayload.errors`. The following validation list is exhaustive; a loader may not add rules, and a shape not named here is accepted:

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

Nothing is coerced: a wrong type is an error, never a cast, because silently reinterpreting an author's mistake would display a graph nobody declared.

Failure handling has one deliberate asymmetry. A **malformed file is a broken contract and yields no nodes at all**: a partly loaded graph would look like a run in progress, which misleads worse than an empty panel carrying the error. A **dangling dependency is ordinary incompleteness** in an otherwise valid file: its `dependsOn` ref is **removed from that node's dependency array and reported**, while the rest loads. Leaving it in the array would block the node forever because readiness counts an unresolvable ref as unmet. Removing it makes layout and readiness describe the same graph; reporting it keeps the mistake visible. This removal rule concerns `dependsOn`, not advisory `blocks`.

## 4. The event trail

During a run, have tool-capable agents append one JSON object per line to `.flightlog/run.jsonl`, so each event remains independently readable. The three entry types and their union are reproduced exactly below. Fields without `?` are required; fields with `?` are optional. An absent note `phase` means `end`, so older notes still close work. For `blocked` or `failed` state entries, supply `message` despite its optional type marker, so the declaration explains why work cannot finish.

```ts
export type ScoreEntry = {
  kind: "score";
  /** ISO timestamp. */
  ts: string;
  /** Task ref, e.g. "ui/03". */
  task: string;
  /** Which retry attempt produced this verdict (1-based). */
  attempt: number;
  /** Label of the judge agent — links to the raw `agent-<id>.jsonl`. */
  agentLabel?: string;
  /** Weighted average on the rubric's scale. */
  weighted: number;
  passed: boolean;
  hardFailed: boolean;
  /** Dimensions whose veto fired, in rubric order. Absent when none fired, and on entries written before the field existed. */
  vetoedBy?: string[];
  /** Dimensions the rubric declared but the scores omitted. */
  missing: string[];
  threshold: number;
  passOp: ">" | ">=";
  breakdown: { name: string; weight: number; score: number }[];
  /**
   * The judge's prose justification for the scores. Optional because every
   * entry written before this field existed has none — an old trail stays
   * valid and re-renders identically.
   */
  rationale?: string;
};

export type NoteEntry = {
  kind: "note";
  ts: string;
  task: string;
  /** Pipeline role: dev / verify / judge / final-review (free-form). */
  role: string;
  attempt?: number;
  agentLabel?: string;
  /**
   * "start" marks the agent beginning its work. "end" (or an absent value) marks
   * completion. Absent is the completion case because every entry written before
   * this field existed has no `phase` — that keeps old trails valid without migration.
   */
  phase?: "start" | "end";
  message: string;
};

export type StateEntry = {
  kind: "state";
  ts: string;
  /** Node ref, in the declared graph's `<lane>/<NN>` shape. */
  task: string;
  state: "done" | "blocked" | "failed";
  agentLabel?: string;
  /** One line of why. Required for `blocked` and `failed`. */
  message?: string;
};

export type FlightlogEntry = ScoreEntry | NoteEntry | StateEntry;
```

Use these commands verbatim as templates. Replace `<flightplan-scripts>` with the absolute installed Dispatch directory `packages/dispatch/skills/flightplan/scripts` (or its installed equivalent), so agents can locate `flightlog.ts` from any working directory. Replace `<logfile>` with the absolute path to this run's `.flightlog/run.jsonl`, so parallel agents cannot split the trail across working directories. Replace the remaining placeholders with the node ref, role, attempt number, label, and message for that agent, so its events join the right node.

```bash
bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" --phase start

bun <flightplan-scripts>/flightlog.ts log <logfile> \
  --task <ref> --role <role> --attempt <n> --agent "<label>" \
  --phase end --message "<what happened>"

bun <flightplan-scripts>/flightlog.ts state <logfile> \
  --task <ref> --state done --agent "<label>"
```

For a blocked or failed declaration, change `--state done` to `--state blocked` or `--state failed` and add `--message "<why>"`, because the CLI rejects an unexplained non-success state. The CLI supplies `ts` and creates `.flightlog/.gitignore` with `*` on the first append, so authors need not manage timestamps or accidentally commit the trail.

The first matching trail lines for the graph above are:

```jsonl
{"kind":"note","ts":"2026-09-06T05:26:00.000Z","task":"scout/01","role":"dev","attempt":1,"agentLabel":"scout-agent","phase":"start","message":""}
{"kind":"note","ts":"2026-09-06T05:27:00.000Z","task":"scout/01","role":"dev","attempt":1,"agentLabel":"scout-agent","phase":"end","message":"Located the resolver."}
{"kind":"state","ts":"2026-09-06T05:27:01.000Z","task":"scout/01","state":"done","agentLabel":"scout-agent"}
```

Save these events under the same run directory as the graph. Their `task` fields join the declared `ref` values; neither file points to the other. After these lines, `scout/01` reads `done`, `build/01` reads `ready`, and `build/02` reads `blocked`. The end note alone would not complete the dependency; the explicit state declaration does.

The trail is append-only **within one run**. Nothing may rewrite it mid-run, because a rewrite can erase a concurrent append. No agent may ever edit `graph.json`, because a JSON rewrite is not concurrency-safe. Each trail line is written with one unlocked POSIX `appendFile` call; this JSONL append is concurrency-safe under parallel agents.

Before re-running the same workflow, the author performs this reset; no agent inside the run performs it:

1. Confirm the previous run has stopped, because two live runs would interleave their events.
2. Ask the user before touching the existing trail, because it is the only record of the previous run.
3. On approval, move `run.jsonl` aside to `run.jsonl.<ISO timestamp>` beside it, or delete it, so previous state declarations cannot mark new work done. An absent trail is read as empty.
4. Leave `graph.json` alone unless the graph itself changed, so a retry preserves the declared topology.
5. Write a fresh `run.id` beside the graph and interpolate that same value into every prompt the script builds, so previous transcripts cannot enter this run's totals.

Once the first agent starts, append-only applies again until the run ends. Clearing the trail alone cannot reset attribution because the directory path stays the same. A time window cannot separate immediate retries reliably, so identity must separate them.

An older reader silently drops `state` lines and renders the picture supported by the remaining score and note entries. This reader likewise drops a future unknown entry kind. Neither throws, so trails remain readable in both directions without migration. Blank or malformed JSONL lines are also skipped to preserve readable events after an interrupted write. Human-readable reports still group entries by `task` and omit start notes, so adding states does not break the existing grouping.

## 5. State resolution

Before mapping states, check every parsed entry's `task` against the declared nodes, including score and note entries. Report one error per unknown ref and change no node for those entries, because a typo must not silently erase an agent's activity. Payload errors prevent the dashboard from presenting the run as clean.

Resolve each node to `done`, `in-progress`, `ready`, `blocked`, or `invalid` in this exact five-step order:

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

Step 5 is the guard on an unknown latest declaration, not permission to keep the fallback `ready` from step 4. A later note cannot override a latest state declaration, so a declared failure cannot disappear behind apparent activity. Match starts and ends by `(task, role, attempt)` and count them, so one parallel agent finishing does not close another agent's start. Score verdicts do not declare completion; append a `state` entry to make dependent work ready.

A run is never presented as complete while any node reads `invalid`; invalid nodes are counted separately so this guarantee cannot be hidden by other completed nodes.

## 6. Token attribution

Attribution joins prompt text to transcripts, not events alone. Follow all three conventions below to avoid a rendered graph whose token figures are `N/A`.

1. **Membership uses the first message.** Put the expanded absolute run directory path and the current `run.id` value in every agent's initial prompt. Use the absolute log path in its announce command to supply the directory at a path-segment boundary, so a similarly named sibling directory cannot claim its tokens. Expand `~` and environment variables before building the prompt; shell expansion after the message is recorded cannot repair membership. Copy the same run identifier into every prompt, so transcripts from previous runs are excluded even though their directory path matches. The identifier is matched at its boundaries, not as a bare substring: the characters immediately around it must not be a letter, digit, `-`, or `_`. A previous run's `retry-10` therefore cannot feed its tokens to this run's `retry-1`. Surround the identifier with a space or ordinary punctuation, as the example prompt below does, and do not run it up against other identifier characters.
2. **The join key comes from that same first message.** Put `--task <ref> --role <role>` in that order, adjacent and separated by single spaces, in the announce command. Include `--attempt <n>` with a 1-based number. Use exactly the same task, role, and attempt values in the command the agent executes, so independently parsed transcript and trail identities match. The parser matches `--task (\S+) --role (\S+)` and `--attempt (\d+)`, then builds `` `${task}|${role}|${attempt ?? "-"}` `` and pairs matching identities by nearest start time. If an attempt is omitted, omit it on both sides to retain the same identity.
3. **Transcript discovery uses the repository, not the run directory.** Set `repoRoot` to the absolute repository path where the workflow's agents work. Transcripts are found under `~/.claude/projects/<slug>/<session>/subagents/workflows/wf_*/agent-*.jsonl`, where this `<slug>` is the repository's encoded transcript-directory name, not the author-chosen workflow slug. Supplying the repository root prevents discovery from walking up an XDG directory outside the repository and finding nothing.

For the worked example, put this text in the scout agent's initial prompt. The CLI location assumes a Dispatch checkout at `/Users/q/Projects/cc-plugins`; replace that illustrative location with your installed absolute path before use.

```text
Work in /Users/q/Projects/example.
This run's identifier is 2026-09-06T05:25:09.000Z.
Before starting work, execute:
bun /Users/q/Projects/cc-plugins/packages/dispatch/skills/flightplan/scripts/flightlog.ts log /Users/q/.local/share/q-lab/flightdeck/resolver-demo/.flightlog/run.jsonl --task scout/01 --role dev --attempt 1 --agent "scout-agent" --phase start
When finished, execute the same log command with --phase end --message "Located the resolver."
Then execute:
bun /Users/q/Projects/cc-plugins/packages/dispatch/skills/flightplan/scripts/flightlog.ts state /Users/q/.local/share/q-lab/flightdeck/resolver-demo/.flightlog/run.jsonl --task scout/01 --state done --agent "scout-agent"
```

Build each other agent's prompt with its own declared ref and matching role, attempt, and label, so attribution does not collapse all work onto the scout.

## 7. Conformance checklist

Before the first run, check these against your graph, run identifier, and prepared agent prompts:

- [ ] The run directory follows the XDG rule and uses a fixed kebab-case slug, so graph and trail meet at the same location.
- [ ] `graph.json` contains JSON without annotation comments and passes every validation rule in section 3, so malformed input cannot empty the panel.
- [ ] Every intended dependency names a declared node, so removal of dangling refs cannot change the intended readiness graph.
- [ ] `run.id` contains one fresh identifier and every initial prompt contains that exact value, so earlier runs cannot contribute tokens.
- [ ] Every initial prompt names the expanded absolute run log path and the correct absolute CLI path, so membership and writes use the same directory.
- [ ] Every announce command uses adjacent `--task` and `--role` flags with a declared ref and matching attempt values, so the prompt and emitted trail join.
- [ ] `repoRoot` and the working repository named in prompts agree, so transcript discovery looks in the right repository.
- [ ] Prepared prompts pair start/end notes and explicitly declare completion, so notes cannot leave work open or dependencies blocked after success.
- [ ] Prepared prompts contain only trail appends and no graph edits or trail rewrites, so parallel agents cannot overwrite each other's records.
