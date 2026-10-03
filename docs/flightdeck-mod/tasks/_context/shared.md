# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

Flightdeck is dispatch's read-only run viewer for an autopilot task tree or a Workflow graph run. Today it is a web dashboard only. This work adds a glanceable overview pane inside Claude Code, through dispatch's existing Claude Code mod. The pane reads files directly through a bun child; it never talks to the flightdeck server.

## Tech stack

- **Runtime**: Bun with TypeScript, no transpile step. No runtime npm dependencies.
- **Mod**: a Claude Code function-hooks module. `packages/dispatch/hooks/hooks.json` is `{ "modules": ["./register.ts"] }`; `register.ts` exports `register: Register = (on) => { … }` and today hooks only `tool.call` for the flightplan linter.
- **Data code to reuse** (all in `packages/dispatch/skills/autopilot/scripts/` unless noted):
  - `detectSource(planDir): "tasks" | "graph" | "none"` — `graph-source.ts`.
  - `loadPlan(planDir)` — `tree-api.ts`; returns `{ slug, planTitle, repo, bucketDirs, loaded, entries }`.
  - `loadGraphPlan(planDir)` — `graph-source.ts`; same shape for a `graph.json` run.
  - `buildTreePayload({ deckSource, slug, planTitle, repo, bucketDirs, loaded, entries }): TreePayload` — `tree-api.ts`. `TreePayload` carries `tasks: TaskView[]`, `counts {total, done, inProgress, ready, blocked, invalid}`, `buckets: string[]`, `errors: PlanError[]`.
  - `aggregateFleet(entries: FlightlogEntry[]): FleetRow[]` — `fleet.ts`. A `FleetRow` has `role`, `ref?`, `attempt?`, `label`, `status: "in-flight" | "abandoned" | "finished"`, `startedAt?` (ISO string).
  - `TaskView` (`fleet.ts`): `ref` (`bucket/NN`), `bucket`, `title`, `state: "done" | "in-progress" | "ready" | "blocked" | "invalid"`, `dependsOn: string[]`, `attempts: number`, `latestScore: { weighted, threshold, passOp, passed, … } | null`.

## Mod constraints (break one and the mod fails silently)

- A mod has no `Bun` global, no `node:` modules, no global `fetch`. Anything needing them runs in a bun child through `$.process.run(["bun", path, …args])`.
- `$.process.run` gives the child no `HOME`. Pass what the child needs as arguments.
- `$` may not be handed to another file's function. A feature file exports a function that takes `on` and returns nothing; `register.ts` calls it.
- Two hooks on the same event need distinct matchers.
- A render hook may not write state. Writes happen in a `$.clock.every` ticker or a command handler, through `atom` / `read` / `update` from `claude-code`.
- A toast raised during `session.start` is dropped; delay it with `$.clock.after(1000, …)`.
- Pure logic goes in plain `.ts` files that import nothing from `claude-code`, so `bun test` covers them. Files that import `claude-code` stay out of the root bun and tsc runs — either because the root `tsconfig.json` `include` (`packages/**/*.ts`) never reaches them (a `.tsx` file), or through an explicit `exclude` / `bunfig.toml` `pathIgnorePatterns` entry (`register.ts`, `*.mod.test.ts`) — and are tested with `claude plugin test` on a temp copy.

## The `DeckSnapshot` contract

The snapshot CLI prints exactly this JSON on stdout; the pane renders exactly this. It lives in `packages/dispatch/hooks/flightdeck/types.ts` (type-only, no imports), and both sides import it from there.

```ts
export type DeckState = "done" | "in-progress" | "ready" | "blocked" | "invalid";

export type DeckTask = {
  ref: string;            // "bucket/NN", or the graph node id
  title: string;
  state: DeckState;
  attempts: number;
  score: { weighted: number; threshold: number; passed: boolean } | null;
};

export type DeckAgent = {
  role: string;           // FleetRow.role
  ref: string | null;
  attempt: number | null;
  label: string;
  startedAt: string | null; // ISO; the pane renders elapsed from it at draw time
};

export type DeckSnapshot = {
  deckSource: "tasks" | "graph";
  plan: string;           // absolute plan dir
  slug: string;
  planTitle: string;
  counts: { total: number; done: number; inProgress: number; ready: number; blocked: number; invalid: number };
  buckets: { name: string; done: number; total: number }[];  // TreePayload.buckets order
  waves: string[][];      // waves[0] = wave 1; refs in TreePayload.tasks order
  unschedulable: string[];// refs no layer reaches (cycle, dangling dep), sorted
  currentWave: number | null; // 1-based: lowest wave holding a non-done task; null when no wave holds one (all done, or only unschedulable work left)
  tasks: Record<string, DeckTask>;
  agents: DeckAgent[];    // FleetRow.status === "in-flight" only, startedAt ascending
  errors: number;         // TreePayload.errors.length
};
```

**Field consumers.** The pane renders `slug`, `counts`, `buckets`, `waves`, `unschedulable`, `currentWave`, `tasks`, `agents`, and `errors` (as a red `N errors` summary segment when > 0). It uses `plan` for the Open flightdeck button. `deckSource` and `planTitle` are identification only and are not rendered.

**Waves are static dependency depth over the whole tree, done tasks included.** A task with no `dependsOn` is wave 1; otherwise its wave is 1 + the highest wave among its dependencies. A dependency outside the tree, or a cycle, puts the task (and everything depending on it) in `unschedulable`. Rows never move as work lands; colour carries state.

## Pane decisions

- Pane id `flightdeck`, title `Flightdeck · <slug>` (the slug lives in the title, not the summary). Docked width 40 columns; the inline seat (a narrow terminal places the pane above the prompt) is 2 rows.
- **Docked**, top down: two summary lines — progress and wave state, then diagnostics (`stale`, `N errors`) before the glyph counts `●2 ○3 ·3 ✗0`, so a clip never hides a diagnostic; one bar per bucket; one row group per wave (`W<n>` then cards, wrapping inside the wave); one line per in-flight agent; an `Open flightdeck` button.
- **Inline**: line 1 compact summary, diagnostics first and the slug last; line 2 `W<currentWave>` and that wave's cards.
- **Run end states**, checked in this order: `currentWave` non-null → `wave N of M`; else `counts.done === counts.total` → `all done` (even when done tasks sit in `unschedulable`); else → the docked summary reads `stuck · N unschedulable` (red, N = unschedulable refs whose task is not done), the inline summary reads the short `stuck` (red), and the inline line 2 shows `W?` and the cards of the not-done unschedulable refs.
- **Width**: every line the pane draws fits the pane width. One clip rule applies to every line: a line within the width is unchanged; otherwise keep the first `width - 1` columns across the segments in order, append `…` to the segment holding the last kept column, and drop the rest (`[{text:"1234"},{text:"x"}]` at width 4 → `123…`). At width 1 the line is `…`; below 1 it is empty. A clipped card keeps its `ref`, so it stays pressable.
- **Card**: `<ref> <glyph><attempts if > 1>`, for example `api/01 ●2`. Glyphs and colours:

  | State | Glyph | Colour |
  |---|---|---|
  | done | `✓` | `#3fb950` |
  | in-progress | `●` | `#d29922` |
  | ready | `○` | default text |
  | blocked | `·` | dim |
  | invalid | `✗` | `#f85149` |

- Pressing a card toasts `ref · title · state · attempt N · score W/T passed|failed` (score part omitted when `score` is null).
- `/flightdeck [planDir]` toggles the pane; `/flightdeck close` closes it. The bare form resolves the plan with the CLI's `--latest <repo root>`.
- Auto-open: a `tool.call` hook on `Bash` whose command runs `flightdeck.ts` with `--plan <dir>` opens the pane on that plan after the call succeeds, in that session only.
- Lifecycle: only open and close change the ticker, each synchronously before its first `await`; snapshot work never touches it; a `generation` counter bumped by open and close discards any snapshot that returns late.
- Refresh: a 2000 ms ticker re-runs the snapshot child only while `$.ui.panes()` lists `flightdeck`; it cancels itself when the pane is gone.
- A failing snapshot keeps the last good one and marks the summary `stale`. No snapshot yet and a failure → one line: the child's first stderr line.
- `Open flightdeck` runs `bun <plugin root>/skills/autopilot/scripts/flightdeck.ts --plan <dir>`, which reuses a live server or starts one and opens the browser itself. A different plan's launch SIGTERMs the running server — existing launcher behaviour, not changed here.

## File / directory layout

- Snapshot CLI: `packages/dispatch/skills/autopilot/scripts/deck-snapshot.ts`, test beside it as `deck-snapshot.test.ts`.
- Mod: `packages/dispatch/hooks/flightdeck/` holds `types.ts`, the pure `rows.ts` and `deck-command.ts` with `*.test.ts` beside them, and `flightdeck.tsx`. The mod test is `packages/dispatch/hooks/flightdeck.mod.test.ts`, matching the existing `flightplan-lint.mod.test.ts` naming that the root exclusions already cover.

## Code style

- Use `type` over `interface`.
- Comment why, never what; one line. Match the surrounding comment density.
- No new layers or options beyond what this file names.
- Authoritative source (verification only): root `CLAUDE.md` → Code Conventions.

## Commit & branching style

- Branch: `main` (GitHub Flow).
- Commit format: emoji + conventional, e.g. `✨ feat: Add flightdeck pane`.
- Tasks do not commit. Under autopilot, a commit agent commits each wave; leave changes unstaged.

## Verification baseline

- `bun test <path>` — unit tests for pure files.
- `bunx --bun tsc --noEmit | grep <path-you-touched>` must print nothing. Run against the root `tsconfig.json`, never a file list; the repo-wide run is not green.
- Mod test on a copy (`claude plugin test` refuses symlinks and would collect dispatch's bun suites in place):
  ```sh
  (d=$(mktemp -d) && mkdir "$d/hooks" && cp -R packages/dispatch/.claude-plugin "$d" && (cd packages/dispatch/hooks && cp -R hooks.json register.ts task-path.ts flightdeck flightdeck.mod.test.ts flightplan-lint.mod.test.ts "$d/hooks") && rm -f "$d"/hooks/flightdeck/*.test.ts && claude plugin test "$d"; s=$?; rm -rf "$d"; exit $s)
  ```

## Decisions frozen during interview

- **Host is dispatch's mod** — the data code already lives in dispatch and versions with it.
- **Files, not HTTP** — SSE is unusable under the 30 s fetch cap, and the global `daemon.json` lets another launch kill the server.
- **Static-depth waves** — stable rows over fidelity to the waves autopilot actually flies.
- **No tokens in the pane** — attribution reads transcripts, too costly at 2 s.
- **Graph runs supported** — same `detectSource` split the server uses.
- **Auto-open only in the launching session** — no global polling of `daemon.json`.
