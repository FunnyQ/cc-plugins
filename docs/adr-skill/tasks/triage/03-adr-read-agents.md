# TRIAGE-03: Write the orchestrator and the two read-only agents

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: foundation/03, foundation/04, triage/01
> **Blocks**: triage/04, triage/05
> **Status**: todo

## Goal

The orchestration contract plus every agent that runs before the first confirmation gate — collection and judgment, both read-only.

## Files to create / modify

- `packages/chronicle/agents/lorekeeper.md` (new) — orchestrator, one phase per invocation
- `packages/chronicle/agents/gleaner.md` (new) — read-only collection
- `packages/chronicle/agents/reckoner.md` (new) — clustering, disposition, archive planning

## Implementation notes

Match the frontmatter shape the existing chronicle agents already use: `name`, `description`, `model`, `effort`, `tools`. Read `packages/chronicle/agents/watcher.md`, `skald.md`, and `storykeeper.md` for the prose voice — terse, imperative, second person, with the refusals stated up front rather than buried.

### Frontmatter values

| Agent | model | effort | tools | Role |
|---|---|---|---|---|
| `lorekeeper` | sonnet | medium | `["Agent", "Read"]` | Runs one phase per invocation, spawning that phase's children and keeping their output inside its own subtree. Owns no confirmation gate. |
| `gleaner` | haiku | low | `["Bash", "Read"]` | Runs the trail collector and the record index reader; returns the payload path, counts, and the index. Read-only. |
| `reckoner` | sonnet | high | `["Bash", "Read"]` | Clusters the skeleton payload by decision, pulls bodies for the shortlist only, dispositions, and produces the archive plan. Writes nothing to the trail. |

The `description` field follows the house pattern: what the agent does, then who spawns it, then what it refuses. For example, `"Chronicle's ADR gleaner. Runs the trail collector and returns the skeleton payload path plus counts. Spawned by chronicle:lorekeeper — read-only, never opens entry bodies."`

### The tools list is a contract, not a sandbox — say so

Both read agents hold `Bash`, and `Bash` creates, moves, and deletes files whether or not `Write` appears in the tools list. So "these agents cannot mutate anything" is false as stated, and writing it as though the frontmatter enforced it would be worse than not claiming it — a reader would stop looking for the real guarantee.

Two things are actually true, and both belong in the files:

1. **The enforceable guarantee lives in the scripts.** The trail collector and the ADR index reader have no write path at all; neither exports a function that creates, moves, or deletes anything. The archiver refuses to move a byte without `--apply` and an approved plan. A misbehaving agent that runs those scripts still cannot mutate the trail, because the scripts will not do it.
2. **The tools list states intent, and intent is what makes a violation legible.** Only one agent in the whole set carries `Write`, and it is not one of these.

So give each of these agents an explicit prohibition in its own file rather than letting the tools list imply one:

- `gleaner` runs the trail collector and the record index reader, and nothing else. No redirection, no `mv`, no `mkdir`, no `--apply` on anything. Both scripts are read-only by construction.
- `reckoner` runs the collector's body fetch and the archive **planner** (`archive-plan.ts`), and nothing else. It never runs the applier. The planner has no execution path in it at all, so this is structural rather than a promise — but state it anyway, because the agent should know which of the two scripts is its own.
- `lorekeeper` has no `Bash` by design. Never conclude from that absence that the flow is blocked, and never punt a phase upward half-finished.

Each file says plainly that applying an archive plan belongs to the writing agent alone, and that reaching for it here is a bug **even when it would produce the right outcome** — because it would be acting before the human gate that authorizes it.

### Never write the scoped tools form

Write `tools: ["Agent", "Read"]`. **Never** write `tools: ["Agent(chronicle:gleaner)"]`.

The scoped form is only recognized when an agent runs as the main thread. Inside a subagent definition it silently grants nothing, leaving the orchestrator holding `Read` alone and unable to spawn anything. There is no error message and no warning — the flow simply stalls at run time, and the failure looks like an unresponsive agent rather than a permissions problem. This has already cost this repository a debugging session on three other orchestrators.

### The confirmation gates do not live in any agent file

Two gates exist in this flow: one confirming the dispositions, one confirming the ADR draft. **Both sit in the skill's own instructions, in the main agent** — matching how the release flow gates before spawning its orchestrator, and using `cockpit wait` rather than `AskUserQuestion`.

State this explicitly in `lorekeeper.md`: it never asks the user anything. It returns to the main agent between phases so the gate can happen there. An orchestrator that tries to prompt from inside a subagent is unverified behaviour and must not be written in.

### Section shape every file follows

After the frontmatter:

1. A one-line statement of what it does, followed immediately by what it does **not** do.
2. `## Input (from the prompt)` — what the caller supplies. The caller passes **absolute script paths**; the agent never guesses a repo-relative path. Existing chronicle agents resolve these from the skill's load-time "Base directory for this skill" banner, and these must say the same.
3. `## Process` — numbered steps.
4. `## Output` — the exact shape returned, as a JSON block.

### lorekeeper: spawned once per phase, not once per run

A subagent invocation ends the moment it returns. So "spawn the children in order" and "return to the main agent between phases so the gate can happen there" cannot both describe one invocation — the first return would end the run, and the flow would stop dead after the first gate. Write it as **three separate invocations**, each self-contained, with the state passed back in explicitly:

| Phase | lorekeeper spawns | Returns to the main agent |
|---|---|---|
| `collect` | `gleaner`, then `reckoner` | the candidate list, the conflicts, the `assignments` array, and the path to the serialized archive plan |
| `draft` | the drafting agent | the draft text and the proposed target path |
| `commit` | the writing agent | what was written, what was archived, and what was refused |

Gate 1 sits between `collect` and `draft`; gate 2 between `draft` and `commit`. The main agent holds both, and it holds the state across them — lorekeeper carries nothing between invocations and must not assume it did.

Say explicitly what each phase requires as input, because a phase spawned without its carry-over cannot recover it: `draft` needs the confirmed candidate ids; `commit` needs the approved draft, its target path, and the approved archive plan path. A phase that arrives without them **stops and reports what is missing** — it does not re-run the previous phase to reconstruct them, because re-running collection after a human approved a specific candidate list would silently substitute a different one.

`lorekeeper.md` describes all three phases even though this task only writes two of the three child agents. The orchestration contract is one document; the agents it names are written elsewhere.

### gleaner

Receives absolute paths to **two** scripts — the trail collector and the record index reader — plus an optional flag to include the archived-done bucket. Runs the collector **first**, then the index reader, then returns the payload path, the session count, the skeleton count, whether a trail exists at all, and the record index.

The order is forced, and so is the field that connects the two. The index reader takes its directory as an argument and resolves nothing on its own; resolving `docs/adr` is the caller's job. So `gleaner` reads `adrDir` from the **collector's stdout summary** and passes it to the index reader. State that chain explicitly in the file, because the alternatives are both wrong: opening the payload to find `adrDir` violates this agent's own read bound, and deriving `docs/adr` from cwd or the trail root reproduces the nested-trail trap — a wrong directory reports no existing records, so duplicate detection finds nothing and numbering restarts at `0001`, all of which looks exactly like a repository with no ADRs yet.

The index belongs here rather than in the judging agent, and the reason is the phase boundary: `collect` is the read-only phase, and reading the record directory is collection. The judge needs the index to spot duplicates and to name the record a candidate matches, but it should receive it, not fetch it — one agent that gathers, one that decides, matching the split the rest of chronicle already draws. The index is small enough to pass inline; only the trail payload needs a file. It never opens the payload's entry bodies: a single `reason` field runs to roughly 400 words and there are hundreds of them, so reading the payload would defeat the two-pass design the collector exists to serve. When no trail exists it returns `{ "hasTrail": false }` and stops rather than erroring.

Return shape:

```json
{ "hasTrail": true, "payloadPath": "/tmp/...", "sessionCount": 63, "skeletonCount": 352,
  "adrIndex": { "dir": "...", "exists": true, "adrs": [], "nextNumber": 1,
                "brokenLinks": [], "skipped": [] } }
```

### reckoner

Receives the payload path plus the ADR index. Clusters **by decision, not by session**: one decision discussed across four sessions is one candidate, not four. Applies the promotion threshold in full.

Its work runs in **two phases, and the split is load-bearing.** Skeletons carry `id`, `sessionId`, `kind`, `decision`, `timestamp`, and `files` — enough to see that several entries are about the same decision, and nothing more. But one of the two mandatory threshold signals is *"the rejected alternatives and tradeoffs are not recoverable from the code alone"*, and those live in the `reason` and `tradeoff` fields the collector deliberately strips. Judging the threshold from skeletons alone would mean guessing at exactly the evidence the threshold asks about. The same goes for spotting genuinely conflicting entries: two titles can look compatible and argue opposite conclusions.

So: cluster from skeletons, shortlist the clusters that plausibly clear the bar, then run the trail collector's body fetch for **those candidate ids only**, and disposition against the full text. This is what two-pass loading was for — it bounds the bodies loaded to the shortlist rather than to all 352 entries, which is a different thing from never loading any. State the bound in the agent file: if the shortlist is large enough that its bodies would not fit, narrow it and say so in the output rather than judging blind.

The threshold, in full. Require at least one of:

- Reversing the decision would need a migration or coordinated changes.
- The rejected alternatives and tradeoffs are not recoverable from the code alone.

Plus at least one of:

- The decision remains relevant across sessions or releases.
- The decision affects multiple modules, plugins, or future contributors.
- A reasonable maintainer may challenge or accidentally undo it later.

Every candidate gets a disposition (`promote`, `watch`, or `skip`) and a written reason. A candidate that matches an existing ADR is `skip`, naming that ADR. Conflicting evidence is surfaced for the user's judgment, never resolved by silently taking the newest entry. Reject promotion when the material is a local implementation detail, a temporary workaround, a mechanical convention, or a caveat that belongs in code or operational documentation.

Return shape:

```json
{
  "candidates": [
    { "title": "...", "disposition": "promote", "reason": "...",
      "entryIds": ["..."], "sessionIds": ["..."], "matchesAdr": null }
  ],
  "conflicts": [{ "summary": "...", "entryIds": ["...", "..."] }],
  "assignments": [{ "sessionId": "...", "target": "watch", "from": "inbox", "why": "..." }],
  "planPath": "/tmp/chronicle/adr/plan-1754438400000-51234.json"
}
```

#### Folding per-candidate dispositions into per-session assignments

Judgment is per candidate; archiving moves whole session files. A single session routinely feeds several candidates, and they will not agree — one entry lands in a `promote` cluster while another lands in a `watch` one. Without a stated rule the target is whatever the agent happened to write last, which is not a design.

The rule: **`watch` wins.** A session goes to the watched bucket if *any* candidate drawn from it is dispositioned `watch`; otherwise it goes to `done`. The asymmetry is deliberate and follows from what each bucket costs when it is wrong. A session wrongly sent to `done` is gone from triage forever, taking its unsettled evidence with it. A session wrongly sent to `watch` costs one extra look the next time matching evidence arrives. Only one of those is recoverable.

Three consequences to state in the agent file. A `promote` and a `skip` in the same session both resolve to `done`, so the `why` should name the promoted candidate when there is one. A session that fed no candidate at all still gets a row, targeting `done`, because triaging a session means dispositioning everything in it and entries not promoted are implicitly skipped. And every row carries `from` — `"inbox"` for a fresh session, `"watch"` for one the wake condition pulled back — because a woken session that is now settled has to move out of the watched bucket, and the archiver will not infer that.

#### It produces the archive plan, before the gate

After emitting `assignments`, `reckoner` runs `archive-plan.ts --assignments <its own output>` and returns the resulting plan path alongside the candidates. That script is the planner half of the archive flow; the applier is a different file, and this agent never touches it.

This has to happen *before* the first gate. The archiver refuses `--apply` without an approved plan and refuses to recompute one from raw assignments, so a plan produced after approval would be an object no human ever saw. Planning touches nothing under `.cockpit/` — it stats files and writes JSON to a temp path — so it stays inside reckoner's read-only remit.

The plan path then travels through both gates **unchanged**. The main agent holds it; the writing agent receives that exact path. Regenerating it at commit time would defeat the approval, and the archiver's re-stat at apply time is what covers the staleness the delay introduces.

## Acceptance criteria

- [ ] All three files exist at the paths listed above.
- [ ] Each carries `name` / `description` / `model` / `effort` / `tools` frontmatter matching the table.
- [ ] No file uses the scoped `Agent(...)` tools form, and none lists `Write`.
- [ ] `gleaner.md` and `reckoner.md` each state explicitly what they may run and forbid applying an archive plan — the tools list is documented as intent, not as a sandbox.
- [ ] `gleaner.md` runs the collector before the index reader and states that it takes `adrDir` from the collector's stdout summary and passes it to the index reader — never deriving the directory itself, never opening the payload to find it.
- [ ] `lorekeeper.md` states that it holds no confirmation gate and asks the user nothing, and defines all three phase invocations — `collect`, `draft`, `commit` — with the exact carry-over each requires and the rule that a phase missing its input stops and reports rather than re-running the previous one.
- [ ] `reckoner.md` reproduces the promotion threshold in full, specifies the cluster-then-fetch-bodies-for-the-shortlist order with the reason the threshold cannot be judged from skeletons, and emits an `assignments` array folded by the `watch`-wins rule, including a row for a session that fed no candidate and a `from` field naming each session's current bucket so a woken watched session can be settled into `done`.
- [ ] `reckoner.md` runs `archive-plan.ts` before the first gate and returns the plan path, and names the applier as a script it never runs.
- [ ] Every file names who spawns it and states that it expects absolute script paths from its caller.

## Verification

- [ ] `grep -L 'model:' packages/chronicle/agents/{lorekeeper,gleaner,reckoner}.md` prints nothing — every file has frontmatter.
- [ ] `grep -n 'Agent(' packages/chronicle/agents/{lorekeeper,gleaner,reckoner}.md` returns nothing, or only prose that is not a `tools` entry.
- [ ] `grep -l '"Write"' packages/chronicle/agents/{lorekeeper,gleaner,reckoner}.md` prints nothing.
- [ ] `grep -c 'apply' packages/chronicle/agents/reckoner.md` is at least 1, and reading those hits confirms every one is a prohibition.
- [ ] `git status --short -- packages/chronicle/agents/lorekeeper.md packages/chronicle/agents/gleaner.md packages/chronicle/agents/reckoner.md` shows all three paths dirty.

**Do not verify these roles by starting a session and looking for them in the agent list.** A session loads chronicle's agents from the version-pinned plugin cache — `~/.claude/plugins/cache/<marketplace>/chronicle/<version>/agents/` — which is populated from a git clone tracking `main`. A file in this working tree is invisible to every session, fresh or not, until it is committed, pushed, and the plugin reinstalled. Committing is the runner's job and releasing is out of scope for this whole tree, so that check cannot pass here no matter how correct the files are. The greps above are the real gate; live resolution is confirmed once, after release.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

This task ships no unit tests, so read "Test coverage" as **instruction coverage**: does each file state its failure and refusal behaviour, not just its happy path?

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4 (pass) | 5 |
|---|---|---|---|---|---|
| Correctness | ×3 | A scoped `Agent(...)` tools entry, a `Write` on any of these three, a gate written into an agent file, or an orchestrator that runs all phases in one invocation. | The topology is right but a contract is vague — the phase carry-over is unstated, or the plan is produced after the gate. | Frontmatter matches the table; three phases with explicit carry-over; the threshold and the folding rule reproduced exactly; the plan produced before the gate. | Also anticipates a failure the spec did not name — an empty shortlist, a payload larger than the shortlist bound. |
| Test coverage | ×2 | No refusals stated anywhere. | Refusals stated for one agent, implied for the others. | Every agent states what it may run, what it refuses, and what it does when its input is missing. | The refusals read as decidable checks rather than as advice. |
| Interface & readability | ×1 | Return shapes absent or inconsistent between files. | Shapes present but fields drift between the emitter and the consumer. | Each file carries an `## Output` JSON block, and the fields line up across the chain. | A reader can trace one field end to end without opening a script. |
| Assumptions & docs | ×1 | The scoped-tools trap and the gate placement are unexplained, so a later editor undoes them. | Noted but not justified. | Both carry the reason they exist, in one sentence each. | The reasons are specific enough to survive a rewrite by someone who disagrees. |

## Out of scope

- The drafting and writing agents — Deferred. They run after the first gate and carry a different risk profile; a sibling task in this bucket owns them.
- The Codex `.toml` equivalents and their role registration — Deferred. Harness parity is its own task, and it depends on every agent file existing first.
- The skill's routing instructions and the two confirmation gates — Deferred. Those live in the skill file, written in the promote bucket.
- Implementing any of the scripts these agents call — Deferred. The script contracts already exist by the time this task runs.
