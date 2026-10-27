# Shared conventions

## Repo facts

- Runtime is Bun with TypeScript, no transpile step. Use `type`, never `interface`. Take no npm dependency.
- The runes package is a Claude Code mod. Its mod code (`packages/runes/hooks/**` reached from `register.tsx`) has no `Bun` global, no Node built-ins, and reaches the system only through `$` (`$.process.run`, `$.fs`, `$.env`, `$.session`). A `bun` child spawned with `$.process.run` gets no `HOME` unless `env: { HOME }` passes it.
- Follow the style of the surrounding file: keep its semicolon and quote style, and do no reformatting of untouched lines. Write no comment unless it states a constraint from outside the codebase in one line.
- The shared contract for every file this plan adds is `schema.md` in this directory. Do not change a name, column, or signature it fixes.

## Tests

Two runners, never mixed in one file:

| Runner               | Files                                                             | Command (from the repo root)                                         |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Claude Code test kit | `packages/runes/**/*.test.ts(x)`, importing `claude-code/testing` | `claude plugin test packages/runes`                                  |
| `bun:test`           | `packages/runes/hooks/teacher/lessons-db.spec.ts` only            | `(cd packages/runes/hooks/teacher && bun test ./lessons-db.spec.ts)` |

- The kit runs only `*.test.ts(x)`, and the root `bunfig.toml` ignores `packages/runes/**`, so the `.spec.ts` name is what keeps each runner off the other's file. Never name a `bun:test` file `*.test.ts` under `packages/runes/`.
- The kit has no process, fs, env, or store. Kit tests drive `teacher` through its `Transport` fakes, as `teacher.test.ts` already does.
- Spec tests that touch a real database use a fresh `mkdtempSync(join(tmpdir(), "lessons-"))` directory and remove it in the same test file. Never touch the real `~/.local/share/q-lab/runes/`.
- Baseline before this plan: `claude plugin test packages/runes` passes 373 tests, 0 fail.

## Scratch

A smoke test that needs a temporary `HOME` uses `h=$(mktemp -d)` and removes it afterwards (`rm -rf "$h"`).

## Commits

Tasks do not commit. Autopilot lands each task.
