# WORK-01: Transcript Source

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/types.md`
>
> **Depends on**: none — foundation task
> **Blocks**: work/02
> **Status**: todo

## Goal

Find every Workflow-agent transcript belonging to a plan directory and turn it into `AgentUsage[]`, reading only the bytes appended since the last pass.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/usage-types.ts` (new) — the frozen type declarations, copied verbatim from `../_context/types.md`. This task is their sole owner.
- `packages/dispatch/skills/autopilot/scripts/usage-source.ts` (new) — discovery, incremental tail, and prompt parsing.
- `packages/dispatch/skills/autopilot/scripts/usage-source.test.ts` (new)
- `packages/dispatch/skills/autopilot/scripts/usage-fixture.ts` (new) — the fixture
  generator every later manual gate depends on. Described in `../_context/shared.md`;
  this task owns it because it is the only task that knows the on-disk line shapes. — tests for the above.
- `packages/dispatch/skills/autopilot/scripts/tail.ts` (modify) — lift `readRange` here and export it.
- `packages/dispatch/skills/autopilot/scripts/tail.test.ts` (modify) — cover the lifted `readRange`.
- `packages/dispatch/skills/autopilot/scripts/events-api.ts` (modify) — import the exported `readRange` and delete the local closure. This is the **only** change to that file in this task: do not touch its types, its frame construction, or its poll loop.

## Implementation notes

### `usage-types.ts` — types only, zero imports

Copy `TokenCounts`, `AgentUsage`, and `UsageRollup` verbatim from `../_context/types.md`, including their doc comments. No runtime code, no constants, no functions.

**Give this file no imports at all.** The contract permits importing from `./fleet`, but none of the three types need it, and the fleet module will shortly import `TokenCounts` from here. Zero imports keeps that edge one-directional instead of circular. Leave a one-line comment saying so, because the next reader will otherwise "fix" it by adding the import back.

### `readRange` lift

`readRange` is currently a closure inside the SSE handler in `events-api.ts` that captures the log path from its enclosing scope. Lifting it to `tail.ts` means turning that capture into a parameter:

```ts
/** Read a byte range out of a file. Returns fewer bytes than asked when the file shrank mid-read. */
export function readRange(path: string, from: number, size: number): Uint8Array
```

The body is the existing `openSync` / `readSync` / `closeSync` loop with the captured path replaced by the `path` parameter, and is otherwise unchanged: allocate `size - from` bytes, loop `readSync` until the buffer fills or a read returns `0`, close the descriptor in a `finally`, and return `bytes.subarray(0, offset)` so a short read yields a short result rather than a buffer padded with garbage.

`tail.ts` currently imports nothing. It will now need `closeSync`, `openSync`, and `readSync` from `node:fs`.

In `events-api.ts`, delete the local function, add `readRange` to the existing `import { nextCursor, splitCompleteLines } from "./tail";`, and change the single call site to pass the log path as the first argument. Then drop `closeSync`, `openSync`, and `readSync` from that file's `node:fs` import if nothing else there uses them — leaving unused imports is what a reviewer will catch.

### Pure helpers in `usage-source.ts`

All exported and individually testable, with no filesystem access inside any of them.

```ts
export function projectSlug(absPath: string): string
```

Claude Code names its per-project directory after the session's absolute cwd with every non-alphanumeric character replaced by `-`: `absPath.replace(/[^A-Za-z0-9]/g, "-")`. Uppercase survives. Two verified anchors to assert on:

| input | output |
|---|---|
| `/Users/funnyq/Projects/q-lab/cc-plugins` | `-Users-funnyq-Projects-q-lab-cc-plugins` |
| `/Users/funnyq/.claude` | `-Users-funnyq--claude` |

The leading `-` comes from the leading slash, and the doubled `--` in the second row comes from the dot. Both are load-bearing; a rule that trims or collapses dashes produces a directory name that does not exist.

```ts
export function repoRootOf(planDir: string): string | null
```

Walk up from `planDir` until a `.git` entry exists, and return that directory. Test for **existence, not directory-ness**: a git worktree's `.git` is a regular file, and a check that insists on a directory silently fails inside every worktree. Return `null` on reaching the filesystem root without a hit.

```ts
export function parseAgentPrompt(content: unknown): {
  task: string | null;
  role: string | null;
  attempt: number | undefined;
}
```

Accepts whatever sits at `message.content`, which is usually a string but may be an array of content blocks. Stringify anything that is not already a string before matching, rather than assuming a shape.

Two prompt shapes, both quoted verbatim in `../_context/data-model.md`. Match with:

- `/--task (\S+) --role (\S+)/` — the announce line the orchestrator prepends to most agents. Yields task and role.
- `/--attempt (\d+)/` — optional, on the same line. Roughly a fifth of prompts omit it; that is expected, not an error. Yields `attempt`, or `undefined` when absent.
- `/Finalize flightplan task (\S+) at /` — the mark-done agent. Yields the task ref, role `"mark-done"`, and `attempt` `undefined`.

Try the announce line first; fall through to the finalize pattern. Matching neither returns `{ task: null, role: null, attempt: undefined }` — an unrecognised agent, not a failure.

Do not attempt to recover the identity from any agent label. Agents choose their own labels and the real ones are free-form English (`Independent Verifier`, `altitude-reviewer`) mixed with structured ones in the same run, so no parser is reliable.

```ts
export function emptyCounts(): TokenCounts
export function addUsage(into: TokenCounts, raw: unknown): void
```

`addUsage` maps the four wire keys onto the repo's camelCase names and mutates `into` in place:

| wire key | field |
|---|---|
| `input_tokens` | `input` |
| `output_tokens` | `output` |
| `cache_read_input_tokens` | `cacheRead` |
| `cache_creation_input_tokens` | `cacheWrite` |

Add a value only when it is a finite integer. Ignore every other key in the object — future versions may add nested or non-numeric fields, and a blind `Object.values().reduce()` would either crash or invent tokens. A `raw` that is not an object is a no-op.

### `createTranscriptSource(planDir, projectsRoot?)`

The signature is frozen in `../_context/types.md`. Construction does no I/O; everything happens on `read()`.

`projectsRoot` defaults to `join(homedir(), ".claude", "projects")` and exists **solely as a test seam**. Production callers pass one argument. Every filesystem test in this task points it at a `mkdtempSync` directory, because no test may read or write the developer's real Claude Code state.

**Path resolution is cached. Existence is not.**

Resolve the repo root above `planDir`, slug it, and form `<projectsRoot>/<slug>/`. Autopilot's agents run with cwd set to the repo root, which is why the slug comes from the root and not from `planDir`. Those two derivations depend only on constructor arguments and immutable filesystem structure, so compute them once, lazily, on the first `read()` and cache them.

**Do not cache a negative existence verdict.** A missing repo root or a missing `<projectsRoot>/<slug>/` yields an empty result for *this* call only; the next `read()` must check again. Flightdeck is routinely opened before the run starts, so that directory frequently does not exist yet and is created moments later by the first Workflow agent. Caching "not there" would mean the token panel stays empty for the entire run and only works if the browser happened to open second — the exact opposite of the live behaviour this feature is for.

**Enumeration, on every `read()`.** New agents appear mid-run, so the directory listing cannot be cached either. Collect files matching:

```
<projects>/<slug>/*/subagents/workflows/wf_*/agent-*.jsonl
```

Skip `journal.jsonl` and every `.meta.json` sidecar — neither carries usage or a label, so opening them is wasted work. Note in a comment that agents live under `subagents/workflows/wf_*/` and **not** directly under `subagents/`; the latter holds plain subagent transcripts and returns zero files for a Workflow run, which reads as "Workflow agents leave no transcript" and is the trap this whole feature exists past.

**Per-file state**, held in a `Map` keyed by absolute path, for the life of the source object:

- byte cursor
- held partial line
- a dedicated `TextDecoder`
- accumulated `TokenCounts`
- models seen, in first-seen order, deduplicated
- the parsed `task` / `role` / `attempt`
- `startedAt`
- a membership state: `pending` / `included` / `excluded` (see below)

Give each file its **own** `TextDecoder` and reuse it across passes with `decode(bytes, { stream: true })`. A shared or per-call decoder splits a multi-byte character that straddles a chunk boundary into two replacement characters.

**Tailing.** Stat the file, call `nextCursor(cursor, size)` for the shrink decision, read only `[from, size)` through the newly exported `readRange`, decode, then `splitCompleteLines` to hold back the trailing partial. On `reset`, clear the cursor, the partial, the counts, the models, and the decoder state before re-reading from zero — a reset that keeps the old counts double-counts the whole file. Never re-parse a byte.

**Plan filtering, decided on the first parsed line only.** Both prompt shapes embed the plan's absolute directory path, so stringify that line's `message.content` and keep the file when it contains `planDir`. A file that fails the check is marked `excluded` and never opened again — that flag is what stops discovery from re-reading every unrelated transcript in the project on every pass. Also take `startedAt` from that line's `timestamp` and the parsed prompt fields at the same time.

**Usage accumulation.** Only `type === "assistant"` lines carry billed usage.

**Guard `message` being absent before touching it.** A `started` or `result` line has no `message` key at all, so `line.message.usage` throws a `TypeError` and kills the pass. This is the single most likely crash in a naive parser and the reason for a `typeof line.message === "object"` check rather than an optional chain bolted on after the first stack trace.

Take the model from `message.model` when present; it is absent on some assistant lines, in which case keep the usage and skip the model.

**Membership is three-state, not two.** Every enumerated file is `pending`, `included`, or `excluded`:

- `pending` — the file has been seen but its first *complete* line has not been read yet. A brand-new transcript is often zero bytes, or holds a partial line the tail is still holding back. Nothing is known about which plan it belongs to.
- `included` — its first complete line's prompt names `planDir`.
- `excluded` — its first complete line's prompt does not. Permanent; never reopened.

**Return one `AgentUsage` per `included` file only.** A `pending` file is omitted from the result entirely, and is re-checked next pass. Returning it would put an unrelated transcript — possibly another repo's, since the whole project slug is enumerated — into `agentCount` and the plan totals for as long as it stayed empty. The contract is that the reader returns transcripts that name this plan, and a file that has not yet said so has not said so.

`file` is the absolute path.

**Every failure is non-fatal, never a throw.** A missing projects directory, a vanished file, a malformed JSON line, an empty file, or no repo root all degrade to less data. A run whose transcripts are gone must show no tokens, not a broken dashboard. A file that exists but cannot be read is the one case that does *not* reduce the result — see the rule immediately below.

**Vanished and unreadable are different, and the difference is the plan total.**

- **The file is gone** — it no longer appears in the enumeration. Delete its per-file state and omit it from the result. Its tokens leave the totals. Claude Code really does delete transcripts on its own retention schedule, so this is a normal event, not a corruption. Keeping a ghost entry alive would make the dashboard report tokens that nothing on disk can account for, and the closing review checks the header against a fresh sum of what is on disk — a retained ghost turns a correct feature into a failing check.
- **The file exists but a read throws** — a lock, a permission blip, a partial write. Keep its last-known state, return it unchanged, and try again next pass. Do not zero it and do not drop it: a transient error is not evidence the work did not happen, and flapping the total on every hiccup is worse than being one pass stale.

The distinction is `existsSync`, checked before the read, not inferred from the error.

### The fixture generator

A standalone CLI, `bun usage-fixture.ts [--out <dir>]`, defaulting `--out` to a fresh
`mkdtempSync` directory. Its contract and output shape are in `../_context/shared.md`;
build exactly that. What matters beyond the shape:

- **Write a `.git` marker inside the fixture root.** The repo-root walk is what produces
  the slug, and a temp directory has no repository above it. Without the marker the
  generated scenario resolves to nothing and the fixture silently produces zero — the
  exact failure it exists to prevent.
- **Derive the slug at generation time** with the same helper the source uses, so the
  synthetic projects tree is named correctly on any machine. Do not commit a
  pre-computed slug; the real ones embed an absolute home directory.
- **Include a row with no transcript.** Write three agent lifecycle note pairs into the
  fixture's `run.jsonl` but only two matching transcripts. That third row is the only
  way any later gate can prove unavailable renders differently from zero.
- **Use round numbers** — hundreds and thousands, not the measured figures — so a reader
  can check the declared `expected` totals by eye.
- Print the JSON object and nothing else on stdout, so a caller can pipe it.

This is a development tool, not shipped behaviour: it takes no part in serving a
dashboard and nothing in the runtime imports it.

## Acceptance criteria

- [ ] `usage-types.ts` declares `TokenCounts`, `AgentUsage`, and `UsageRollup` exactly as frozen in `../_context/types.md`, with no imports and no runtime code.
- [ ] `readRange(path, from, size)` is exported from `tail.ts`, and `events-api.ts` uses it with no local copy remaining.
- [ ] `projectSlug` returns `-Users-funnyq-Projects-q-lab-cc-plugins` for `/Users/funnyq/Projects/q-lab/cc-plugins` and `-Users-funnyq--claude` for `/Users/funnyq/.claude`.
- [ ] `repoRootOf` finds a root whose `.git` is a plain file, and returns `null` when no `.git` exists above the input.
- [ ] `parseAgentPrompt` extracts task and role from the announce shape, task with role `"mark-done"` from the finalize shape, an attempt when present, `undefined` when absent, and all-null when neither shape matches.
- [ ] `addUsage` maps the four wire keys to the four camelCase fields, skips non-integer and unknown keys, and is a no-op on a non-object.
- [ ] A second `read()` over unchanged files reads no new bytes and returns counts identical to the first.
- [ ] A file truncated below its cursor is re-read from zero and its counts equal a fresh read of the new content, not the sum of both reads.
- [ ] A transcript whose first line does not mention the plan directory is excluded from the results and is not reopened on later passes.
- [ ] A zero-byte transcript, and one holding only a partial first line, are both omitted from the result rather than returned with unknown membership — and a later `read()` includes the first once its opening line arrives and names the plan.
- [ ] A `started` line carrying no `message` key does not throw, and a malformed JSON line is skipped without losing the valid lines around it.
- [ ] A file deleted after a successful `read()` is absent from the next result and its tokens are gone from the totals; a file that still exists but whose read throws keeps its previous counts and returns them unchanged.
- [ ] `usage-fixture.ts` prints one JSON object on stdout, and feeding its `planDir` and `projectsRoot` back into `createTranscriptSource` reproduces its declared `expected.totals` and `expected.agentCount` exactly. The generator is only useful if it is self-consistent, so this round trip is its own test.
- [ ] The fixture's flightlog names three agents while only two transcripts exist, so a consumer can observe one row that will never pair.
- [ ] Every failure path degrades instead of throwing: missing projects directory, missing repo root, empty file, malformed line. A file that exists but throws on read is the documented exception — it keeps its state rather than reducing the result.

## Verification

- [ ] Run `bun test packages/dispatch/skills/autopilot/scripts/usage-source.test.ts packages/dispatch/skills/autopilot/scripts/tail.test.ts` — all tests pass.
- [ ] Run `bun test packages/dispatch/skills/autopilot/scripts/` — the pre-existing suite still passes, proving the `readRange` lift did not break the live event feed.
- [ ] Run `bunx --bun tsc --noEmit | grep packages/dispatch/skills/autopilot` — prints nothing. Run it exactly like that, against the root `tsconfig.json`: naming files on the `tsc` command line drops the config, so `strict` runs without Bun's types and every `Bun`, `process`, and `Buffer` reports as an undefined name, burying real errors under fake ones. Do not chase a zero total; the repo-wide run is not green.
- [ ] Run `git status --short -- packages/dispatch/skills/autopilot/scripts/usage-types.ts packages/dispatch/skills/autopilot/scripts/usage-source.ts packages/dispatch/skills/autopilot/scripts/usage-source.test.ts packages/dispatch/skills/autopilot/scripts/tail.ts packages/dispatch/skills/autopilot/scripts/tail.test.ts packages/dispatch/skills/autopilot/scripts/events-api.ts` and confirm all six paths are dirty.
- [ ] Build fixture transcript trees with `mkdtempSync(join(tmpdir(), "usage-source-"))`, writing real JSONL files that mirror the line shapes in `../_context/data-model.md`, and pass that temp directory as `projectsRoot`. Never read a real `~/.claude/projects/` directory from a test.
- [ ] A source built against a `projectsRoot` whose slug directory does not exist yet returns `[]`, and then returns real results on a later `read()` once that directory and its files are created — proving the negative verdict was not cached.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Throws on a line without `message`, or the slug rule collapses dashes so no directory is ever found | Happy path reads correctly, but a truncated file double-counts or a reset leaves stale counts behind | Cursor, reset, decoder, and exclusion all behave; a second pass reads zero bytes and returns identical counts |
| Test coverage | ×2 | No tests, or only `projectSlug` is tested | Happy-path parsing only, no filesystem fixtures, no malformed input | Temp-dir fixtures cover unchanged rescan, truncation, exclusion, missing `message`, malformed JSON, and both prompt shapes |
| Interface & readability | ×1 | Parsing and filesystem access tangled into one function that cannot be tested without a temp dir | Helpers exported but I/O leaks into one or two of them | Every parser is a pure exported function; only the source object touches the disk |
| Assumptions & docs | ×1 | Magic regexes and the slug rule appear with no explanation of where they came from | The undocumented-format risk is noted somewhere but not at the code that depends on it | Each on-disk assumption carries a one-line comment naming what was observed, so a future reader knows what to re-verify |

## Out of scope

- Pairing agents to fleet rows, and any rollup keyed by task — the attribution layer owns that end to end, and splitting it across two tasks would put the conservation invariant in two places. Deferred.
- Any change to `FleetSnapshot`, `FleetRow`, or the server-sent event frame. The wiring task owns the delivery path; this task only produces the array. Deferred.
- Persisting cursors to disk. State lives in memory for the life of one source object, and a restarted dashboard simply re-reads. Nothing here needs an on-disk cache, so do not build one.
- Reading `~/.codex/` or any OpenCode store. Those engines run as subprocesses and leave no Claude transcript; their rows render as unavailable rather than zero, and capturing them is a separate feature. Deferred.
- Dollar cost. Pricing lives in another plugin and the import ban forbids reaching for it. Deferred.
