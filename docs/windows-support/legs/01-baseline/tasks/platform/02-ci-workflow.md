# PLATFORM-02: CI workflow

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/ci-structure-check.md`
>
> **Depends on**: platform/01, monitor/01
> **Blocks**: review/01
> **Status**: todo

## Goal

`.github/workflows/ci.yml` runs on macos-latest, ubuntu-latest and windows-latest. It has a blocking `required` tier for what this leg touches, and a `report` tier that lists every failing test without failing the run.

## Files to create / modify

- `.github/workflows/ci.yml` (new) — the cross-OS CI workflow.

Leave `.github/workflows/cockpit-release.yml` unchanged.

## Implementation notes

The repo root has a `bun.lock`, so use `bun install --frozen-lockfile`. The only runtime dependency is `@modelcontextprotocol/sdk`, and `@types/bun` is the only dev dependency.

These test files already exist when this task starts:

- `packages/monitor/skills/cockpit/bin/hook.test.ts`, the platform-aware hook entry's test. It runs on every OS.
- `packages/monitor/skills/cockpit/bin/cockpit.test.ts`, the shim's test. It runs only on POSIX.
- `.gitattributes`, which pins text files to LF. The Windows no-CR check depends on it.

### Workflow shape

- `name: CI`.
- Triggers: `push` with `branches: [main]`, `pull_request`, and `workflow_dispatch`.
- `permissions: contents: read`.
- Set `defaults.run.shell: bash` at the workflow level, so every `run` step uses bash. GitHub's Windows runners ship Git Bash.
- Pin the actions exactly as `_context/shared.md` lists them:
  - `actions/checkout@v4`
  - `oven-sh/setup-bun@v2` with `bun-version: 1.4.4`
  - `dtolnay/rust-toolchain@stable`
  - `Swatinem/rust-cache@v2` with `workspaces: packages/monitor/cockpit-rs`
  - `actions/upload-artifact@v4`
- Set `strategy.fail-fast: false` on both jobs. Each job uses the matrix `os: [macos-latest, ubuntu-latest, windows-latest]` and `runs-on: ${{ matrix.os }}`.

### `required` job (blocking)

Run these steps in order:

1. Run `actions/checkout@v4`.
2. Run `oven-sh/setup-bun@v2` with `bun-version: 1.4.4`.
3. Run `bun install --frozen-lockfile`.
4. Run `bunx --bun tsc --noEmit`.
5. Run `bun test packages/monitor/skills/cockpit/bin/hook.test.ts`.
6. Run `bun test packages/monitor/skills/cockpit/bin/cockpit.test.ts` when `runner.os != 'Windows'`.
7. When `runner.os == 'Windows'`, assert that the checked-out shim has no CR: `! grep -q $'\r' packages/monitor/skills/cockpit/bin/cockpit`.

Leave `continue-on-error` off this job.

### `report` job (advisory)

Set `continue-on-error: true` at the job level. Then run these steps:

1. Run checkout and setup-bun as in the `required` job, then `bun install --frozen-lockfile`.
2. Set up Rust where it is used:
   - When `runner.os != 'macOS'`, run `dtolnay/rust-toolchain@stable` and `Swatinem/rust-cache@v2` with `workspaces: packages/monitor/cockpit-rs`.
   - Skip Rust on macOS.
3. On Linux (`runner.os == 'Linux'`), run `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml` with step-level `continue-on-error: true`, so a build failure still lets the suite run and list what fails. The contract suites then find `target/release/cockpit`.
4. On Windows (`runner.os == 'Windows'`), run `cargo check --manifest-path packages/monitor/cockpit-rs/Cargo.toml`. Give this step its own `continue-on-error: true`, because cockpit-rs does not compile on Windows yet.
5. Run the whole suite, keep the log, and record Bun's exit status. GitHub runs `shell: bash` as `bash -eo pipefail`, so turn `-e` off for this step:
   ```bash
   set +e
   bun test --parallel . --reporter=junit --reporter-outfile=junit-${{ matrix.os }}.xml 2>&1 | tee bun-test.log
   echo "${PIPESTATUS[0]}" > bun-test.exit
   exit 0
   ```
6. Write the summary with `if: always()`. A test file that throws at load time prints no `(fail)` line: Bun 1.4.4 prints `Unhandled error between tests` and counts it in an `N error` summary line. So write `no failures` only when Bun exited 0, and otherwise list the `(fail)` lines, the `fail` / `error` totals, and each unhandled error with the lines after it:
   ```bash
   set +e
   code=$(cat bun-test.exit 2>/dev/null || echo missing)
   {
     echo "## bun test — ${{ matrix.os }} (exit $code)"
     if [ "$code" = 0 ]; then
       echo "no failures"
     else
       grep '(fail)' bun-test.log
       grep -E '^ *[0-9]+ (fail|errors?)$' bun-test.log
       grep -A4 'Unhandled error' bun-test.log | head -200
     fi
   } >> "$GITHUB_STEP_SUMMARY"
   exit 0
   ```
7. Upload `junit-${{ matrix.os }}.xml` and `bun-test.log` with `actions/upload-artifact@v4`. Use `if: always()`, `name: bun-test-${{ matrix.os }}`, and `if-no-files-found: warn`.

### Verify the junit reporter keeps console output

Before you commit to step 5, check that bun 1.4.4 still prints `(fail)` lines to the console when `--reporter=junit` is set. Run:

```bash
bun test --reporter=junit --reporter-outfile=/tmp/x.xml packages/monitor/skills/cockpit/bin/hook.test.ts
```

A clean pass prints only `(pass)` lines. To see a `(fail)` line, run the same command against a throwaway failing test under `/tmp`, and delete it afterwards.

If the junit reporter suppresses console output, split step 5 into two runs:

- `bun test --parallel . 2>&1 | tee bun-test.log` followed by `echo "${PIPESTATUS[0]}" > bun-test.exit`, for the log and the exit status.
- `bun test --parallel . --reporter=junit --reporter-outfile=junit-${{ matrix.os }}.xml`, for the artifact.

Keep `set +e` and the closing `exit 0` in that step either way.

Record which form you used in a one-line YAML comment above the step. Such a comment is allowed because it records a constraint from outside this codebase.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists and parses as YAML.
- [ ] Both jobs use the matrix `macos-latest`, `ubuntu-latest`, `windows-latest` with `fail-fast: false`.
- [ ] The `required` job runs `bunx --bun tsc --noEmit` and `bun test packages/monitor/skills/cockpit/bin/hook.test.ts` on every OS. It runs `cockpit.test.ts` on non-Windows only, and the no-CR `grep` on Windows only.
- [ ] The `report` job has `continue-on-error: true` at the job level. Its suite step cannot fail: it runs under `set +e` and ends with `exit 0`.
- [ ] Rust runs as `cargo build --release` on Linux and as a step-level `continue-on-error` `cargo check` on Windows. macOS runs no Rust.
- [ ] The summary step writes a heading naming the OS and Bun's exit status. It writes `no failures` only when Bun exited 0; otherwise it lists the `(fail)` lines, the `fail` / `error` totals and any `Unhandled error`. The upload step runs with `if: always()`.
- [ ] `git diff --quiet -- .github/workflows/cockpit-release.yml` exits 0.
- [ ] (human) Push the branch and open a pull request against `main` (a plain branch push does not trigger this workflow). On that PR's `CI` run, `required` is green on all three OS and the `report` job's step summary shows Bun's result per OS. The closing review may own this live check.

## Verification

- [ ] `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml")'` exits 0.
- [ ] The structure check script in `../_context/ci-structure-check.md` prints `ok` and exits 0.
- [ ] `git diff --quiet -- .github/workflows/cockpit-release.yml` exits 0.
- [ ] When `command -v actionlint` succeeds, `actionlint .github/workflows/ci.yml` exits 0. Skip this item when actionlint is not installed; the structure check then still covers the shape, but expression syntax inside `${{ }}` stays unchecked until the first push.
- [ ] `bun test packages/monitor/skills/cockpit/bin/hook.test.ts` passes locally. This is the same test the required tier runs.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                     | 2–3 (below bar)                                                                  | 4–5 (pass)                                                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Correctness             | ×3     | a required step is missing, runs on the wrong OS, or `report` can fail the run | right steps, but OS conditions or `fail-fast` drift, or the summary misses an OS | every step runs on exactly the OS named; `report` never fails the run; `cockpit-release.yml` untouched |
| Test coverage           | ×2     | no blocking test step                                                          | blocking tier misses `tsc` or a named test file                                  | blocking tier runs `tsc`, `hook.test.ts` on all OS, `cockpit.test.ts` on POSIX, no-CR check on Windows |
| Interface & readability | ×1     | duplicated, tangled YAML                                                       | readable but carries unused steps or inputs                                      | plain two-job file, workflow-level bash default, no step without a current use                         |
| Assumptions & docs      | ×1     | junit console behaviour assumed untested                                       | checked but the fallback is unrecorded                                           | junit console behaviour verified locally; the chosen form noted in one line                            |

## Out of scope

- Running `claude plugin test` mod suites in CI — Deferred. Reason: they need the Claude CLI and the leg excludes them.
- Fixing any failure the `report` tier lists — Deferred. Reason: later legs fix each plugin and promote its suites to blocking.
- A Windows release target for cockpit — Deferred. Reason: the cockpit port is later work; this leg only runs `cargo check`.
- Making the `report` tier blocking — Deferred. Reason: most suites still fail on Windows today.
