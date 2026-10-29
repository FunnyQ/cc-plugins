# REVIEW-01: Final review 🏁

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: platform/02, platform/03
> **Status**: done
> **Final review**: true

## Goal

Confirm the whole leg delivers: chronicle, dispatch, guard, relay and `opencode/` pass on macOS, Linux and Windows in CI's blocking `required` job, a blocking `smoke` job proves the deterministic workflow scripts run end to end, and macOS and Linux users see no change beyond the two named ones.

## Files to create / modify

- `docs/windows-support/legs/02-core-workflow/review-notes.md` (new) — the review's findings, one section per check below, each marked PASS or FAIL with the evidence (command output or `file:line`).
- Any file under `packages/chronicle`, `packages/dispatch`, `packages/guard`, `packages/relay`, `opencode/`, `.github/`, `CLAUDE.md` or `README.md` (modify) — only to fix an integration defect this review finds. Record every such fix in `review-notes.md`.

## Implementation notes

This task reviews the leg as a whole. It does not re-score individual changes; per-change quality was gated earlier. Read the leg's full diff with `git diff <baseRef> -- packages/chronicle packages/dispatch packages/guard packages/relay opencode .github CLAUDE.md README.md`. Autopilot substitutes `<baseRef>` with the commit the run started from; earlier work is already committed, so never use `git status` to find what changed.

### What the leg must deliver

1. **Suites green, everywhere.** `bun test packages/chronicle packages/dispatch packages/guard packages/relay opencode/` passes locally (macOS). `.github/workflows/ci.yml`'s `required` job runs these five suites on `macos-latest`, `ubuntu-latest` and `windows-latest`, with no `continue-on-error` on those steps. The `report` job is unchanged; confirm `git diff <baseRef> -- .github/workflows/ci.yml` touches no line inside `report:`.
2. **Smoke job.** `ci.yml` has a blocking `smoke` job on all three OS that runs `bun .github/scripts/smoke.ts`. That script, on a temp repo under `tmpdir()`, runs: chronicle commit (`commit.ts apply` with a plan file), chronicle release in local mode, flightplan `scaffold.ts` + `lint-task.ts`, dispatch `worktree.ts` create then land, and guard's comment sweep (`comment-sweep.ts snapshot` then `sweep`). It needs no network and no model call, and it exits non-zero when any step fails.
3. **No test touches the real user profile.** Every test that overrides `HOME` also sets `USERPROFILE`; every test that overrides `TMPDIR` also sets `TEMP` and `TMP` (shared.md rule 2).
4. **macOS and Linux unchanged.** The scratch root stays `/tmp/q-lab/<plugin>/…` byte for byte off win32. The only behaviour change there is the WSL URL opener (rule 5) and dispatch's worktree tooling pinning `-c core.autocrlf=false` (rule 7).

### Consistency checks

- **Every inventory (a) item is fixed with a test.** Walk each row classed **(a)** in `inventory.md` (Part A, Part B and "Found after the inventory") and name, in `review-notes.md`, the product change and the test that fails without it. Rows: dispatch task-path regex and `inferRefFromPath`; worktree `registeredPaths`, `seedIgnored` cp fallback, junction link, autocrlf pin; the four scratch roots; chronicle `insideRepo`; guard ledger key identity; relay codex image-path regex; `archive-stale.ts` gitignore pattern; opencode `FLIGHTPLAN_TASK`; relay opencode backend argv; dispatch `opencode-run.ts` argv; relay codex image argv; `gate-page.ts` opener; `launch.ts` WSL branch; guard `isGuardedPath`.
- **Every win32 skip is class (c) and names its fact.** Each `skipIf(process.platform === "win32")` sits on a case `inventory.md` or `windows.md` classes **(c)** (NTFS-forbidden file names, `chmod` on NTFS, the POSIX cockpit shim, the `cp` PATH stub), or is chronicle's release git-shim test skipped because a `.cmd` shim cannot carry a cmd-special argument (`windows.md`, Processes), and its test title or a one-line comment names the fact. No skip stands in for an (a) or (b) fix.
- **The four scratch-root copies agree in shape.** chronicle `temp-payload.ts`, relay `shared.ts`, guard `scan.ts` and guard `ledger.ts` each take the platform as an injectable parameter, return `join(tmpdir(), "q-lab", <plugin>, …)` on win32 and the original `/tmp/q-lab/…` string elsewhere, and each has a test asserting both values.
- **The three task-path regex copies agree.** `packages/dispatch/hooks/task-path.ts`, `packages/dispatch/hooks/flightplan-lint.sh` and `opencode/plugin.ts` (`FLIGHTPLAN_TASK`) accept `[\\/]`, and `packages/dispatch/hooks/task-path.test.ts` passes.
- **Plugin boundaries hold.** No file under one `packages/<plugin>/` imports from another plugin. `opencode/plugin.ts` imports nothing from the repo (only Node/Bun built-ins).
- **No prompt in argv.** relay's opencode backend, dispatch's `opencode-run.ts` and relay's codex image mode send the prompt on stdin or, for opencode when the stdin probe failed, in an `-f` file with the fixed message `Follow the instructions in the attached file.` Each has a test passing a prompt with `"`, `%`, `&` and a newline.
- **Path identity.** Every identity comparison the leg added uses the shared.md rule 3 normaliser (nearest existing ancestor through `realpathSync.native`, lower-cased on win32) and never throws on a missing path.
- **Docs.** CLAUDE.md's scratch-path convention carries its Windows clause; README's `## Windows` names what works now and what is owed.

Fix an integration defect in place when the fix is small and local; record it. When a fix would be a feature-sized change, record it as FAIL with the reason instead.

## Acceptance criteria

- [x] `docs/windows-support/legs/02-core-workflow/review-notes.md` exists and has a PASS/FAIL line with evidence for each of: suites green, smoke job, profile isolation, macOS/Linux unchanged, inventory (a) items, win32 skips, scratch-root copies, task-path regex copies, plugin boundaries, no prompt in argv, path identity, docs.
- [x] `docs/windows-support/legs/02-core-workflow/review-notes.md` lists every inventory (a) row with its product change and its test name.
- [x] `.github/workflows/ci.yml` `required` job runs the five suites on all three OS, and a `smoke` job runs `bun .github/scripts/smoke.ts` on all three OS, neither with `continue-on-error`.
- [x] `git diff <baseRef> -- .github/workflows/ci.yml` changes no line in the `report` job.
- [x] Every `skipIf(process.platform === "win32")` in the five suites carries its Windows fact in the test title or a one-line comment.
- [x] (human) The leg's PR CI run is green on `windows-latest` for both `required` and `smoke`.
- [x] (human) On a real Windows PC, in a fresh `git init` repo with one new file `hello.ts` holding `export const hi = 1;` plus a 3-line `//` comment block: `/chronicle:commit` lands one commit containing `hello.ts`; the guard turn-end reviewer reports that comment block; `/chronicle:release local` on a one-component `.chronicle/release.json` bumps the version file and creates a local tag (`git tag` lists it); `/dispatch:flightplan` for "add a `bye` export to hello.ts" writes a `docs/<slug>/tasks/` tree that `lint-task.ts` passes, and `/autopilot` on it lands a commit adding `bye`. Record each result in `docs/windows-support/legs/02-core-workflow/review-notes.md`.
- [x] (human) On a real Windows PC, ask Claude Code to Write `/tmp/q-lab/probe/write.txt` with the content `probe`, then run `Get-ChildItem -Recurse -Filter write.txt C:\tmp, $env:TEMP` in PowerShell and record the full path that holds it (or that none does) in `docs/windows-support/legs/02-core-workflow/review-notes.md`.
- [x] (human) On WSL, from the repo root, run `bun -e 'import { openerCommands } from "./packages/dispatch/skills/autopilot/scripts/launch.ts"; for (const c of openerCommands("https://example.com")) { try { const r = Bun.spawnSync(c); if (r.exitCode === 0) { console.log("opened via", c[0]); break; } } catch {} }'` (the import is safe: `launch.ts` runs its CLI only under `import.meta.main`). This exercises the opener argv list; `openBrowser`'s own fallback loop is covered by its unit test. With `wslu` installed it prints `opened via wslview` and the Windows browser shows example.com; after `sudo apt remove wslu`, it prints `opened via cmd.exe` and the browser shows it again. Record both outputs in `docs/windows-support/legs/02-core-workflow/review-notes.md`.

## Verification

- [x] `bunx --bun tsc --noEmit` prints nothing.
- [x] `bun test packages/chronicle packages/dispatch packages/guard packages/relay opencode/` passes.
- [x] `bun .github/scripts/smoke.ts` exits 0.
- [x] `git diff --name-only <baseRef> -- packages/chronicle packages/dispatch packages/guard packages/relay opencode .github CLAUDE.md README.md` lists changes in every one of those paths.
- [x] `grep -rn 'skipIf(process.platform === "win32")' packages/chronicle packages/dispatch packages/guard packages/relay opencode` — each hit is a class (c) case per `inventory.md`, or the chronicle release git-shim exception citing the `.cmd` argument fact from `windows.md`, noted in `docs/windows-support/legs/02-core-workflow/review-notes.md`.
- [x] `grep -rn '"/tmp/q-lab' packages/chronicle packages/guard packages/relay --include=*.ts` — every non-test hit sits in the non-win32 branch of a platform-parameterised scratch root.
- [x] `grep -rnE "from \"\.\./\.\./\.\./(chronicle|dispatch|guard|relay|monitor|herdr|browsers|runes)/" packages` prints nothing, and `grep -nE '^import .* from "\.' opencode/plugin.ts` prints nothing.
- [x] `bun test packages/dispatch/hooks/task-path.test.ts` passes.

## Eval rubric

> Integration dimensions replace the shared four (see `../_context/rubric.md` for the scale). Each dimension 0–5; weighted average > 4.0 to pass; Meets the leg goal < 4 is an automatic veto.

| Dimension                 | Weight | 0–1 (fail)                                                                                                                                                                                                                                                                          | 2–3 (below bar)                                                                                       | 4–5 (pass)                                                                                                            |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Meets the leg goal        | ×3     | A suite is not in `required`, the smoke job is missing, or an inventory (a) item has no fix                                                                                                                                                                                         | Suites and smoke are wired but an (a) item lacks a test, or the smoke script skips a named flow       | All five suites block on three OS, smoke covers all five flows, every (a) item has a fix and a test                   |
| No regressions            | ×2     | macOS/Linux scratch root or opener changed, or the local suite fails                                                                                                                                                                                                                | Local suite passes but a test still writes the real profile or an unnamed behaviour changed off win32 | macOS/Linux behaviour unchanged beyond the WSL opener and autocrlf pin; no test touches the real profile              |
| Integration & consistency | ×2     | Regex copies disagree, a cross-plugin import exists, or `opencode/plugin.ts` imports from the repo                                                                                                                                                                                  | Scratch-root copies differ in shape, or a skip names no fact                                          | Scratch roots, regex copies, normalisers and openers agree in shape; boundaries hold; every skip is (c) with its fact |
| Leanness                  | ×1     | A cross-plugin shared helper, a config switch nobody sets, or an abstraction with no current caller or test need was added (the pure platform-injection seams the tasks specify — `tempRoot`, `codexHome`, `linkType`, `openerCommands` and the like — are expected, not penalised) | Some per-plugin copies carry options nobody passes                                                    | Each plugin carries the smallest copy it needs; stdlib (`path`, `fs.cpSync`, `os.tmpdir`) used over hand-rolled code  |

## Out of scope

- monitor, herdr, browsers and runes suites — Deferred. Reason: later legs own them; they stay in the `report` job.
- Agent prompts that name `/tmp/q-lab/...` — Deferred. Reason: their Windows behaviour depends on the human check above.
- Bypassing the opencode `.cmd` shim for an `-f` path holding `&` or `%` — Deferred. Reason: banked as a known gap; it applies only when the stdin probe fails.
- Version bumps and releases — Deferred. Reason: no release in this leg.
