# RELAY-01: Honest relay tests on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: relay/02
> **Status**: todo

## Goal

relay's test suite stops assuming POSIX paths and POSIX-only filesystem facts, so every relay test that fails on Windows for a test-only reason passes there, with no product code changed.

## Files to create / modify

- `packages/relay/skills/relay/scripts/relay.test.ts` (modify) — build expected paths with `join` / `dirname`.
- `packages/relay/skills/relay/scripts/shared.test.ts` (modify) — `addTimestampSuffix` expectations accept the platform separator.
- `packages/relay/skills/relay/scripts/live.test.ts` (modify) — locator fixtures built with `join` / `resolve`.
- `packages/relay/skills/relay/scripts/delegation-marker.test.ts` (modify) — unwritable-home case uses a regular file, not `/dev/null/nope`.

No other file under `packages/relay/` changes. Product files (`*.ts` that are not `*.test.ts`) stay untouched.

## Implementation notes

Line numbers are as of commit `554083d`; re-locate by the quoted content if a line moved. Inventory Part B causes 2 and 7 describe each failure; `windows.md` gives the platform facts.

### relay.test.ts (5 failures in CI)

The test deps fake `createTmpRunDir: () => "/tmp/relay/test-run"`, and the product joins file names onto it with `path.join`, so on Windows the product writes `\tmp\relay\test-run\last.md` while the test looks up `/tmp/relay/test-run/last.md`.

- Introduce one test-local constant, e.g. `const RUN_DIR = "/tmp/relay/test-run";`, used by the `createTmpRunDir` fake, and build every expected key under it with `join(RUN_DIR, "last.md")`, `join(RUN_DIR, "live-prompt.md")`, `join(RUN_DIR, "result.md")`. Hits to change (by content): `expect(result.lastMd).toBe("/tmp/relay/test-run/last.md")`, `writes.get("/tmp/relay/test-run/last.md")` (two places), `writes.get("/tmp/relay/test-run/live-prompt.md")` (two places), `toContain("/tmp/relay/test-run/result.md")`, the `"/tmp/relay/test-run/live-prompt.md"` argument, `liveOpts!.resultPath` expectation, and `guarded.indexOf("/tmp/relay/test-run/result.md")`.
- `expect(ensuredDirs).toContain(CONFIG_PATH.replace(/\/config\.json$/, ""))` → `expect(ensuredDirs).toContain(dirname(CONFIG_PATH))`.
- Leave literals that are only passed through opaque (e.g. `"/tmp/prompt.md"` fed to a fake and compared to the same string) alone: they never meet `path.join`.

### shared.test.ts (2 failures)

`addTimestampSuffix` uses `parse` + `join`, so on Windows `"dir/subdir/file.txt"` comes back `dir\subdir\file_<ts>.txt`.

- "handles nested paths": match `^dir[\\/]subdir[\\/]file_\d{8}-\d{4}\.txt$`, or compare the prefix to `join("dir", "subdir", "file_")`.
- "preserves directory structure": same treatment for `"/tmp/relay/report.md"` → prefix `join("/tmp/relay", "report_")`.

### live.test.ts (3 failures)

`resolveHerdScript` builds candidate paths with `join`, so POSIX literals in the fixtures never equal what it asks `fileExists` / `listDir` about on Windows.

- Build `SIBLING` from the fixture's `scriptDir` with `resolve(scriptDir, "../../../../herdr/skills/herdr/scripts/herd.ts")` (or whatever relative walk the product uses — read `resolveHerdScript` in `live.ts` and mirror it), and `scriptDir` / `homeDir` with `resolve("/repo/packages/relay/skills/relay/scripts")` / `resolve("/home/q")`.
- Build `claudeRoot` and `codexRoot` with `join(homeDir, ".claude", "plugins", "cache")` / `join(homeDir, ".codex", "plugins", "cache")`, and the version paths with `join` per segment.
- `"/tmp/relay/run/result.md"` literals elsewhere in this file stay unless a test fails on them; they are opaque strings the tests compare to themselves.

### delegation-marker.test.ts (1 failure)

The unwritable-home case passes `{ Q_DELEGATION_HOME: "/dev/null/nope" }` and expects `null`. On Windows `/dev/null/nope` is the writable `D:\dev\null\nope` (`windows.md`), and the CI run created it.

- Create a regular file in a `mkdtempSync(join(tmpdir(), "…"))` dir and pass `join(thatFile, "nope")` as `Q_DELEGATION_HOME`. A path under a regular file cannot be created as a directory on any OS, so the expectation `null` holds on all three.

### Environment isolation (rule 2)

At `554083d` no relay test overrides `HOME` or `TMPDIR`, and none spawns a `#!/bin/sh` stub: relay tests inject `homeDir` / `env` / `fileExists` instead. Re-check with the grep in Verification; if one appears, set `USERPROFILE` beside `HOME` and `TEMP` / `TMP` beside `TMPDIR`, and follow rule 4 for stubs. No test may read or write the real `~/.config/q-lab/cc-plugins/relay/config.json`.

### Expected state after this task

These relay failures remain on Windows by design, because they are product bugs a later task fixes: `shared.test.ts` scratch-root tests (`TMP_ROOT` literal, `createTmpRunDir` ×2), `relay-prompt.test.ts`'s `toContain("/tmp/q-lab/relay/relay/")`, and the four `backends/codex.test.ts` image-path cases. Do not touch them.

## Acceptance criteria

- [ ] `grep -n 'CONFIG_PATH.replace' packages/relay/skills/relay/scripts/relay.test.ts` prints nothing, and the file uses `dirname(CONFIG_PATH)`.
- [ ] `grep -n '"/tmp/relay/test-run/' packages/relay/skills/relay/scripts/relay.test.ts` prints at most the one line defining the run-dir constant.
- [ ] `grep -nF -e 'dir\/subdir' -e '\/tmp\/relay\/report' packages/relay/skills/relay/scripts/shared.test.ts` prints nothing (no `/`-only regexes for `addTimestampSuffix`).
- [ ] `grep -n '/dev/null' packages/relay/skills/relay/scripts/delegation-marker.test.ts` prints nothing.
- [ ] `grep -n '"/repo/packages/herdr' packages/relay/skills/relay/scripts/live.test.ts` prints nothing.
- [ ] `bun test packages/relay` passes on macOS.
- [ ] `git diff --name-only -- packages/relay` lists only `*.test.ts` files.

## Verification

- [ ] `bun test packages/relay` exits 0.
- [ ] `bunx --bun tsc --noEmit` prints nothing.
- [ ] `git diff --name-only -- packages/relay | grep -v '\.test\.ts$'` prints nothing.
- [ ] `grep -rnE 'HOME|TMPDIR|#!/bin/sh' packages/relay --include='*.test.ts'` shows no `HOME` / `TMPDIR` override without its `USERPROFILE` / `TEMP` partner, and no shebang stub.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                 | 2–3 (below bar)                                                                             | 4–5 (pass)                                                                                                      |
| ----------------------- | ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A product file changed, or a test now asserts something weaker than before | Paths fixed in some listed spots, others still POSIX literals that `path.join` output meets | Every listed failure's expectation is built the way the product builds the path; assertions as strict as before |
| Test coverage           | ×2     | A failing test was skipped or deleted                                      | Tests pass but one now passes vacuously (e.g. a fixture no longer exercised)                | Every changed test still exercises the same branch; no skip added                                               |
| Interface & readability | ×1     | Copy-pasted path strings everywhere                                        | Mixed literal and `join` styles for the same path                                           | One run-dir constant, `join` / `dirname` used consistently                                                      |
| Assumptions & docs      | ×1     | `/dev/null` trick replaced by another OS-specific path                     | Replacement works but its reason is unclear                                                 | Regular-file-as-parent trick explained by its name or a one-line comment citing the fact                        |

## Out of scope

- `TMP_ROOT` / `createTmpRunDir` / `relay-prompt` scratch-root literals — Deferred to the relay product task. Reason: the product root itself changes on win32, and the tests are rewritten against the new root there.
- `backends/codex.test.ts` image-path tests — Deferred to the relay product task. Reason: the product regex is the bug (class (a)).
- Moving opencode or codex image prompts out of argv — Deferred to the relay product task.
