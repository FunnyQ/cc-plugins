# MODELS-01: Parse and lint the Models task header

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/models.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: models/02, docs/01
> **Status**: done

## Goal

A task file can declare `> **Models**: dev=opus/high, verify=sonnet`. `parseTask()` returns it as a typed map plus the raw header value, `lint-task.ts` rejects every malformed form, and `next-ready.ts` hands the raw value to autopilot on every ready item.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lib/parse-task.ts` (modify) — add the `Models` types, a pure `parseModels()`, and `models` / `modelsRaw` / `modelErrors` on `ParsedTask`
- `packages/dispatch/skills/flightplan/scripts/lib/parse-task.test.ts` (modify) — parse cases
- `packages/dispatch/skills/flightplan/scripts/lint-task.ts` (modify) — the `models` rule in `lintFile()`
- `packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` (modify) — one case per violation class
- `packages/dispatch/skills/flightplan/scripts/next-ready.ts` (modify) — `ReadyRef` carries `modelsRaw`
- `packages/dispatch/skills/flightplan/scripts/next-ready.test.ts` (modify) — `--json` and `--summary` carry `modelsRaw`

## Implementation notes

### Types (export from `lib/parse-task.ts`)

```ts
export type ModelRole = "dev" | "verify" | "judge" | "fix";
export type ModelName = "haiku" | "sonnet" | "opus" | "fable";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelChoice = { model: ModelName; effort: Effort | null };
export type TaskModels = Partial<Record<ModelRole, ModelChoice>>;

/** Pure: parse the value after `**Models**:`. Invalid entries are dropped from `models` and described in `errors`. */
export function parseModels(value: string): { models: TaskModels; errors: string[] };
```

Add three fields to `ParsedTask`, next to `finalReview`:

```ts
/** Parsed `> **Models**:` header; `{}` when the header is absent. Lint consumes this. */
models: TaskModels;
/** The header value as written after `**Models**:`, edge-trimmed only; `null` when the header is absent. next-ready emits this. */
modelsRaw: string | null;
/** One message per malformed Models entry; `[]` when the header is absent or clean. */
modelErrors: string[];
```

### Parsing rules

- Find the header line the same way `extractFinalReview()` does. Strip the leading `>` from each quote line and match `^\*\*Models\*\*\s*:\s*(.*)$` on the trimmed line. There is no line at all → `models: {}`, `modelsRaw: null`, `modelErrors: []`. When the line exists, `modelsRaw` is the captured value with only leading and trailing whitespace trimmed; an empty value gives `modelsRaw: ""`.
- Implement exactly this grammar. The orchestrator carries an in-script copy of the same parser, and a parity test pins the two together, so do not loosen or tighten any step:
  1. Split the value on `,`.
  2. Trim each piece, and drop pieces that are empty, so a trailing comma is allowed.
  3. Each remaining piece must match `^([a-z]+)\s*=\s*([a-z]+)(?:\s*/\s*([a-z]+))?$`: role, model, optional effort, with whitespace allowed around `=` and `/`.
  4. An empty value (`> **Models**:` with nothing after it) is a violation.
- Each of these produces one message in `errors` and drops the entry:
  - **malformed** — a piece that does not match the step-3 regex. Examples: `dev`, `dev=`, `dev=opus/high/max`, `dev=Opus`.
  - **unknown role** — anything outside `dev | verify | judge | fix`. Example: `scout=haiku`.
  - **unknown model** — anything outside `haiku | sonnet | opus | fable`. Example: `dev=gpt5`.
  - **unknown effort** — anything outside `low | medium | high | xhigh | max`. Example: `dev=opus/extreme`.
  - **duplicate role** — the second occurrence is reported and dropped, and the first one wins. Example: `dev=opus, dev=sonnet`.
- A header line with an empty value (`> **Models**:`) is one malformed error.
- Matching is exact and lowercase. `Opus` fails the step-3 regex, so it is malformed, the same way `Status` values must be bare.
- A message names the offending entry verbatim, e.g. `Models entry "dev=gpt5": unknown model "gpt5" (expected haiku, sonnet, opus, fable)`.

Examples:

| Header value | `models` | `errors` |
|---|---|---|
| `dev=opus/high, verify=sonnet` | `{ dev: {model:"opus",effort:"high"}, verify: {model:"sonnet",effort:null} }` | `[]` |
| `judge = opus / xhigh` | `{ judge: {model:"opus",effort:"xhigh"} }` | `[]` |
| `dev=opus, dev=sonnet` | `{ dev: {model:"opus",effort:null} }` | 1 duplicate-role message |
| `scout=haiku` | `{}` | 1 unknown-role message |

### Parity fixtures

The orchestrator's in-script parser must agree with `parseTask()` on this exact list. Both accept with the same map, or both reject. Pin every row through `parseTask()` here. The orchestrator test repeats the same list against its own copy.

| # | Header value | Result |
|---|---|---|
| 1 | `dev=opus/high, verify=sonnet` | `{ dev: {model:"opus",effort:"high"}, verify: {model:"sonnet",effort:null} }` |
| 2 | `judge = opus / xhigh` | `{ judge: {model:"opus",effort:"xhigh"} }` |
| 3 | `dev=opus,` | `{ dev: {model:"opus",effort:null} }` |
| 4 | ` dev=sonnet/low , verify=haiku ` | `{ dev: {model:"sonnet",effort:"low"}, verify: {model:"haiku",effort:null} }` |
| 5 | `dev=opus, dev=sonnet` | rejected (duplicate role) |
| 6 | `dev=gpt5` | rejected (unknown model) |
| 7 | `dev=Opus` | rejected (malformed) |
| 8 | *(empty)* | rejected (empty value) |
| 9 | `dev=opus/high/max` | rejected (malformed) |

### Lint rule `models` (`lint-task.ts`, inside `lintFile()`)

- Push `push("models", message)` for every entry in `task.modelErrors`.
- Push one more violation when `task.models.fix` is set and `task.finalReview` is false. Its detail reads `` `fix` is legal only on the Final review task ``.
- A `fix` entry on a task that carries `> **Final review**: true` is clean.
- The rule sits beside the other header checks, such as `required-reading`. It applies in both per-file and tree mode, because tree mode calls `lintFile()`.

### `next-ready.ts`

- Change `ReadyRef` to `{ ref: string; finalReview: boolean; path: string; modelsRaw: string | null }`.
- `findReadyDetailed()` fills `modelsRaw: byRef[ref]?.modelsRaw ?? null`. Both `--json` and `--summary` already serialize `ReadyRef[]`, so both carry the field with no other change. Update the usage comment at the top of the file, which currently reads `[{ref,finalReview,path}]`.
- Emit the raw value only, never the parsed map. The orchestrator is the only consumer, and it parses the raw value itself because a Workflow script cannot import. The scout also has to transcribe this value verbatim, so one string is safer than a nested object.
- `next-ready.ts` does not validate the value. Lint is the gate.

### Tests (Bun `bun test`, beside each script)

- `lib/parse-task.test.ts` — through `parseTask()` on a full task string, cover:
  - a valid multi-role header
  - no header, giving `models: {}`, `modelsRaw: null`, `modelErrors: []`
  - `modelsRaw` equals the header value as written, e.g. `dev=opus/high, verify=sonnet`
  - whitespace tolerance
  - an effort-less entry, giving `effort: null`
  - each error class: malformed, unknown role, unknown model, unknown effort, duplicate role, empty value
  - an uppercase model, which is rejected as malformed
  - every row of the parity fixtures table, as one table-driven test
- `lint-task.test.ts` — one `lintFile()` case per class above that asserts a `models` violation. Also cover `fix` on a non-final task (violation), `fix` on a final-review task (no `models` violation), and a clean header (no `models` violation).
- `next-ready.test.ts` — in a temp tree, a ready task with a Models header shows up in `--json` and `--summary` output with `modelsRaw` equal to the header value as written, a task without one shows up with `modelsRaw: null`, and no ready item carries a `models` key.

## Acceptance criteria

- [x] `parseTask()` implements the four-step grammar and returns the stated result for all nine parity fixtures.
- [x] `parseTask()` returns `models` and `modelErrors` exactly as the examples table states, `modelsRaw` equal to the header value with only its outer whitespace trimmed, and `{}` / `null` / `[]` when the header is absent.
- [x] For the line `> **Models**:  dev=opus  , verify = haiku  ` (with trailing spaces), `modelsRaw` is exactly `dev=opus  , verify = haiku`: the outer whitespace is trimmed and the inner text is untouched.
- [x] `lintFile()` reports rule `models` for malformed, unknown-role, unknown-model, unknown-effort, duplicate-role, empty-value, and `fix`-on-non-final headers. It reports none for a clean header or for `fix` on a Final review task.
- [x] Every `next-ready.ts --json` and `--summary` ready item has a `modelsRaw` key, `null` when the task declares none, and no ready item has a `models` key.
- [x] No existing test in the three touched test files changes its expectation, except where a `ReadyRef` literal now has to include `modelsRaw: null`.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/lib/parse-task.test.ts` passes.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/lint-task.test.ts` passes.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/next-ready.test.ts` passes.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep -E 'flightplan/scripts/(lib/parse-task|lint-task|next-ready)'` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | a valid header misparses, or a violation class is not reported | the happy path works, but a class (duplicate, empty value, `fix` placement, case) slips through or a clean header is flagged | every row of the examples table and every violation class behaves exactly as specified; `parseTask()` exposes both `models` and `modelsRaw`; `ReadyRef` carries `modelsRaw` only, in both output modes |
| Test coverage | ×2 | no new tests | valid header tested, but some violation classes, `modelsRaw`, or the next-ready output are untested | each violation class, the absent header, `modelsRaw` as written, `fix` on final vs non-final, and both next-ready modes (raw value present, `null`, no `models` key) are asserted |
| Interface & readability | ×1 | parsing smuggled into lint, or types redeclared in several files | works, but the types are loose (`string` instead of the unions) or the parse is not a pure function | one exported pure `parseModels()`, union types exported once from `parse-task.ts`; lint consumes the parsed map and next-ready passes the raw string through |
| Assumptions & docs | ×1 | usage comments left stale | the `next-ready.ts` usage comment is not updated | usage comments and doc comments name the new field; the "first entry wins on duplicate" rule is commented |

## Out of scope

- Parsing `modelsRaw` in the autopilot orchestrator — Deferred. Reason: the orchestrator's role map, the scout's structured field, and escalation change in a separate step that consumes this value.
- Documenting the header in `task-template.md` or the interview guide — Deferred. Reason: a separate docs step owns the user-facing docs.
- Validating models inside `next-ready.ts` — Deferred. Reason: lint is the gate, and autopilot lints the tree before flying.
