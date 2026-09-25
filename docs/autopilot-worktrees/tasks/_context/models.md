# Models: the per-role map and the task header

## The `> **Models**:` task header

An optional task-file header line:

```
> **Models**: dev=opus/high, verify=sonnet, judge=opus/xhigh
```

- **Grammar** (both parsers, `parse-task.ts` and the in-script copy in the orchestrator, implement exactly this):
  1. Split the value on `,`.
  2. Trim each piece, and drop pieces that are empty, so a trailing comma is allowed.
  3. Each remaining piece must match `^([a-z]+)\s*=\s*([a-z]+)(?:\s*/\s*([a-z]+))?$`: role, model, optional effort, with whitespace allowed around `=` and `/`.
  4. An empty value (`> **Models**:` with nothing after it) is a violation.
- A shared parity fixture list lives in the orchestrator test: every input there must give the same result from both parsers, including `judge = opus / xhigh`, `dev=opus,`, and ` dev=sonnet/low , verify=haiku `.
- **Roles**: `dev`, `verify`, `judge`, `fix`. `fix` is legal only on the task that carries `> **Final review**: true`.
- **Models**: `haiku`, `sonnet`, `opus`, `fable` (Workflow `agent()` model aliases).
- **Efforts**: `low`, `medium`, `high`, `xhigh`, `max` (Workflow `agent()` `effort` values). Omitted effort means "the default map's effort for that role is dropped too" — i.e. `verify=sonnet` runs sonnet with no `effort` option.
- A role may appear at most once. An unknown role, model, or effort, a duplicate role, a malformed entry, or `fix` on a non-final task is a lint violation.
- A missing header means every role uses the default map.
- Parsed shape (TypeScript):

```ts
export type ModelRole = "dev" | "verify" | "judge" | "fix";
export type ModelName = "haiku" | "sonnet" | "opus" | "fable";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelChoice = { model: ModelName; effort: Effort | null };
export type TaskModels = Partial<Record<ModelRole, ModelChoice>>;
```

`next-ready.ts` ready items (plain JSON and `--summary`) carry `modelsRaw: string | null`, the header value with only its outer whitespace trimmed (inner text untouched), or `null` when the header is absent. It does not emit a parsed map: the orchestrator is the only consumer, and it parses the raw value itself with a small copy of the parser inside the script, because a Workflow script cannot import. `lint-task.ts` has already rejected every malformed header before a run starts.

**The scout carries `modelsRaw` as a required structured field per ready item**, the same way it carries `maxParallel`. A cheap scout can drop a trailing field while transcribing JSON; that is how `maxParallel` was once lost.
- A missing field is a `(scout)` failure. It never falls back to defaults.
- When the scout's verbatim stdout still carries the item's `modelsRaw`, the two must be equal. A disagreement is a `(scout)` failure.
- A raw value the in-script parser rejects is a `(scout)` failure.
- **Residual:** a scout that drops the value from stdout and also invents `null` for the structured field still runs that task on defaults. This is the same two-coordinated-errors residual that `maxParallel` documents.

## Default role map (orchestrator)

| Role | model / effort |
|---|---|
| dev (every Claude rung except the last) | opus / medium |
| dev (last Claude rung) | the task's dev choice with effort raised one step — opus / high by default |
| verify, and the drift re-verify | opus / low |
| judge | opus / medium |
| fix (Final review fixer) | opus / high |
| commit (inter-wave and post-loop) | opus / low |
| structuredRetry (the model a failed structured call retries on) | opus / medium |
| devExternal (the driver of codex / opencode) | haiku, no effort |
| scout, mark-done, park | haiku, no effort |
| reviewLens | unchanged — `CFG.reviewLensModel ?? 'opus'`, no effort |

Scout, mark-done, and park currently share `MODEL.verify`; they must get their own haiku entry so verify can move to opus without dragging them along.

## Escalation rule

- The effort ladder is `low → medium → high → xhigh → max`; `max` raised stays `max`. A choice with no effort stays without effort, because there is no base to raise from.
- The last Claude dev rung uses the task's dev choice (override, else default) with its effort raised one step. The model does not change.
- `devEngine` (external dev) and `lastShotEngine` (an external rung appended after the Claude ladder) keep today's behaviour. Only the Claude rungs follow this rule.
- A task override replaces only the roles it names.
- Example: `dev=sonnet/low` with 3 Claude attempts → sonnet/low, sonnet/low, sonnet/medium.
