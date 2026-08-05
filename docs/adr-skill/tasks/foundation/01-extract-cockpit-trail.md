# FOUNDATION-01: Extract the shared cockpit trail reader

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/trail-and-adr.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: foundation/03, triage/01
> **Status**: done

## Goal

One implementation of the cockpit decision-log reader, living in chronicle, imported by the PR branch analyzer, with the PR analyzer's behaviour unchanged.

## Files to create / modify

- `packages/chronicle/shared/scripts/cockpit-trail.ts` (new) — the shared reader
- `packages/chronicle/shared/scripts/cockpit-trail.test.ts` (new) — its unit tests
- `packages/chronicle/skills/pr/scripts/analyze-branch.ts` (modify) — delete the moved symbols, import them instead

## Implementation notes

This task has three halves that must not blur together: symbols **moved** out of the PR analyzer, logic **ported** from the monitor plugin, and everything that stays **untouched** in the PR analyzer.

### Move out of the PR analyzer

These already exist in `packages/chronicle/skills/pr/scripts/analyze-branch.ts`. Cut them, paste them into the new shared module, and export them. Grep for each name rather than trusting a line number — the file will shift as you edit it.

| Symbol | Currently | After |
|---|---|---|
| `DecisionRecord` | exported type | exported from the shared module, re-exported or imported by the analyzer |
| `RegistryEntry` | private type | exported type on the shared module |
| `projectMatches` | exported function | exported from the shared module |
| `normalizePath` | private helper of `projectMatches` | private helper inside the shared module |
| `isDecisionRecord` | private function | exported from the shared module |
| `readDecisionLog` | private async function | exported from the shared module |
| `collectDecisions` | exported async function | exported from the shared module, injectable `read` parameter intact |

Also move the cockpit-home and registry-path resolution that is currently inlined inside `harvestCockpit`:

```ts
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const cockpitHome = process.env.COCKPIT_HOME || join(dataHome, "q-lab", "cockpit");
const registryPath = join(cockpitHome, "registry.json");
```

That becomes three named exports on the shared module: `cockpitHome()`, `registryPath()`, and `readRegistrySessions()`. Resolve the environment variables **at call time**, not at module load, so a test can set `COCKPIT_HOME` and see it take effect.

`readRegistrySessions()` reads `registryPath()`, parses it, and returns `registry.sessions` when it is an array, or `[]` otherwise. It must not throw on a missing file, unreadable file, or malformed JSON — it returns `[]`. The existing "does the registry exist at all" check in the PR analyzer stays in the PR analyzer, because it drives that caller's `hasCockpit` flag, which is a PR-body concern and not a property of the trail.

### Port from the monitor plugin

Copy the logic, do **not** import it. The plugin-boundary rule is in the shared context: chronicle and monitor install into separate version-pinned cache directories, so no relative path between them resolves on a user machine, and monitor may not be installed at all.

Port `gitRootOf`, `logRoot`, and the `LogRootDeps` type from `packages/monitor/skills/cockpit/scripts/log-root.ts`. Port `STALE_MS` (`10 * 60 * 1000`) from `packages/monitor/skills/cockpit/scripts/registry.ts`.

Each ported item needs a comment naming its monitor source file as the spec, so a later reader knows where to look when the two drift. Something in the shape of:

```ts
// Ported from packages/monitor/skills/cockpit/scripts/registry.ts — chronicle cannot
// import across the plugin boundary. That file is the spec; keep this in sync by hand.
export const STALE_MS = 10 * 60 * 1000; // 10 min
```

The walk-up resolves a project's trail root in this order:

1. An already-existing `.cockpit/` between cwd and the git root — nearest wins.
2. The git root.
3. cwd, when not inside a git repo.

**The walk must never cross the git root.** `~/.cockpit` is a real leftover directory from the pre-XDG cockpit home, and an unbounded walk would collapse every repo under `$HOME` into one trail.

Two port details are easy to lose, and both are silent when lost:

1. `git rev-parse --show-toplevel` reports a realpath, so cwd must be normalized through `realpathSync` too. Without it the two never compare equal under a symlinked tmpdir, which is exactly what `/tmp` is on macOS — so every test would take the wrong branch while every real run took the right one.
2. If cwd is not inside the reported git root — a stale or renamed checkout, or an injected resolver in a test — return the root immediately rather than walking cwd's own branch. Otherwise the walk can adopt a `.cockpit` outside the repo entirely, which is the very thing the bound exists to prevent.

### Keep in the PR analyzer, behaviour unchanged

`branchDecisions` and `harvestCockpit` stay where they are. The registry-backed, 14-day-horizon path is correct for a pull request. After this task `harvestCockpit` composes the imported pieces instead of owning them: same inputs, same outputs, same dedup-by-id, same `timestamp.localeCompare` sort, same `{ decisions: [], hasCockpit: false }` fallbacks.

The import is a plain relative path from the PR scripts directory up to the shared one:

```ts
import {
  collectDecisions,
  projectMatches,
  readRegistrySessions,
  registryPath,
  type DecisionRecord,
  type RegistryEntry,
} from "../../../shared/scripts/cockpit-trail";
```

`DecisionRecord` is part of the PR analyzer's public surface — `BranchMaterial` uses it and the test file imports it. Re-export it from the analyzer (`export type { DecisionRecord };`) so that surface does not change.

### Export surface of the shared module

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

export type RegistryEntry = { project?: string; logPath?: string };
export type LogRootDeps = { gitRoot?: (cwd: string) => string | null };

export const STALE_MS: number;

export function gitRootOf(cwd: string): string | null;
export function logRoot(cwd: string, deps?: LogRootDeps): string;
export function projectMatches(entryProject: string, repoRoot: string): boolean;
export function isDecisionRecord(value: unknown): value is DecisionRecord;
export function readDecisionLog(path: string): Promise<DecisionRecord[]>;
export function collectDecisions(
  logPaths: string[],
  read?: (path: string) => Promise<DecisionRecord[]>,
): Promise<DecisionRecord[]>;
export function cockpitHome(): string;
export function registryPath(): string;
export function readRegistrySessions(): Promise<RegistryEntry[]>;
```

### Behaviour the tests must pin

- `readDecisionLog` skips blank lines, skips lines that fail `JSON.parse`, and skips parsed objects that fail `isDecisionRecord`. It returns the survivors rather than throwing.
- `collectDecisions` swallows a throw from any one path and continues with the rest. One unreadable log must not take its siblings down with it — the earlier version returned an empty harvest on the first failure, which silently gutted the PR body's "Why" section and reported no cockpit at all rather than one bad file.
- `logRoot` with an injected `gitRoot` that returns `null` returns cwd unchanged, with no walk.
- `logRoot` stops at the git root even when an ancestor above it holds a `.cockpit/`.
- `logRoot` returns the nearest `.cockpit/` when one exists between cwd and the root.

Use `LogRootDeps.gitRoot` to inject in tests rather than shelling out to real git. Build fixture trees under a temp directory and pass real paths through `realpathSync` in the assertions, so the macOS `/tmp` symlink does not produce a false failure.

## Acceptance criteria

- [x] `packages/chronicle/shared/scripts/cockpit-trail.ts` exports every symbol in the export surface above, with those exact names and signatures.
- [x] `packages/chronicle/skills/pr/scripts/analyze-branch.ts` contains no local definition of `DecisionRecord`, `RegistryEntry`, `projectMatches`, `normalizePath`, `isDecisionRecord`, `readDecisionLog`, or `collectDecisions`, and imports them by relative path instead.
- [x] `harvestCockpit` and `branchDecisions` produce the same results as before for the same inputs: same dedup by `id`, same `timestamp` sort, same `hasCockpit` values, same empty-harvest fallbacks.
- [x] `logRoot` never returns a directory above the git root, in any input combination.
- [x] `readDecisionLog` returns the valid records from a file that also contains a blank line, an unparseable line, and a well-formed JSON object that is not a decision record — without throwing.
- [x] `collectDecisions` still accepts an injectable `read` parameter defaulting to `readDecisionLog`, and still continues past a path whose read throws.
- [x] Every ported constant and function carries a comment naming its monitor source file as the spec.
- [x] The new test file covers all five of: walk-up bounded by the git root, nearest `.cockpit` wins, a symlinked temp directory, a malformed JSONL line, and cwd resolving outside the reported git root.

## Verification

- [x] `bun test packages/chronicle/shared/scripts/cockpit-trail.test.ts` passes with zero failures.
- [x] `bun test packages/chronicle/skills/pr/scripts/analyze-branch.test.ts` reports 35 pass, 0 fail — the pre-task baseline.
- [x] `git diff --stat -- packages/chronicle/skills/pr/scripts/analyze-branch.test.ts` prints nothing. The existing PR test file must not be edited; if it needs editing, the extraction changed behaviour and the task is not done.
- [x] `git status --short -- packages/chronicle/shared/scripts/cockpit-trail.ts packages/chronicle/shared/scripts/cockpit-trail.test.ts packages/chronicle/skills/pr/scripts/analyze-branch.ts` shows all three paths dirty.
- [x] `grep -rn "packages/monitor" packages/chronicle/shared/scripts/cockpit-trail.ts` returns only comment lines, never an `import`.
- [x] Do **not** run `bunx tsc --noEmit`. It floods with pre-existing unrelated errors in this repo because `@types/bun` is not installed. `bun test` is the verification.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average ≥ 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A symbol is missing, the analyzer still holds a local copy, or the monitor plugin was imported rather than ported | Compiles and the new tests pass, but the existing PR suite needed edits to go green, or the walk-up can cross the git root | Every listed symbol exported, the PR test file untouched and reporting 35 pass, the walk-up bounded, both port details handled |
| Test coverage | ×2 | No new tests, or tests that only import the module | Happy-path walk-up and a clean JSONL file only | All five named cases covered, including the symlinked temp directory and cwd outside the reported root |
| Interface & readability | ×1 | Environment variables read at module load, or filesystem calls hard-wired so tests cannot inject | Works, but `LogRootDeps` is unused or the return types are implicit | `logRoot` takes its injectable dep, `collectDecisions` keeps its injectable `read`, `type` used throughout, names match the domain vocabulary |
| Assumptions & docs | ×1 | Ported values appear as bare magic numbers with no origin | A comment says what the constant is but not where it came from or why it was copied | Every ported item names its monitor source file and says why it was copied rather than imported |

## Out of scope

- Changing the PR analyzer's 14-day registry horizon or its branch scoping — deliberate. That window is correct for a pull request, which only cares about decisions made on this branch.
- Inverting the PR path to read the log directory instead of the registry — deliberate. That inversion belongs to the ADR context collector, which needs the full history; the PR path does not.
- Deleting or modifying anything under `packages/monitor/` — the port leaves monitor's originals in place as the authoritative spec.
- Creating `.cockpit/archive/` or anything that writes — this module is read-only. The archiver owns every write in this plan.
