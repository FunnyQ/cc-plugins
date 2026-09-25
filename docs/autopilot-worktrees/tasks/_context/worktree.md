# Worktree contract

## Why

Autopilot dispatches every ready task of a wave in parallel. In one shared working tree, a whole-target build (SwiftPM, `tsc`, Rust, Go) compiles a sibling's half-written file and fails correct work. Each non-final task therefore runs its whole pipeline — dev, verify, judge — in its own git worktree, and only a judged-passing result is merged back into the main tree.

Workflow `agent()` has **no `cwd` option**, and `agent(..., {isolation: 'worktree'})` gives each *agent call* a fresh throwaway worktree that is never merged back, so it cannot span a pipeline. The orchestrator owns the worktrees through `worktree.ts` and passes the path to every prompt.

## Layout

- Worktree root: `<repo-parent>/.<repo-name>-autopilot/<slug>/`. It must sit **outside** the repo, or the main tree's `git status` and whole-target builds would sweep it in.
- One worktree per task: `<root>/<bucket>-<NN>`, e.g. `/Users/funnyq/Projects/q-lab/.cc-plugins-autopilot/autopilot-worktrees/models-01`.
- State file: `<root>/state.json`, keyed by ref, holding `{ path, base }` where `base` is the snapshot commit the worktree started from. Only `worktree.ts` reads or writes it.
- **Excluded path**: `docs/<slug>/` (the task files and the self-gitignored `.flightlog/`). It lives in the main tree only. It is left out of every snapshot, merge, and fingerprint, because the orchestrator writes task Status lines there while tasks run.

## Snapshot technique

Copy this from `packages/guard/hooks/comment-sweep.ts` (`worktreeTree`, lines 44–75). dispatch cannot import from guard.

1. Create a scratch dir with `mkdtempSync`. Seed a throwaway index by copying the real one (`git rev-parse --path-format=absolute --git-path index`).
2. With `GIT_INDEX_FILE=<scratch>/index`, run `git add -A`. This takes tracked and untracked files and respects ignore rules. Then drop the excluded path with `git rm -r --cached -q --ignore-unmatch -- docs/<slug>` and run `git write-tree`.
3. Wrap the tree in a commit with `git commit-tree <tree> -p HEAD -m "autopilot snapshot <ref>"`. The commit stays dangling; nothing creates a ref.
4. The real index and the real working tree are never touched.

## `worktree.ts` CLI

The script lives at `packages/dispatch/skills/flightplan/scripts/worktree.ts`.
- Every subcommand takes `--repo <abs main-tree root>` and `--slug <slug>`.
- Every subcommand prints one JSON object on stdout.
- Exit codes: `0` for success, including a `conflict` or `drift` result; `2` for bad arguments or a missing target; `1` for any other git failure. On a failure, stderr carries the git command and its stderr.

| Subcommand | Does | Prints |
|---|---|---|
| `create <ref>` | Snapshots the main tree. Runs `git worktree add --detach <path> <snapshot>`, removing any existing worktree for this ref first. Clones every ignored path into the worktree with `cp -c -R` (see Seeding). Records state. | `{ "path": "<abs>", "base": "<commit>" }` |
| `land <ref> --expect <tree> --op <id>` | Leak check first, then see Land. Every field is always present; see "Land result fields". | `{ "status": "clean" \| "conflict" \| "leak", "drift": <bool>, "files": [...], "paths": [...], "fingerprint": "<tree>", "previous": "<tree>" }` |
| `unland <ref> --op <id>` | Restores the main tree to the `previous` fingerprint tree of the last clean land of this ref. Touches only the paths that land changed. Used when the drift re-verify fails. | `{ "restored": [...] }` |
| `rebase <ref> --op <id>` | Writes the three-way result, conflict markers included, into the worktree, overwriting it. Sets its base to the current main snapshot. | `{ "path": "<abs>", "base": "<commit>", "conflicted": [...] }` |
| `fingerprint [--expect <tree>]` | The main-tree snapshot tree hash, with the excluded path left out. With `--expect`, `paths` lists what differs from that tree; it is empty when they match. | `{ "fingerprint": "<tree>", "paths": [...] }` |
| `show <ref>` | Reads state and checks the disk. Used by a single-task resume. | `{ "path": "<abs>", "base": "<commit>" \| null, "exists": <bool> }` |
| `remove <ref>` | Runs `git worktree remove --force` and drops the state entry. Succeeds when the worktree is already gone. | `{ "removed": <bool> }` |
| `sweep [--keep <ref,...>]` | Removes every worktree under the slug's root that is not kept, then runs `git worktree prune`. Drops the root dir once it is empty. | `{ "removed": ["<ref>", ...], "kept": [{ "ref": "<ref>", "path": "<abs>" }, ...] }` |
| `sweep --keep-all` | Lists every worktree under the slug's root and removes nothing, not even stale registrations. Used when no trustworthy keep list exists. | `{ "removed": [], "kept": [{ "ref": "<ref>", "path": "<abs>" }, ...] }` |

## Repeat calls are safe

An agent can finish a `worktree.ts` call and then fail to return its structured result, so the orchestrator may run the same call twice. Every subcommand is therefore idempotent for identical arguments:
- `land`, `unland`, and `rebase` take a required `--op <id>`. They record their printed result in `state.json` under the ref, keyed by that id. A repeat call with a recorded id prints the recorded result and changes nothing; a new id always acts. Without this, a repeated `land` would see its own first write as a leak.
- The orchestrator builds the id from the attempt and the step: `a<attempt>-land`, `a<attempt>-unland`, `a<attempt>-rebase`. A resumed run continues the attempt numbering, so its ids never collide with the parked run's ids.
- `create` removes any existing worktree for the ref first, so a repeat builds the same thing again.
- `remove`, `sweep`, `show`, and `fingerprint` are naturally idempotent.

**Scope of the retry-safety claim.** Idempotency covers a command that ran to completion and whose structured result was then lost. It does not cover a process killed between applying a patch and writing `state.json`; that window leaves a land that the next `--expect` reports as a leak, which halts the run safely rather than corrupting it.

**Retrying a missing result.** The existing `resilient(make, retryModel)` in the orchestrator retries only when `make` throws, and returns a `null` result as-is. Every `wt-*` call and `reverify` therefore goes through `resilient` with a `make` that throws when the agent result is `null`, so the one retry fires. The retry repeats the same arguments, including `--op` and `--expect`. A second `null`, meaning the retry also threw, is an infrastructure failure for the task. `reverify` only runs Verification, so repeating it is safe too.

## Land result fields

| status | drift | files | paths | fingerprint | previous |
|---|---|---|---|---|---|
| `clean` | ours-tree ≠ base-tree | paths changed between ours-tree and `R` | `[]` | `R` (the new main fingerprint) | ours-tree |
| `conflict` | ours-tree ≠ base-tree | the conflicted paths | `[]` | ours-tree (main is unchanged) | ours-tree |
| `leak` | `false` | `[]` | paths differing between `--expect` and the actual main fingerprint | the actual main fingerprint | the `--expect` value |

## Seeding ignored paths

- Run `git -C <repo> ls-files --others --ignored --exclude-standard --directory` to list ignored paths, nested ones like `packages/x/node_modules/` included.
- Skip anything under the excluded path.
- For each path, run `cp -c -R <repo>/<p> <wt>/<p>`, creating parent dirs first. On a volume without clonefile, `cp -c` fails; fall back to `cp -R` for that path. Never fail the create over a seed.

## Land (three-way merge into the main tree)

Land runs only while the orchestrator holds its land mutex.

1. `ours` = the current main snapshot commit (step 1–3 above, with parent `HEAD`). `theirs` = the worktree snapshot commit, taken the same way inside the worktree. `base` = the ref's recorded base.
2. `drift` = the tree of `ours` differs from the tree of `base`, meaning something landed since this task started.
3. Run `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>`.
   - Exit 1 means conflict. Print `status: "conflict"` and the conflicted `files`, and leave the main tree untouched.
   - Exit 0 gives the merged tree `R`.
4. Write `R` into the main working tree **without touching the real index**:
   - Compute `git diff --binary <ours-tree> <R>` and apply it with `git apply --binary` to the working tree. Do not pass `--index` or `--3way`.
   - Record `previous = <ours-tree>` and `fingerprint = R`, excluded path still left out.
5. `files` lists the paths changed between `ours-tree` and `R`.

## Rebase (conflict or failed drift re-verify)

1. Run the same `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>`. Even on exit 1, the first stdout line is a tree OID, and that tree already holds the conflicted files with their markers. For a failed drift re-verify, the merge is clean, so the tree is simply `R`.
2. Move the worktree's detached HEAD to the new `ours` commit with `git -C <wt> reset --soft <ours>`, so the base stays reachable while the worktree exists. Then check the tree out over the worktree with `git -C <wt> read-tree -u --reset <tree>`, run in the worktree with its own index.
3. Set `base` to the new `ours` commit.
4. The next dev attempt sees the markers, and its feedback lists the conflicted files.

## Pipeline order (orchestrator)

A Workflow script has no filesystem or process API, so every `worktree.ts` call runs through a mechanical agent: haiku, with a JSON schema mirroring the printed object. Retries on a missing structured result follow the existing `resilient(...)` / structuredRetry pattern. Labels are `wt-create:<ref>`, `wt-land:<ref>`, `wt-rebase:<ref>`, `wt-unland:<ref>`, `wt-remove:<ref>`, `wt-sweep:<start|end>`, and `wt-leak:<wave>`, and the drift re-verify is labelled `reverify:<ref>#<attempt>`. An agent result that is missing or malformed is an infrastructure failure for that task, handled the same way as a verify that returns nothing.

The orchestrator keeps a `live` map from ref to worktree path. It sets an entry after every `create` or resume `show` with `exists: true`, and deletes the entry after every `remove`. Every report of kept worktrees (park, abort, run end) reads this map, plus the start sweep's `kept` entries (ref and path) whose Status is still `blocked`, so a blocked leftover this run never touched is still reported.

The orchestrator holds **one lock, the main-tree lock**, around **every `worktree.ts` call** and the drift re-verify. Every subcommand reads or rewrites the main tree or the shared `state.json`, so two unlocked calls could capture half a land or lose each other's state entry. That covers `create`, `land`, `rebase`, `unland`, `remove`, `show`, `fingerprint`, and `sweep`. A multi-file `git apply` is not atomic, so a `create` that snapshots mid-land would capture half a land. The lock is a plain JavaScript promise chain inside the script.

Each non-final task runs the steps below.

1. Under the lock, run `create`.
2. Run dev, verify, and judge. Every prompt carries `WORKTREE: <path>` and the rules in the next section.
3. Under the lock, run `land --expect <last recorded fingerprint>`, then handle the result:
   - `leak`: set the run-wide abort (see below). Report `paths`. Revert nothing.
   - `conflict`: release the lock, run `rebase` under the lock, and count the attempt as failed. Its feedback names the conflicted files.
   - `clean` with `drift: true`: while still holding the lock, run `reverify:<ref>#<attempt>`, which re-runs the task's Verification **in the main tree** with the verify role. If that fails, run `unland`, then `rebase`, and count the attempt as failed; the next attempt's feedback quotes the re-verify summary. If `reverify` returns no structured result even after its retry, run `unland`, keep the worktree, and end the task as an infrastructure failure (it parks), the same way a verify with no result does today.
   - `clean`: record the new fingerprint and release the lock.
4. Mark the task done in the main tree.
5. Run `remove`.

**Run-wide abort.** A leak, whether found by a land or by the wave-end check, sets one `aborted` flag with its paths.
- Every task checks the flag before it takes a `Max parallel` slot, before each attempt, and before each land.
- A task that sees the flag stops without landing and without parking. Its result is an infrastructure failure naming the abort.
- **A task whose land was clean before the abort still finishes.** It runs mark-done and `remove`, because its work is already in the main tree and its worktree holds nothing unlanded. The abort only preserves worktrees whose work has not landed.
- The wave loop stops, and no inter-wave commit runs.
- The end sweep is skipped, so every worktree with unlanded work survives for inspection, and the run result lists every entry still in the `live` map.

Other rules:
- A retry after conflict or drift reuses the rebased worktree. A retry after an ordinary verify or judge failure reuses the same worktree unchanged.
- **Cleanup failures** go in their own run-result field, `cleanupFailures: [{ ref, path }]`: a landed task whose worktree removal could not be confirmed. The task stays in `completed`, and the path is not in `worktrees`. The run is not clean.
- **Park**: keep the worktree and do not land. The escalation carries the worktree path.
- **After a clean land, a task never parks and never unlands.** A mark-done with no result after its retry is an infrastructure failure reading "landed, but Status was not marked done", and `remove` still runs. A `remove` with no result after its retry leaves the task completed; a `show` then decides whether the path goes to `cleanupFailures`.
- **Final review (`review/01`)** runs in the main tree, and none of the steps above apply.
  - Its fixer writes the main tree on purpose. The wave-end leak check therefore skips a wave that ran the Final review, and the fingerprint is not compared again afterwards.
  - Its resume (`--from dev|verify|judge`) takes no baseline and runs no `show` or `create`. It runs in the main tree exactly as it does today.
- **Resume** (a single-task resume runs no scout and no wave loop):
  - At resume start, under the lock, take the baseline with `fingerprint`.
  - `--from verify` or `--from judge` runs `show <ref>`. When `exists` is false, halt with a message naming the path. Otherwise run in that path.
  - A resume from `dev` runs `show <ref>` first. When the worktree exists, the resume reuses it, because it may hold unlanded work, for example after a failed drift re-verify. Only when it is missing does the resume run `create`.
- **A failed `reverify` supersedes the judge's passing verdict.** The judge has already logged a passing score for that attempt, so `flightplan/scripts/lib/resume-point.ts` must treat a later failed `reverify` for the same attempt as a failed gate. The resume point is then `dev` on the next attempt.
- **Cleanup**:
  - At run start, run `sweep --keep <refs whose Status is blocked>`.
  - After each clean land, run `remove`.
  - At run end, unless the run aborted, run `sweep --keep <refs>`, where the keep list is every ref in the `live` map plus every ref kept by the start sweep whose Status is still `blocked`. A blocked task this run never touched keeps its worktree.
  - The run result lists every kept worktree path.
  - After a clean run, no worktree for the slug remains.
  - `sweep` touches only paths under the slug's worktree root. The start sweep deliberately removes a previous run's leftovers for this slug, except those of `blocked` tasks. Worktrees outside the root are never touched.
- The fingerprint baseline is taken once at run start, after the first sweep, with `fingerprint`. The wave-end leak check runs `fingerprint --expect <last>` before the inter-wave commit. Non-empty `paths` sets the run-wide abort.
- The `Max parallel` slot covers the whole pipeline, land and drift re-verify included.
- flightdeck parses labels in `autopilot/scripts/fleet.ts`. `reverify` must be a gate role there, next to `verify` and `requalify`: in the role list, the `REF_ATTEMPT` regex, the role order, and `gateOutcome()`.

## Prompt rules for agents in a worktree

These go in every dev, verify, judge, and external-driver prompt for a non-final task.

- `WORKTREE: <abs path>`. Run `cd <WORKTREE>` before any command. Every source file you create or edit must have an absolute path starting with `<WORKTREE>/`.
- Exactly three kinds of write are exempt, because they belong to the run rather than the task's source: `flightlog.ts log` into the main-tree flightlog, the task file's Status line in the main tree, and the judge's scratch files under `/tmp`. Nothing else may be written outside `<WORKTREE>/`.
- The task file and the flightlog stay at the absolute main-tree paths given in the prompt. Read and log there, and never copy them into the worktree.
- Run the task's Verification commands from `<WORKTREE>`. They are written relative to the repo root.
- External engines follow `process.cwd()`, so the driver runs `cd <WORKTREE> && bun …/codex-run.ts …` (or the relay command) in one shell call.
