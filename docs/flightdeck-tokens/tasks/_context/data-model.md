# On-disk data model

Everything here was verified by hand on **2026-08-28**, Claude Code **2.1.250**,
against a real 48-agent autopilot run. None of it is documented by Anthropic — treat
every claim as an observation that could move in a future release, and say so in
comments where the code depends on it.

## Where the transcripts live

```
~/.claude/projects/<project-slug>/
    <sessionId>.jsonl                          # the main session — NOT useful here
    <sessionId>/
        subagents/
            agent-<id>.jsonl                   # plain Agent() subagents — NOT useful here
            workflows/
                wf_<runId>/
                    journal.jsonl              # started/result per agentId
                    agent-<id>.jsonl           # ← one per Workflow-spawned agent
                    agent-<id>.meta.json       # {"agentType":"workflow-subagent","spawnDepth":1,"model":"haiku"}
```

**Two traps, both silent.**

1. Workflow agents are under `subagents/workflows/wf_*/`, **not** directly under
   `subagents/`. Scanning only `subagents/agent-*.jsonl` returns zero files for a
   Workflow run and reads as "Workflow agents leave no transcript".
2. The main `<sessionId>.jsonl` carries an `isSidechain` field that is **always
   `false`**. Counting sidechain turns there always yields 0. Only the per-agent files
   carry `isSidechain: true`.

`journal.jsonl` and the `.meta.json` sidecars are **not needed** by this feature. The
journal holds only `{type, key, agentId}` and `{type, key, agentId, result}` — no
label, no usage. The sidecar's `model` is a coarse alias (`"haiku"`) while the
transcript carries the exact id (`"claude-haiku-4-5-20251001"`); prefer the transcript.

## The project-slug rule

The `<project-slug>` directory name is the session's absolute cwd with **every
non-alphanumeric character replaced by `-`**:

```ts
absPath.replace(/[^A-Za-z0-9]/g, "-")
```

Uppercase is preserved. Verified against real directory names:

| cwd | slug |
|---|---|
| `/Users/funnyq/Projects/q-lab/cc-plugins` | `-Users-funnyq-Projects-q-lab-cc-plugins` |
| `/Users/funnyq/.claude` | `-Users-funnyq--claude` |
| `/private/var/folders/vt/ldvzjls92l12pp4_s870ngr80000gn/T` | `-private-var-folders-vt-ldvzjls92l12pp4-s870ngr80000gn-T` |

Note the leading `-` (from the leading `/`) and the doubled `--` where a dot sat.

Autopilot's agents run with cwd set to the **repo root**, so derive the slug from the
repo root — walk up from the plan directory until a `.git` entry exists. If the
resulting `~/.claude/projects/<slug>/` does not exist, return no results. Do not fall
back to a fuzzy search across all project directories.

## The transcript line shape

One JSON object per line. The keys observed across a full run:

```
agentId, attachment, attributionAgent, attributionPlugin, attributionSkill, cwd,
effort, entrypoint, gitBranch, isMeta, isSidechain, key, message, parentUuid,
promptId, requestId, result, sessionId, slug, sourceToolAssistantUUID, timestamp,
toolEndsTurn, toolUseResult, type, userType, uuid, version
```

`type` is one of `user`, `assistant`, `attachment`, `started`, `result`. Only
`assistant` lines carry billed usage. Lines are not uniform — **a `started` or
`result` line has no `message` key at all**, so `line.message.usage` throws unless
guarded. This is the single most likely crash in a naive parser.

The first line of every file is the `user` line holding the orchestrator's opening
prompt:

```jsonc
{
  "type": "user",
  "agentId": "a12015bffe2b52b27",
  "cwd": "/Users/funnyq/Projects/q-lab/cc-plugins",
  "sessionId": "24a8e1d8-4f8d-4d6d-9946-a2bb34de3a43",
  "timestamp": "2026-08-01T09:32:03.528Z",
  "isSidechain": true,
  "version": "2.1.250",
  "message": { "role": "user", "content": "First, announce yourself: bun …" }
}
```

`message.content` is usually a string, but may be an array of content blocks. Handle
both — stringify the array before pattern-matching rather than assuming a shape.

An `assistant` line's usage:

```jsonc
{
  "type": "assistant",
  "requestId": "req_…",
  "attributionPlugin": "dispatch",
  "attributionSkill": "dispatch:autopilot",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "usage": {
      "input_tokens": 352,
      "cache_creation_input_tokens": 266889,
      "cache_read_input_tokens": 1620698,
      "output_tokens": 3465
    }
  }
}
```

`usage` may carry additional non-integer or nested keys in future versions — sum only
the four named counters and ignore anything else. `message.model` is absent on some
assistant lines; skip the model, keep the usage.

## Identifying which task an agent worked on

`agentLabel` from the flightlog **cannot** be used. Agents pick their own label. Real
labels from one run:

```
CODEX-reviewer          Haiku Scout             Haiku-4.5-Verifier
Haiku-verifier          Independent Verifier    altitude-reviewer
claude-haiku-scout      claude-haiku-4-5-wave-scout
dev-codex:lint/01#1     dev-codex:orchestrator/01#1
```

Structured and free-form labels coexist in the same run, so no parser recovers the
identity from them.

The **opening prompt** is the reliable source, in two shapes.

**Shape A — the announce line** (39 of 48 agents). Verbatim excerpt:

```
 log /Users/…/docs/autopilot-graph-v2/.flightlog/run.jsonl --task integration/01 --role review --attempt 1 --agent "<your label>" --phase start
```

Pattern: `--task <ref> --role <role>`, plus an optional `--attempt <n>`.
`--attempt` was present in 32 of those 39. `--agent "<your label>"` is a literal
placeholder the agent substitutes at runtime — the prompt never holds the real label.

**Shape B — the mark-done agent** (the remaining 9). Verbatim excerpt:

```
Finalize flightplan task orchestrator/04 at /Users/…/docs/autopilot-graph-v2/tasks/orchestrator/04-vendor-rung.md. Do this in three steps and report a verdict.
```

Pattern: `Finalize flightplan task <ref> at `. Treat its role as `mark-done` and leave
attempt undefined.

Together the two shapes reach 100% of agents in the reference run. An agent matching
neither has an unknown task and its usage still counts toward the plan total.

### Roles, and the agents that have no row

The flightlog of the reference run holds exactly six role values:

| role | note entries |
|---|---|
| `verify` | 18 |
| `judge` | 18 |
| `dev` | 16 |
| `scout` | 14 |
| `review` | 10 |
| `fix` | 2 |

These are the same strings the announce line's `--role` carries, so an agent's parsed
role and a fleet row's role compare directly as strings. No translation layer is needed
between them; adding one would be an abstraction with nothing to abstract.

**Shape-B agents write no flightlog entry at all.** `mark-done` does not appear in that
table because those agents run the done-transition script and never log a note. So they
have no fleet row, can never pair to one, and their tokens reach the display only
through the per-task and plan totals. That is correct behaviour, not a gap — an
implementation that tries to invent a row for them is wrong.

Separately, the fleet row's own role field is a closed enum whose members are
`scout`, `dev`, `verify`, `requalify`, `judge`, `review`, `fix`, `done`, `block`,
`commit`, and `unknown`. Every role that actually produces a row is a member, so a
plain string comparison is sound.

## Filtering to one plan

Both shapes embed the plan's **absolute directory path**. Discovery filters on that:
read each `agent-*.jsonl`'s first line only, stringify `message.content`, and keep the
file when it contains the plan directory path. A `wf_*` dir is relevant when at least
one of its agent files matches.

## Multiplicity — the join is N-to-M

Several agents can share one `(task, role, attempt)`:

| identity | agents | why |
|---|---|---|
| `integration/01` · `review` | 5 | the final-review lens fan-out, one agent per lens |
| `scout` · `scout` | 7 | one scout per wave, all logged under the same ref |

So a pairing between transcripts and fleet rows must be many-to-many aware. Both sides
carry a start timestamp — the flightlog's `start` note has `ts`, the transcript's first
line has `timestamp` — which is what makes nearest-start-time pairing possible.

## Measured reference numbers

From `wf_993ede2c-a44`, the run behind `docs/autopilot-graph-v2` (48 agents). Useful as
sanity anchors, not as test fixtures — the directory is a real artifact on one machine
and must never be read by a test.

| model | input | cache write | cache read | output |
|---|---|---|---|---|
| claude-haiku-4-5-20251001 | 9,580 | 4,587,664 | 48,782,428 | 154,516 |
| claude-opus-5 | 568 | 1,822,043 | 16,681,341 | 86,577 |
| claude-fable-5 | 196 | 774,150 | 6,753,441 | 37,053 |
| **total** | **10,344** | **7,183,857** | **72,217,210** | **278,146** |

The shape to notice: cache-read is roughly 260× output. Any UI that sums all four
counters into one figure is displaying cache-read with extra steps.

## What is not available

- **Codex and OpenCode agents leave no Claude transcript.** They run as subprocesses
  (`codex exec …`, `opencode run …`) and their usage lands in `~/.codex/` or
  OpenCode's own store. A fleet row for one of those must render as unavailable, never
  as zero.
- **No label, anywhere.** Neither the transcript, the sidecar, nor the journal records
  the Workflow `label` the orchestrator assigned.
