# Shared conventions

All work in this plan happens inside
`packages/dispatch/skills/autopilot/` of the `cc-plugins` repo.

## Runtime and language

- Runtime is **Bun** with TypeScript. There is no transpile step and no build step.
- Use `type`, never `interface`.
- Take **no external npm dependencies** at runtime. Vendor libraries are committed.
- **Never import across plugin boundaries.** Code under `packages/dispatch/` must not
  import from `packages/monitor/`, `packages/chronicle/`, `packages/relay/`, or
  `packages/herdr/`. Importing from a sibling skill inside `dispatch` is fine and is
  already done: `autopilot/scripts/` imports from `../../flightplan/scripts/lib/`.
- Comment *why*, never *what*. One line. The existing files in this directory model the
  tone — see the block comment on `FleetStatus` in `fleet.ts`.

## Frontend

- `dashboard/dist/` is **committed as-is**. Edit the shipped files directly; there is
  no source tree that compiles into it.
- The framework is **petite-vue**, not full Vue. `v-scope`, `reactive()`, and template
  strings injected with `insertAdjacentHTML` — follow what `app.js` already does.
- Shared render helpers live in `dashboard/dist/modules/format.js` and are already
  exported: `SCORE_MAX`, `escapeHtml`, `percent`, `scoreClass`, `formatScore`,
  `renderDimensions`, `compareTaskOrder`. Add a new formatter there rather than
  defining a private copy in two modules.
- **Always escape interpolated values** with `escapeHtml` before putting them into an
  `innerHTML` / template string.

## Tests

- Runner is `bun:test`: `import { describe, expect, test } from "bun:test";`
- Fixtures are **inline** — small local factory functions returning plain objects or
  strings. See the `note(...)` / `score(...)` / `task(...)` helpers at the top of
  `scripts/fleet.test.ts` and `scripts/tree-api.test.ts`.
- Use the filesystem **only when the code under test touches it**. Then use
  `mkdtempSync(join(tmpdir(), "<prefix>-"))`, as the `repoName` block in
  `scripts/tree-api.test.ts` does, and clean up after.
- Name the test file next to its subject: `foo.ts` → `foo.test.ts`.

Run the suite for this directory with:

```bash
bun test packages/dispatch/skills/autopilot/scripts/
```

## Typecheck

Run it before calling anything done. `bun build` does not typecheck and `bun test`
only reaches the paths a test drives.

```bash
bunx --bun tsc --noEmit | grep packages/dispatch/skills/autopilot
```

**That grep must print nothing.** Do not chase a zero total: the repo-wide run has
dozens of pre-existing errors outside this directory and is not green. Clean means
your own paths are absent from the output.

**Typecheck against the root `tsconfig.json`, never a file list.** Naming files on the
command line drops the config, so `strict` runs without `types: ["bun"]` and every
`Bun`, `process`, and `Buffer` reports as an undefined name — real errors then hide
among a dozen fake ones.

## Exact numbers live in the payload; the screen is a rounded view

One rule, because three layers would otherwise each guess at it.

- The event payload carries **exact integers**. It is the only place a number is true.
- The display **abbreviates and rounds**: `278146` renders as `278.1K`. That is
  intended, permanent, and applies to every token figure on screen.

Therefore **no check of numeric correctness may read rendered text.** Assert on the
payload. A test or a review step that sums what the cards show and compares it to the
header is asserting that rounding is lossless, which it is not — it will fail against a
perfectly correct implementation for every figure above 999.

The screen is checked for a different property: that it displays the formatter applied
to the payload's value. That is a formatting check, not a truth check, and the two must
never be collapsed into one assertion.

## Verification data: never depend on surviving local transcripts

The transcripts this feature reads are uncommitted, machine-local, and **deleted by
Claude Code on its own retention schedule**. Deletion is a normal scheduled event, not
a corruption.

So no gate anywhere in this plan may be written as "open a plan that has already run".
That gate passes today, silently reports zero-versus-zero agreement in a month, and
cannot be run at all on another machine. A gate that cannot run is not a gate.

Every manual, browser, or end-to-end check uses the **fixture generator** instead:

```bash
bun packages/dispatch/skills/autopilot/scripts/usage-fixture.ts
```

It builds a complete, self-contained scenario in a temp directory and prints one JSON
object on stdout:

```jsonc
{
  "planDir": "/tmp/…/plan",          // a real plan dir with tasks/ and .flightlog/run.jsonl
  "projectsRoot": "/tmp/…/projects", // a synthetic ~/.claude/projects tree
  "expected": {                       // the numbers the fixture was built to produce
    "totals": { "input": 300, "output": 3000, "cacheRead": 30000, "cacheWrite": 3000 },
    "byTask": { "work/01": { "…": 0 } },
    "agentCount": 2,
    "rowsWithoutUsage": 1             // proves the unavailable-versus-zero distinction
  }
}
```

`expected` is declared by the generator, so a gate compares against it directly and
never needs a second summing script that could share a bug with the first.

The server accepts `--projects-root <dir>` to point at that synthetic tree. It exists
for this and defaults to the real location.

A check against real historical data is a **stronger** signal and welcome when the data
happens to exist. It is never the only path.

## Scope discipline

- Build the smallest thing that satisfies the task. Change only the lines the task
  requires.
- Do not add a layer, option, or abstraction unless a stated requirement fails without
  it. If you cannot name the concrete failure a new layer prevents, delete the layer.
- Do not handle errors the code cannot reach.
- Report unrelated problems you find. Do not fix them.

## Parallel execution

Tasks in this plan may run **beside each other in one shared working tree**, and none
of them commits. So a sibling's correct, uncommitted edits are indistinguishable from
a scope violation.

- Never assert anything about the state of the whole tree.
- Any `git status` check must name your own declared paths after a `--` pathspec, and
  must claim nothing about paths outside that list.
