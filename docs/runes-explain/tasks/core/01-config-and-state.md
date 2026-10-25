# CORE-01: config-and-state

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/protocol.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: html/02, core/03
> **Status**: todo

## Goal

`explain` is a rune with its own switch in `config.yaml` (default on, toggled by `/runes explain on|off`), and
the explain view's state contract (`ExplainView` types plus the `view` atom and its pure helpers) exists for
every other explain module to import.

## Files to create / modify

- `packages/runes/hooks/config.ts` (modify) — add `"explain"` to `RUNES`, `TEMPLATE` and `TOP`.
- `packages/runes/hooks/config.test.ts` (modify) — add `explain` to the `CURRENT()` fixture; add the three
  tests below.
- `packages/runes/types/index.d.ts` (modify) — the `Explain*` types and `explain: ExplainView` in `PluginState`.
- `packages/runes/hooks/explain/state.ts` (new) — the `view` atom and helpers, exactly as `protocol.md` →
  `## State` gives them.
- `packages/runes/hooks/explain/state.test.ts` (new) — the helpers' tests.

Edit no other file. `register.tsx`, `band.tsx` and every other `hooks/explain/` file belong to other work.

## Implementation notes

### The rune switch in `config.ts`

`explain` is a top-level rune shaped exactly like `teacher`: a section holding only `enabled`, no look fields.

- `RUNES`: append `"explain"` right after `"teacher"`, so it is the last entry.
- `DEFAULTS.enabled` needs no change: the existing `r !== "minimap"` rule makes `explain` default to `true`.
- `Config` and `RULES` need no entry: `teacher` has none, because `RULES` lists only sections with look fields.
- `TOP`: becomes `["clawd", "transcript", "minimap", "teacher", "explain"] as const`. `insertBlock` reads this
  order to put a restored section in its template place, and `upgrade` loops over it to add a missing section.
- `TEMPLATE`: append this block after the `teacher:` block, as the last two lines before the closing backtick
  (keep the template's trailing newline):

  ```yaml
  explain:
    enabled: ${enabled.explain} # the "hey mate, explain please" button under the minimap; a press forks this session to explain it, ELI5
  ```

- `normalize`, `setSwitch`, `isComplete`, `upgrade`: no code change. Each walks `RUNES` / `TOP` and
  `pathOf("explain")` is `["explain"]`, top level, as for `teacher`. Confirm it through the tests; do not add
  special cases.

An existing user file without an `explain:` section reads `explain` as on (the default); `isComplete` then
returns `false`, so `upgrade` adds the section from `TEMPLATE`. That is the intended migration path.

### Types in `types/index.d.ts`

Add, beside `Frame` and `MinimapRow`, verbatim from `protocol.md` → `## State`:

```ts
export type ExplainUsage = { input: number; cacheRead: number; output: number };
export type ExplainCheck = "pending" | "ok" | "fixed" | "failed" | "skipped";
export type ExplainEntry = {
  id: string;
  at: number;
  title: string;
  usage?: ExplainUsage;
} & (
  | { kind: "text"; body: string }
  | { kind: "ask"; question: string; options: string[] }
  | {
      kind: "html";
      summary: string;
      path: string;
      check: ExplainCheck;
      note?: string;
    }
);
export type ExplainView = {
  entries: ExplainEntry[]; // newest first
  selected?: string; // an entry id; absent means the newest
  isRunning: boolean; // a fork is in flight
  error?: string; // the last failure, cleared by the next press
};
```

and inside `interface PluginState { runes: { … } }` add `explain: ExplainView;`. `claude plugin validate`
holds the atom key `{ plugin: "runes", key: "explain" }` to this declaration.

### `hooks/explain/state.ts`

Write it exactly as the `protocol.md` code block gives it: `MAX_ENTRIES = 12`, `view` (atom on
`{ plugin: "runes", key: "explain" }`, initial `{ entries: [], isRunning: false }`), `usageOf`, `selectedOf`,
`withEntry`, `patchEntry`. Double quotes, semicolons. No other exports.

- `usageOf(u)`: `input` = `input_tokens + cache_creation_input_tokens`; `cacheRead` = `cache_read_input_tokens`;
  `output` = `output_tokens`.
- `withEntry(v, entry)`: prepends, cuts to `MAX_ENTRIES`, sets `selected` to the new entry's id, keeps every
  other field (`isRunning`, `error`).
- `patchEntry(v, id, patch)`: merges `patch` into the entry with that id; other entries and fields unchanged;
  an unknown id changes nothing.
- `selectedOf(v)`: the entry whose id is `v.selected`, else `v.entries[0]`, else `undefined`.

### Tests

`config.test.ts` (keep its existing style: double quotes, semicolons, `test` from `claude-code/testing`):

1. Add `explain: { enabled: true }` to `CURRENT()` after `teacher`, so the existing `isComplete` / `upgrade`
   tests still see a current file.
2. `explain is on by default and its switch sits at the top level after teacher` —
   `DEFAULTS.enabled.explain === true`; `TEMPLATE(DEFAULTS.enabled)` contains `"\nexplain:\n  enabled: true"`
   and its `explain:` line comes after its `teacher:` line.
3. `the explain template line names the button` — the template contains
   `# the "hey mate, explain please" button under the minimap`.
4. `/runes explain off reads back as off` — `setSwitch(TEMPLATE(DEFAULTS.enabled), "explain", false)`, parsed
   with the same YAML helper the file's other read-back tests use (or `normalize` over the parsed object),
   gives `enabled.explain === false`, and every other rune's switch is unchanged. Changes exactly one line.

The existing tests "every rune starts on but the minimap…" and "TEMPLATE writes a switch for every rune…"
loop over `RUNES` and must pass with `explain` included, unmodified.

`hooks/explain/state.test.ts` (new; double quotes, semicolons):

- `withEntry` puts the new entry first and selects it.
- `withEntry` on a view of 12 entries keeps 12, drops the oldest, and keeps `isRunning` and `error`.
- `patchEntry` changes only the matching entry (e.g. an html entry's `check` from `"pending"` to `"ok"` with a
  `note`), and an unknown id returns equal entries.
- `selectedOf` returns the selected entry; falls back to the newest when `selected` is absent or names a
  dropped id; returns `undefined` on an empty view.
- `usageOf({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 })`
  is `{ input: 15, cacheRead: 100, output: 7 }`.

Entries in tests are plain object literals typed `ExplainEntry`; the helpers are pure, so no session is needed.

## Acceptance criteria

- [ ] `RUNES` ends with `"explain"`, `TOP` ends with `"explain"`, and `DEFAULTS.enabled.explain` is `true`.
- [ ] `TEMPLATE` ends with the `explain:` block above, after `teacher:`, with its comment text byte for byte.
- [ ] `setSwitch(…, "explain", false)` edits one line and reads back as `false`, every other switch unchanged.
- [ ] `types/index.d.ts` declares `ExplainUsage`, `ExplainCheck`, `ExplainEntry`, `ExplainView` exactly as in
      `protocol.md`, and `PluginState.runes.explain: ExplainView`.
- [ ] `hooks/explain/state.ts` exports `MAX_ENTRIES`, `view`, `usageOf`, `selectedOf`, `withEntry`,
      `patchEntry` with the `protocol.md` signatures and nothing else.
- [ ] Every test listed above exists and passes; every pre-existing runes test still passes.

## Verification

- [ ] `claude plugin test packages/runes` passes.
- [ ] `claude plugin validate packages/runes` reports no problem, including the `explain` state key.
- [ ] `grep -n '"explain"' packages/runes/hooks/config.ts` shows it in both `RUNES` and `TOP`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                          | 2–3 (below bar)                                                                       | 4–5 (pass)                                                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | `explain` missing from `RUNES`/`TOP`/`TEMPLATE`, or types differ from `protocol.md` | switch works but template order, comment text or a helper edge (cap, fallback) drifts | switch, template, types and helpers match the contract byte for byte                                          |
| Test coverage           | ×2     | no new tests                                                                        | default and template tested, but read-back or a helper edge missing                   | every listed config and state test present, including cap at 12 and the fallback cases                        |
| Interface & readability | ×1     | helpers do I/O or special-case `explain` inside `normalize`/`upgrade`               | correct but extra exports or style mismatch with the file                             | pure helpers, no special cases, each file's own quote/semicolon style                                         |
| Assumptions & docs      | ×1     | relies on unstated engine behaviour silently                                        | —                                                                                     | no new comments needed; the migration path for old files is covered by the existing `upgrade` loop and tested |

## Out of scope

- Anything that reads `config.enabled.explain` (the band button, the pane, the orchestrator) — Deferred.
  Reason: those modules own their own files and import this switch and state.
- Look fields for `explain` (colours, width) — Deferred. Reason: not asked for; the section holds only `enabled`.
