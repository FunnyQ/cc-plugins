# CHRONICLE-03: Codex home fallback on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/rubric.md`
>
> **Depends on**: chronicle/01
> **Blocks**: platform/02
> **Status**: done

## Goal

`setup-codex-agents.ts` finds the user's `~/.codex` on native Windows when `CODEX_HOME` is unset, instead of writing the Codex agent roles into a `.codex` folder under the current directory.

## Files to create / modify

- `packages/chronicle/skills/install/scripts/setup-codex-agents.ts` (modify) — export a pure `codexHome(env, home)` resolver that falls back to `os.homedir()` instead of `process.env.HOME`.
- `packages/chronicle/skills/install/scripts/setup-codex-agents.test.ts` (modify) — a test for the fallback.

## Implementation notes

Current code (`main`, around line 89):

```ts
const codexHome =
  process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
```

PowerShell and cmd do not set `HOME` on native Windows, so `join("", ".codex")` is the relative path `.codex`, and `--apply` writes the role files and `config.toml` into whatever directory the command ran from. `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere (`windows.md`, Environment), so it is correct on every OS.

Change it to a pure exported resolver, so the `HOME`-unset case is testable without touching any real profile:

```ts
import { homedir } from "node:os";

export function codexHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.CODEX_HOME || join(home, ".codex");
}
```

`main` calls `codexHome()`. The default `home` is `homedir()`, never `env.HOME`.

Keep `CODEX_HOME` first; it is Codex's own override.

Test first, in `setup-codex-agents.test.ts`:

- Unit-test `codexHome`: `codexHome({ CODEX_HOME: "/x" }, "/h")` is `"/x"`; `codexHome({}, "/h")` is `join("/h", ".codex")`; `codexHome({ HOME: "/wrong" }, "/h")` is `join("/h", ".codex")`, which proves `HOME` is no longer read. The last case fails against a resolver written the old way; state that in the report.
- Spawn test: run the script with `--dry-run`, `CODEX_HOME` deleted from the env, `HOME` and `USERPROFILE` both set to one fresh `mkdtempSync(join(tmpdir(), …))` directory, and `cwd` set to a second temp directory. Parse the path the dry run prints (read `main` first for its exact output, e.g. a `config_file` line) and assert it sits under `join(profileDir, ".codex")`. This exercises `homedir()` through the env on both macOS and Windows.
- Never spawn with `HOME` removed: on macOS `homedir()` then falls back to the real account, and the script reads `~/.codex/config.toml` even under `--dry-run` (shared.md rule 2).

## Acceptance criteria

- [x] `setup-codex-agents.ts` contains no `process.env.HOME`.
- [x] `codexHome({ HOME: "/wrong" }, "/h")` returns `join("/h", ".codex")`, and with `CODEX_HOME` unset the dry run prints a path under the isolated profile's `.codex`.
- [x] `CODEX_HOME`, when set, still wins.
- [x] The new test sets `HOME` and `USERPROFILE` together and never touches the real profile.

## Verification

- [x] `rg -n 'process\.env\.HOME' packages/chronicle/skills/install/scripts/setup-codex-agents.ts` prints nothing.
- [x] `bun test packages/chronicle/skills/install/scripts/setup-codex-agents.test.ts` passes.
- [x] `bun test packages/chronicle` passes.
- [x] `bunx --bun tsc --noEmit` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                         | 2–3 (below bar)                                                | 4–5 (pass)                                                       |
| ----------------------- | ------ | -------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Correctness             | ×3     | still reads `HOME`, or `CODEX_HOME` no longer wins | `homedir()` used but the relative-path case is still reachable | `CODEX_HOME` → `homedir()` on every OS; nothing lands in cwd     |
| Test coverage           | ×2     | no new test                                        | test passes but could not catch a cwd write                    | test asserts the profile path and the absence of `.codex` in cwd |
| Interface & readability | ×1     | resolver missing, or more than one new function or option | resolver exists but `main` still computes the path inline, or `home` is not injectable | one pure exported `codexHome(env, home)` that `main` calls; no other new layer |
| Assumptions & docs      | ×1     | Windows `HOME` behaviour assumed without source    | right but unexplained in the report                            | report cites `windows.md`'s `homedir()` fact                     |

## Out of scope

- Other `HOME` reads in chronicle (`cockpit-trail.ts`, `analyze-changes.ts`, `archive-stale.ts`) — Deferred. Reason: they go through `os.homedir()` already, or belong to cockpit, which has no Windows build in this leg.
