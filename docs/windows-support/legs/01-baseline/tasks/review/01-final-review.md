# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/ci-structure-check.md`
>
> **Depends on**: platform/02, platform/03
> **Status**: done
> **Final review**: true

## Goal

Confirm the leg's goal as a whole: every q-lab plugin loads on native Windows (Claude Code CLI and the Desktop app's Local session, with and without Git Bash) without a hook error, CI covers macOS, Linux and Windows in two tiers, and macOS and Linux users see no behaviour change.

## Files to create / modify

- None by default. Fix only integration defects this review finds, inside the files the leg already touched:
  - `.gitattributes` — the LF line-ending policy.
  - `packages/monitor/skills/cockpit/bin/hook.ts` — the platform-aware hook entry.
  - `packages/monitor/skills/cockpit/bin/hook.test.ts` — its test.
  - `packages/monitor/.claude-plugin/plugin.json` — the two cockpit hooks in exec form.
  - `.github/workflows/ci.yml` — the `required` and `report` CI jobs.
  - `README.md` — the `## Windows` section.

## Implementation notes

### What the leg should have shipped

- `.gitattributes` at the repo root holds `* text=auto eol=lf`. Every text file in the index was already LF, so it changes nothing on macOS or Linux.
- `hook.ts` runs as `bun hook.ts <event>`. On `win32` it drains stdin and exits 0 with no output. Elsewhere it spawns `<dir>/cockpit hook <event>` with stdin, stdout and stderr inherited and forwards the exit code.
- `plugin.json`'s two cockpit hooks read `{"type":"command","command":"bun","args":["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts","session-start"],"timeout":5}` and the same with `"stop"` and `"timeout":10`. The setup.ts hook (`bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --session-check`, timeout 20) is byte-identical to before.
- `ci.yml` triggers on `push` to `main`, `pull_request`, and `workflow_dispatch`. Job `required` (blocking, macOS / Ubuntu / Windows) runs `bunx --bun tsc --noEmit`, `hook.test.ts`, `cockpit.test.ts` on macOS and Linux, and a no-`\r` check on the shim on Windows. Job `report` (`continue-on-error`, all three OS) builds cockpit-rs on Ubuntu, runs `cargo check` on Windows, runs `bun test --parallel .` with a JUnit output file, writes failing tests to `$GITHUB_STEP_SUMMARY`, and uploads the JUnit file as an artifact.
- README's `## Windows` section states the support statement in `../_context/shared.md`: supported runtimes, the `bun` requirement, Git for Windows recommended with PowerShell tolerated, WSL expected to behave like Linux but not yet verified, work-in-progress status with monitor's cockpit hooks skipped on native Windows so the cockpit and usage dashboard do not work there yet, the roadmap link `docs/windows-support/WAYPOINTS.md`, and Codex / OpenCode on Windows unsupported.

### Files that must not change

- `packages/monitor/.codex-plugin/hooks.json` — Codex mirror, out of scope.
- `packages/monitor/skills/cockpit/bin/cockpit` — the POSIX shim.
- `.github/workflows/cockpit-release.yml` — the existing release workflow.
- `bunfig.toml` — its test ignores stay as they are.

### No-regression comparison on macOS

The failing set of the whole suite must not grow. Run it once at `<baseRef>` and once on the leg tree, with the same dependencies and the same cockpit binary in both. The script stops at the first setup failure, and treats a run with no Bun summary as invalid rather than as zero failures:

```bash
set -u
scratch=$(mktemp -d)
cleanup() { git worktree remove --force "$scratch/base" 2>/dev/null; }
trap cleanup EXIT
die() { echo "COMPARISON INVALID: $*"; exit 1; }
test -z "$(git diff --name-only <baseRef> -- packages/monitor/cockpit-rs)" || die "cockpit-rs changed; one binary cannot serve both runs"
cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml || die "cargo build"
bin="$PWD/packages/monitor/cockpit-rs/target/release/cockpit"
git worktree add "$scratch/base" <baseRef> || die "worktree add"
mkdir -p "$scratch/base/packages/monitor/cockpit-rs/target/release" && cp "$bin" "$scratch/base/packages/monitor/cockpit-rs/target/release/cockpit" || die "copy binary"
(cd "$scratch/base" && bun install --frozen-lockfile) || die "bun install in base"
export COCKPIT_BIN="$bin"
(cd "$scratch/base" && bun test --parallel . --reporter=junit --reporter-outfile="$scratch/base.xml" > "$scratch/base.log" 2>&1)
bun test --parallel . --reporter=junit --reporter-outfile="$scratch/leg.xml" > "$scratch/leg.log" 2>&1
for r in base leg; do
  grep -qE '^Ran [0-9]+ tests? across' "$scratch/$r.log" || die "$r run printed no summary"
  test -s "$scratch/$r.xml" || die "$r run wrote no JUnit file"
  ruby -rrexml/document -e 'REXML::Document.new(File.read(ARGV[0])).elements.each("//testcase") { |t| puts "#{t.attributes["file"]}\t#{t.attributes["classname"]} #{t.attributes["name"]}" if t.elements["failure"] || t.elements["error"] }' "$scratch/$r.xml" | sort -u > "$scratch/$r-fails.txt"
  awk 'NF==2 && ($2=="error" || $2=="errors") {n=$1} END {print n+0}' "$scratch/$r.log" > "$scratch/$r-errors.txt"
done
echo "--- only in leg:"; comm -13 "$scratch/base-fails.txt" "$scratch/leg-fails.txt"
echo "--- errors: base $(cat "$scratch/base-errors.txt"), leg $(cat "$scratch/leg-errors.txt")"
```

- Both trees hold the same binary at the default path `packages/monitor/cockpit-rs/target/release/cockpit`, and both runs export it as `COCKPIT_BIN`. The default path matters because `packages/monitor/skills/cockpit/contract/launcher.test.ts` deletes `COCKPIT_BIN` in a fresh-process case and expects the tree's own binary. The leg does not touch `packages/monitor/cockpit-rs`, so one binary is correct for both trees; the first check proves that.
- `bun install --frozen-lockfile` runs in the base worktree, because a fresh worktree has no `node_modules`.
- The failing set comes from Bun's JUnit file, one line per failing test case: its `file` attribute, a tab, then its describe path and name. The file path keeps two same-named tests in different files apart, and it is the input to the solo re-run.
- A test that fails in both runs is a known pre-existing failure, not a regression.
- **Regression rule.** Re-run every line under `only in leg` once, alone, in the leg tree: `bun test <the path before the tab>`; that test case must pass in the re-run. A line whose re-run passes is flaky: list it in the final report and drop it. A line whose re-run fails is a regression. The comparison passes when no regression remains and the leg's `error` count is no greater than the base's. The `error` count covers a test file that throws at load time, which prints no `(fail)` line (Bun prints `Unhandled error between tests` instead). The raw `fail` total is not compared, because flaky lines are dropped from the set and would otherwise count against it.
- Write the `only in leg` lines, each re-run's result, and both `error` counts into the final report.

### Fixing files other work owns

A fix this review makes inside a file the leg touched must leave that file's own checks passing. After a fix, re-run the checks for that file:

- `.gitattributes`: `test "$(cat .gitattributes)" = '* text=auto eol=lf'`; `test -z "$(git ls-files --eol | awk '$1!="i/lf" && $1!="i/-text" && $1!="i/none"')"`; `git check-attr text eol -- packages/monitor/skills/cockpit/bin/cockpit` reports `text: auto` and `eol: lf`; and in bash, `t=$(mktemp -d) && git -c core.autocrlf=true checkout-index --prefix="$t/" packages/monitor/skills/cockpit/bin/cockpit && ! grep -q $'\r' "$t/packages/monitor/skills/cockpit/bin/cockpit"` succeeds.
- `hook.ts`, `hook.test.ts`, `plugin.json`: `bun test packages/monitor/skills/cockpit/bin/hook.test.ts packages/monitor/skills/cockpit/bin/cockpit.test.ts` and `bunx --bun tsc --noEmit`.
- `ci.yml`: the structure check script in `../_context/ci-structure-check.md` prints `ok`.
- `README.md`: `grep -c '^## Windows$' README.md` prints `1`; `awk '/^## /{if($0=="## usage-dashboard")print prev; prev=$0}' README.md` prints `## Windows`; `grep -c '](./docs/windows-support/WAYPOINTS.md)' README.md` prints `1`; `git diff --numstat <baseRef> -- README.md | awk '{exit $2!=0}'` exits 0; and the section still states every point of the Windows support statement in `../_context/shared.md` with the same meaning.

### Windows checks Q performs

Q has a Windows PC. The scenarios cover the two hook shells Claude Code picks on Windows: Git Bash when Git for Windows is installed, PowerShell when it is not. Whether setting `CLAUDE_CODE_GIT_BASH_PATH` to a missing path forces PowerShell is unverified; record the answer.

A hook error from any plugin, monitor or not (guard, runes, dispatch, chronicle, relay, herdr, browsers), fails that check. It is never banked as a Known gap. Leave the item unticked and name the plugin, the hook event and the error text in the final report; Q then adds a task to this leg to fix it before the leg lands.

## Acceptance criteria

- [x] `git diff --name-only <baseRef> -- .gitattributes .github/workflows/ci.yml README.md packages/monitor/.claude-plugin/plugin.json packages/monitor/skills/cockpit/bin/hook.ts packages/monitor/skills/cockpit/bin/hook.test.ts | wc -l` prints `6`.
- [x] `git diff --name-only <baseRef> -- packages/monitor/.codex-plugin/hooks.json packages/monitor/skills/cockpit/bin/cockpit .github/workflows/cockpit-release.yml bunfig.toml` prints nothing.
- [x] `git diff <baseRef> -- packages/monitor/.claude-plugin/plugin.json | grep -E '^[-+].*(setup\.ts|"version")'` prints nothing.
- [x] The macOS no-regression comparison prints no `COMPARISON INVALID` line, every `only in leg` line passes its solo re-run (flaky, reported) or there are none, and the leg's `error` count is no greater than the base's.
- [x] (human) On Q's Windows PC with Git for Windows, Claude Code CLI with every q-lab plugin installed from this branch: start a session, send the prompt `say hi`, wait for the answer and for the turn to end — no hook error from any plugin appears. Every Windows check below uses this same prompt and pass condition.
- [x] (human) The same check in the Desktop app's Local session shows no hook error.
- [x] (human) With Git Bash unavailable (set `CLAUDE_CODE_GIT_BASH_PATH` to a missing path, or use a user or machine without Git for Windows), the CLI check shows no hook error; Q records whether the env var actually forced PowerShell.
- [x] (human) The same no-Git-Bash check in the Desktop app's Local session shows no hook error. When the env var cannot reach the Desktop app, run it on a user or machine without Git for Windows.
- [x] (human) Push the branch and open a pull request against `main` (the workflow runs on `pull_request`, not on a plain branch push). On that PR's `CI` run, job `required` is green on macOS, Ubuntu and Windows, and the job `report` step summary lists Bun's result for each OS.

## Verification

- [x] `bunx --bun tsc --noEmit` prints nothing.
- [x] `bun test packages/monitor/skills/cockpit/bin/hook.test.ts packages/monitor/skills/cockpit/bin/cockpit.test.ts` passes.
- [x] Run the no-regression comparison script above in bash; it prints no `COMPARISON INVALID` line, the regression rule holds, and `git worktree list` no longer shows the base worktree afterwards.
- [x] `git diff --name-only <baseRef> -- packages/monitor/cockpit-rs` prints nothing.

## Eval rubric

> Scale: see `../_context/rubric.md`; the final review scores its own dimensions below in place of the generic four. Each dimension 0–5; weighted average > 4.0 to pass; No regressions < 4 is an automatic veto.

| Dimension          | Weight | 0–1 (fail)                                                                                                 | 2–3 (below bar)                                                    | 4–5 (pass)                                                                                                    |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Meets the leg goal | ×3     | a Windows session still shows a hook error, or CI is missing                                               | goal met under Git Bash only, or one CI tier missing               | silent hooks under both shells, CLI and Desktop; both CI tiers on three OS                                    |
| No regressions     | ×3     | a macOS or Linux test newly fails, or a forbidden file changed                                             | no new failure, but the setup.ts hook or shim drifted cosmetically | no regression after solo re-runs, `error` count held, forbidden files untouched, setup.ts hook byte-identical |
| Integration        | ×2     | `plugin.json` points at a path `hook.ts` does not occupy, or `ci.yml` runs a test path that does not exist | pieces compose but one CI step targets a stale path                | manifest, entry, test, `.gitattributes` and `ci.yml` agree on every path and event name                       |
| Consistency        | ×1     | README contradicts the shipped behaviour                                                                   | README misses one point of the support statement                   | README, manifest and CI tell the same story                                                                   |
| Leanness           | ×1     | the leg adds a helper module, option or abstraction with one caller                                        | small surplus, such as an unused export                            | only what the requirements need; no hand-rolled version of what Bun or Actions provide                        |

## Out of scope

- Fixing any failing suite the job `report` lists — Deferred. Reason: later legs make each plugin pass on Windows.
- Porting cockpit to Windows — Deferred. Reason: later legs build the Windows binary and port process checks.
- Releasing or bumping monitor's version — Deferred. Reason: release runs later through `/chronicle:release`.
