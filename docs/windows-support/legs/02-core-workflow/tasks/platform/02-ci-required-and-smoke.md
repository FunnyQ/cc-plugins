# PLATFORM-02: CI required suites and smoke job

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/rubric.md`
>
> **Depends on**: chronicle/02, chronicle/03, dispatch/03, guard/02, relay/02, platform/01
> **Blocks**: review/01
> **Status**: todo

## Goal

CI blocks a merge when the chronicle, dispatch, guard, relay or `opencode/` suite fails on any of macOS, Ubuntu or Windows, and when the deterministic workflow scripts (commit, release, flightplan scaffold + lint, worktree create + land, comment sweep) fail end to end on a temp repo on any of the three.

## Files to create / modify

- `.github/workflows/ci.yml` (modify) — add five suite steps to `required`; add a blocking `smoke` job. Leave `report` byte-for-byte unchanged.
- `.github/scripts/smoke.ts` (new) — one plain Bun script that drives the five flows on a temp repo, no network, no LLM.
- `tsconfig.json` (modify) — add `.github/scripts/**/*.ts` to `include`, so the root typecheck covers the smoke script.

## Implementation notes

### ci.yml as it stands

The workflow has top-level `env: BUN_VERSION: 1.4.4`, `defaults.run.shell: bash` (Git Bash on Windows), and two jobs, each on `matrix.os: [macos-latest, ubuntu-latest, windows-latest]` with `fail-fast: false`:

- `required` — checkout, `oven-sh/setup-bun@v2` with `bun-version: ${{ env.BUN_VERSION }}`, `bun install --frozen-lockfile`, `bunx --bun tsc --noEmit`, the cockpit `hook.test.ts`, a macOS cargo build, the non-Windows `cockpit.test.ts`, and a Windows CRLF check on the cockpit shim.
- `report` — `continue-on-error: true`, runs the whole repo with `--reporter=junit` and uploads the artifact. Do not touch it.

### `required` job additions

Append five steps after the existing ones, one per suite, so a red step names its suite in the Actions UI. No `if:` — they run on all three OS:

```yaml
- run: bun test packages/chronicle
- run: bun test packages/dispatch
- run: bun test packages/guard
- run: bun test packages/relay
- run: bun test opencode/
```

### New `smoke` job

A sibling of `required`, blocking (no `continue-on-error`):

```yaml
smoke:
  strategy:
    fail-fast: false
    matrix:
      os: [macos-latest, ubuntu-latest, windows-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: ${{ env.BUN_VERSION }}
    - run: bun install --frozen-lockfile
    - run: bun .github/scripts/smoke.ts
```

### `.github/scripts/smoke.ts`: shape

- One file, top to bottom, no test framework, no new dependency. `type` over `interface`.
- Resolve the repo root as `join(import.meta.dir, "..", "..")`, never `new URL(...).pathname` (`windows.md`: that yields `/D:/a/...`, which `bun` cannot load).
- Spawn every CLI as `Bun.spawnSync([process.execPath, <script>, ...args], { cwd, env, stdin? })`. Never spawn an extensionless script. Never put free text in argv.
- Build `env` as `process.env` with `TYPESAFE_API_KEY` deleted, so no step calls TypeSafe's Jev over the network.
- Make one parent with `mkdtempSync(join(tmpdir(), "q-lab-smoke-"))` and create the repo at `<parent>/repo`. dispatch's worktree tool puts worktrees in a sibling directory (`<parent>/.repo-autopilot/<slug>/…`), so a dedicated parent keeps them inside the temp tree. Put files that must sit outside the repo, such as the commit plan, in `<parent>/out`.
- Wrap each step in a helper `step(name: string, fn: () => void)`. On success it prints `ok <name>`. On failure it throws an `Error` whose message starts `FAIL <name>:` and carries the child's stdout and stderr. The top level catches it, prints the message to stderr, and sets `process.exitCode = 1`; never call `process.exit()` inside a step, because it skips the `finally`. In that `finally`, delete `<parent>` with `rmSync(parent, { recursive: true, force: true })` and remove the sweep step's per-session state with guard's own `clearBaseline(sessionId)` and `clearReported(sessionId)` (read `packages/guard/hooks/sweep-state.ts` for their exact names and signatures), on success and on failure.
- Set up the repo with git only. Give every `git` call its own `-C <repo>`.
  1. `git init -q -b main`
  2. `git config core.autocrlf false`
  3. `git config user.name smoke`
  4. `git config user.email smoke@example.invalid`
  5. `git config commit.gpgsign false`
  6. `git config tag.gpgsign false`
  7. Write the starting files listed below, then `git add -A` and `git commit -qm init`.
- Write the starting files with `writeFileSync`, all LF:
  - `VERSION` holds `0.1.0\n`.
  - `.chronicle/release.json` holds the whole-repo config below.
  - `CHANGELOG.md` holds `# Changelog\n`.

The CLIs the script drives, with their real invocations:

| Script              | Path from repo root                                        | Invocation                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| flightplan scaffold | `packages/dispatch/skills/flightplan/scripts/scaffold.ts`  | `scaffold.ts <slug> <bucket>[,<bucket>…] [--docs-root <path>]`; prints `Scaffolded <abs root>`                                                                                                                                                                             |
| lint-task           | `packages/dispatch/skills/flightplan/scripts/lint-task.ts` | `lint-task.ts <tasks-dir>`; exit 0 when clean, violations on stderr                                                                                                                                                                                                        |
| worktree            | `packages/dispatch/skills/flightplan/scripts/worktree.ts`  | `worktree.ts <create\|land\|fingerprint\|remove\|…> [<ref>] --repo <abs> --slug <name> [--plan-dir <path>] [--op <id>] [--expect <fingerprint>]`; prints one JSON line; exit 2 = bad arguments, 1 = failure                                                                |
| chronicle commit    | `packages/chronicle/skills/commit/scripts/commit.ts`       | `commit.ts apply --plan-file <path>`; prints JSON `{ ok, shape, … }`; exit 0 done, 2 refused, 3 landed incompletely; it `chdir`s to `git rev-parse --show-toplevel` of its cwd and **refuses a plan file inside the repo**                                                 |
| chronicle release   | `packages/chronicle/skills/release/scripts/release.ts`     | `release.ts run --units '<json>' --through <stage>`; reads `.chronicle/release.json` from the repo root; stages in order `bump`, `entry`, `commit`, `tag` (then `push`); `--through tag` is local mode and pushes nothing                                                  |
| guard comment-sweep | `packages/guard/hooks/comment-sweep.ts`                    | `comment-sweep.ts snapshot` / `comment-sweep.ts sweep`; payload `{ "session_id": "<id>", "cwd": "<repo>" }` on **stdin**; `sweep` prints `{"decision":"block","reason":"🧹 comment-sweep: …"}` when a block of 3+ added comment lines exists, else nothing; always exits 0 |

### Steps, in this order

The order chains the flows: the scaffolded tree and the landed file are what the commit step commits. Each step asserts its exit code **and** one observable result.

1. **`flightplan`**
   - Run `scaffold.ts smoke work --docs-root <repo>/docs` with `cwd: repo`. Assert exit 0 and that `<repo>/docs/smoke/tasks/work` is a directory.
   - Write `<repo>/docs/smoke/tasks/_context/shared.md`, a short shared context.
   - Write one minimal valid task file named `01-smoke-task.md` inside that `work` bucket directory (build the path with `join(tasksDir, "work", "01-smoke-task.md")`):
     - H1 `# WORK-01: Smoke task`.
     - The Required-reading blockquote listing `` `../_context/shared.md` ``.
     - `> **Depends on**: none — foundation task` and `> **Status**: todo`.
     - `## Goal`, `## Files to create / modify`, `## Acceptance criteria` and `## Verification`, each gate holding one runnable `- [ ]` item.
     - `## Eval rubric` with the threshold line `> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.` and a `| Dimension | Weight | … |` table with a `Correctness | ×3` row.
     - A one-task tree is exempt from the final-review rule.
   - Run `lint-task.ts <repo>/docs/smoke/tasks` with `cwd: repo`. Assert exit 0.
   - Author the task file once against the real linter on macOS, then hard-code it as a string constant in `smoke.ts`.
2. **`worktree`** (common flags `--repo <repo> --slug smoke --plan-dir <repo>/docs/smoke`; the scaffolded tree must exist first, since `create` links the plan directory into the worktree):
   - The worktree ref is the scaffolded task's bucket and number joined by a slash; build it in code as `const REF = ["work", "01"].join("/")`.
   - `create <REF>` → parse JSON, keep `path`.
   - `fingerprint` → keep `.fingerprint` as the baseline.
   - Write `<path>/landed.txt` = `landed\n`.
   - `land <REF> --expect <baseline> --op smoke-land` → assert `status === "clean"`.
   - Assert `<repo>/landed.txt` reads exactly `landed\n`. The read is byte-exact: on Windows a CRLF here means the `core.autocrlf` pin regressed.
   - `remove <REF>` → assert `{"removed":true}`.
3. **`commit`**
   - Write `<parent>/out/plan.json`. The plan file must live outside the repo.
   - Its content is `{ "commits": [{ "type": "docs", "subject": "Add smoke plan", "files": [<every changed path>] }] }`. The list holds every path under `docs/smoke/` plus `landed.txt`, repo-relative with `/` separators.
   - Take the paths from `git -C <repo> status --porcelain -uall`. The coverage check fails when a changed path is neither planned nor excluded.
   - Run `commit.ts apply --plan-file <parent>/out/plan.json` with `cwd: repo`. Assert exit 0 and JSON `ok === true`.
   - Assert `git -C <repo> log -1 --format=%s` ends with `docs: Add smoke plan`. The executor prefixes an emoji.
   - Assert `git -C <repo> status --porcelain` is empty.
4. **`sweep`**
   - Use the session id `smoke-<process.pid>-<Date.now()>`.
   - Do not set `GUARD_STATE_DIR`, so the step exercises guard's default scratch root on each OS.
   - Run `comment-sweep.ts snapshot` with the payload on stdin and `cwd: repo`.
   - Write `<repo>/app.ts` = `const a = 1;\n// one\n// two\n// three\nconst b = 2;\n`.
   - Run `comment-sweep.ts sweep` with the same payload. Assert exit 0, and assert stdout parses to JSON with `decision === "block"` and `reason` containing `comment-sweep`.
   - Delete `app.ts` afterwards so the release step starts on a clean tree.
5. **`release`**
   - Write `CHANGELOG.md` = `# Changelog\n\n## [0.2.0] - 2026-01-01\n`. With the entry header already present, the `entry` stage counts as done and needs no `--entries-file`, which an agent would otherwise write.
   - Run `release.ts run --units '[{"component":null,"targetVersion":"0.2.0","lastTag":null}]' --through tag` with `cwd: repo`. The units JSON is one argv element and holds `"`, but `bun` is a real `.exe`, so `windows.md`'s `.cmd` rule does not apply.
   - Assert exit 0.
   - Assert `VERSION` reads `0.2.0\n`.
   - Assert `git -C <repo> tag --list v0.2.0` prints `v0.2.0`.
   - Assert `git -C <repo> rev-parse v0.2.0^{commit}` equals `git -C <repo> rev-parse HEAD`.

`.chronicle/release.json` for the temp repo:

```json
{
  "mode": "whole-repo",
  "workflow": "github-flow",
  "tag": "v{version}",
  "changelog": "CHANGELOG.md",
  "branches": { "main": "main" },
  "versionFiles": [{ "path": "VERSION", "kind": "text" }]
}
```

### Windows specifics this script must respect

- Build every path with `join`. Paths the script hands to git or writes into a plan file stay POSIX (`docs/smoke/...`), because git pathspecs treat `\` as an escape.
- Pass `--repo` the repo path exactly as created under `tmpdir()`. Do not `realpathSync` it, so the 8.3 short-name case `windows.md` describes reaches the worktree tool the way autopilot would hand it.
- Any skip of a step on win32 defeats the job's purpose. When a step fails only on Windows, the fix belongs in the product, not in `smoke.ts`.

## Acceptance criteria

- [ ] `.github/scripts/smoke.ts` exists and `bun .github/scripts/smoke.ts` exits 0 on macOS, printing exactly five lines matching `^ok (flightplan|worktree|commit|sweep|release)$`, in that order.
- [ ] After the run, no `q-lab-smoke-*` directory remains under `tmpdir()`, so the script cleans up after itself.
- [ ] Breaking one step makes the script exit non-zero and name that step. For example, change the asserted `status` to `"conflict"`, confirm the script prints `FAIL worktree`, then revert.
- [ ] `ci.yml` parses as YAML, its `jobs` keys are exactly `required`, `report` and `smoke`, and `smoke` has no `continue-on-error`.
- [ ] The `required` job's `run` lines include `bun test packages/chronicle`, `bun test packages/dispatch`, `bun test packages/guard`, `bun test packages/relay` and `bun test opencode/`, each as its own step with no `if:`.
- [ ] The `report` job is byte-for-byte unchanged.
- [ ] (human) On the leg's PR, the `required` and `smoke` jobs are green on windows-latest, macos-latest and ubuntu-latest.

## Verification

- [ ] `bun .github/scripts/smoke.ts` exits 0 and prints five `ok` lines.
- [ ] `bun -e 'const y = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()); const runs = y.jobs.required.steps.map((s) => s.run); for (const s of ["bun test packages/chronicle","bun test packages/dispatch","bun test packages/guard","bun test packages/relay","bun test opencode/"]) if (!runs.includes(s)) throw new Error(s); if (Object.keys(y.jobs).sort().join() !== "report,required,smoke") throw new Error("jobs"); if (y.jobs.smoke["continue-on-error"]) throw new Error("smoke not blocking"); if (!y.jobs.smoke.steps.some((s) => s.run === "bun .github/scripts/smoke.ts")) throw new Error("smoke step");'` exits 0. `actionlint` is not installed on the authoring machine, so YAML structure is checked through `Bun.YAML`.
- [ ] `git status --short -- .github/workflows/ci.yml .github/scripts/smoke.ts` shows both paths dirty.
- [ ] `git diff -- .github/workflows/ci.yml` shows no hunk that touches a line between `  report:` and the end of that job.
- [ ] Root `tsconfig.json` `include` lists `.github/scripts/**/*.ts`, and `bunx --bun tsc --noEmit` prints nothing.
- [ ] (human) Open the leg's PR and confirm the `required` (×3) and `smoke` (×3) checks pass.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                                   | 2–3 (below bar)                                                                                                             | 4–5 (pass)                                                                                                                                                                                                                                           |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A suite is missing from `required`, `smoke` is non-blocking, `report` changed, or a smoke step passes without asserting an observable result | All five steps run but one asserts only an exit code, a step calls the network or an LLM, or a step is skipped on win32     | Five suites in `required` on all three OS; `smoke` blocks on all three; each step asserts its exit code and one observable result (lint clean, `status: "clean"` with byte-exact LF, commit subject + clean tree, `decision: "block"`, tag on HEAD)  |
| Test coverage           | ×2     | The script exits 0 when a step fails                                                                                                         | Failure detection works for some steps only                                                                                 | Every step fails the script with `FAIL <step>` when its assertion breaks; the five flows chain on one repo, so a regression in an earlier flow surfaces downstream too                                                                               |
| Interface & readability | ×1     | A framework, a helper module, or a config option with no caller                                                                              | Plain file, but steps share mutable state in hard-to-follow ways or repeat spawn boilerplate per call                       | One file; one `step()` and one spawn helper; each step reads top to bottom in the order the flows run                                                                                                                                                |
| Assumptions & docs      | ×1     | CLI invocations guessed rather than read from the scripts; Windows facts not traceable to `windows.md`                                       | Invocations right, but the plan-outside-repo, pre-written CHANGELOG entry, or no-`TYPESAFE_API_KEY` choices are unexplained | Every non-obvious choice (plan file outside the repo, CHANGELOG entry pre-written to skip the annalist, `TYPESAFE_API_KEY` deleted, guard's default state root exercised, `--repo` left un-realpathed) is stated once in the script where it is made |

## Out of scope

- The `report` job — Deferred. Reason: monitor, herdr, browsers and runes stay in the non-blocking tier until their own legs.
- Agent-driven flows (`/chronicle:commit` with its Lawspeaker, `/chronicle:release` with its annalist, `/autopilot`, guard's reviewer subagent) — Deferred. Reason: they need an LLM; they are owed human checks on a real Windows PC.
- `release.ts --through push` — Deferred. Reason: a smoke run must publish nothing.
- Fixing a product bug the smoke job exposes on Windows — Deferred to a follow-up task in the owning plugin's bucket. Reason: this task wires CI; a red Windows smoke step means the leg gains a task before it lands.
