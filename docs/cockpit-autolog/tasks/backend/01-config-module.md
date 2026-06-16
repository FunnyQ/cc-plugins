# BACKEND-01: Global log_language config module

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: backend/02, skills/01, skills/02
> **Status**: done

## Goal

A standalone `config.ts` module that reads/writes the only surviving cockpit setting,
`log_language`, in a global JSON file at `~/.config/q-lab/cockpit/config.json`.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/config.ts` (new) — the config module.
- `packages/monitor/skills/cockpit/scripts/config.test.ts` (new) — unit tests.

## Implementation notes

Use only Node/Bun built-ins (`node:os`, `node:path`, `node:fs`). Prefer `type` over
`interface`. The path honors `XDG_CONFIG_HOME` but is otherwise a fixed location — note in
a comment that this deliberately deviates from the repo's `~/.cockpit` / `COCKPIT_HOME`
house style (owner's explicit choice).

Export this surface exactly:

```ts
export type CockpitConfig = { log_language?: string };

// ~/.config/q-lab/cockpit/config.json, honoring XDG_CONFIG_HOME.
export function configPath(): string;

// Parse the config; return {} if the file is absent or unparseable (never throws).
export function readConfig(): CockpitConfig;

// Resolved language for decision-log entries. Trims; falls back to "English"
// when unset/blank. This is the single resolution point — no per-project override.
export function getLanguage(): string;

// Persist log_language, creating the directory tree as needed. Preserves any other
// keys already in the file (read-merge-write).
export function setLanguage(language: string): void;
```

Behavioral contract:

- `getLanguage()` returns `"English"` when the file is missing, the key is absent, or the
  value is blank/whitespace.
- `readConfig()` and `getLanguage()` **never throw** — a malformed/unwritable file degrades
  to `{}` / `"English"`.
- `setLanguage()` does `mkdirSync(dirname(configPath()), { recursive: true })` then writes
  pretty JSON (`JSON.stringify(cfg, null, 2) + "\n"`), merging onto `readConfig()`.

### Testing

Drive the path via `XDG_CONFIG_HOME` pointed at a `mkdtemp` dir so tests never touch the
real `~/.config`. Restore the env var in a `finally`/`afterEach`.

## Acceptance criteria

- [x] `config.ts` exports `configPath`, `readConfig`, `getLanguage`, `setLanguage` with the signatures above.
- [x] `configPath()` returns `<XDG_CONFIG_HOME or ~/.config>/q-lab/cockpit/config.json`.
- [x] `getLanguage()` returns `"English"` when unset/blank and the stored value otherwise.
- [x] `setLanguage()` creates the directory tree and preserves unrelated keys (read-merge-write).
- [x] `readConfig()`/`getLanguage()` return defaults (not throw) on a missing or corrupt file.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/config.test.ts` passes.
- [x] Manual: `XDG_CONFIG_HOME=$(mktemp -d) bun packages/monitor/skills/cockpit/scripts/config.ts` (if a CLI shim is added) or a one-off `bun -e` importing `setLanguage`/`getLanguage` round-trips a value.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong path or throws on missing file | round-trips but default/edge cases drift | exact path, never throws, English fallback + key-merge correct |
| Test coverage | ×2 | no tests | only happy round-trip | covers missing/corrupt/blank + merge + XDG override |
| Interface & readability | ×1 | side-effects tangled, unclear types | usable but unclear | pure read fns, clear `type`s, single resolution point |
| Assumptions & docs | ×1 | path divergence unexplained | partial note | comment flags the XDG/house-style deviation |

## Out of scope

- The `cockpit config` CLI subcommand — Deferred to the next backend task (this is the module only).
