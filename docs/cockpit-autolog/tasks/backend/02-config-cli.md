# BACKEND-02: `cockpit config` CLI subcommand

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: backend/01
> **Blocks**: backend/03, skills/01, skills/02
> **Status**: done

## Goal

A `config` subcommand on the cockpit CLI that sets and reads the global `log_language`, so
skills resolve language via `cockpit config get-language` instead of grepping a file.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit.ts` (modify) — add `cmdConfig` + route it.
- `packages/monitor/skills/cockpit/scripts/cockpit.test.ts` (modify) — add config CLI tests.

## Implementation notes

Import from the sibling config module (created earlier in this bucket):

```ts
import { getLanguage, setLanguage } from "./config";
```

Add a `cmdConfig(args)` and wire a `case "config":` into the subcommand switch in `main()`
(the switch currently handles `start | log | scribe | wait | send` near the bottom of the
file). Two forms:

- `cockpit config --log-language "<lang>"` → `setLanguage(lang)`, then print a confirmation
  like `cockpit: log_language = <lang>`.
- `cockpit config get-language` → print exactly `getLanguage()` (single line, no decoration)
  so callers can capture it with `$(...)`.

`get-language` is a positional token (not a flag). Treat `args` the same way other
subcommands parse positionals/flags in this file. If neither form is given, print a short
usage line to stderr and exit non-zero.

`get-language` must emit **only** the language string on stdout (no prefix), because
`scribe.md` / `pilot.md` capture it via command substitution.

### Testing

In `cockpit.test.ts`, point `XDG_CONFIG_HOME` at a temp dir, then run the CLI entry (the
tests already spawn/`run` the CLI for other subcommands — mirror that). Assert:
- `config --log-language zh-TW` writes, and a subsequent `config get-language` prints
  `zh-TW` and nothing else.
- `config get-language` with no config prints `English`.

## Acceptance criteria

- [x] `cockpit config --log-language "<lang>"` persists the language via the config module.
- [x] `cockpit config get-language` prints only the resolved language on stdout.
- [x] With no config file, `cockpit config get-language` prints `English`.
- [x] Invalid/empty invocation exits non-zero with a usage message on stderr.
- [x] The `config` case is wired into the `main()` subcommand switch.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/cockpit.test.ts` passes.
- [x] Manual: `D=$(mktemp -d); XDG_CONFIG_HOME=$D bun packages/monitor/skills/cockpit/scripts/cockpit.ts config --log-language zh-TW && XDG_CONFIG_HOME=$D bun packages/monitor/skills/cockpit/scripts/cockpit.ts config get-language` prints `zh-TW`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong output or not routed | sets/gets but get-language is decorated | both forms work; get-language is bare stdout; bad input exits non-zero |
| Test coverage | ×2 | no tests | only set+get happy path | covers default English + bare-stdout + bad input |
| Interface & readability | ×1 | ad-hoc parsing inconsistent with file | usable | matches existing subcommand parsing style |
| Assumptions & docs | ×1 | silent behavior | partial | usage message + comment on bare-stdout contract |

## Out of scope

- Removing goal/start machinery — Deferred to the kernel-strip task in this bucket.
