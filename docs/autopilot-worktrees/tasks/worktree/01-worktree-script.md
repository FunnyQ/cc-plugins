# WORKTREE-01: worktree.ts — create, land, rebase, sweep

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: worktree/02
> **Status**: done

## Goal

A standalone `worktree.ts` CLI creates a per-task git worktree from a snapshot of the main tree, merges a finished worktree back into the main tree three-way without touching the real index, and cleans worktrees up, exactly as `../_context/worktree.md` specifies.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/worktree.ts` (new) — the CLI and the exported pure-ish functions behind each subcommand.
- `packages/dispatch/skills/flightplan/scripts/worktree.test.ts` (new) — real-git tests in temp repos.

## Implementation notes

### Shape

- Implement every subcommand in the CLI table of `../_context/worktree.md`: `create <ref>`, `land <ref> --expect <tree> --op <id>`, `unland <ref> --op <id>`, `rebase <ref> --op <id>`, `fingerprint [--expect <tree>]`, `show <ref>`, `remove <ref>`, `sweep [--keep <ref,...>]`. Every one takes `--repo <abs main-tree root>` and `--slug <slug>`, and prints one JSON object on stdout with exactly the keys that table lists.
- Exit codes: `0` on success, including `conflict`, `leak`, and `drift` results; `2` on bad arguments (including a missing `--op` on `land`, `unland`, or `rebase`), an unknown subcommand, a ref that is not `<bucket>/<NN>`, or a missing target such as `unland` or `rebase` for a ref with no state; `1` on any other git failure. On a failure, stderr names the git command and carries its stderr.
- Export one function per subcommand, taking a plain options object and returning the printed object. Keep argv parsing and `process.exit` in a thin `main` guarded by `import.meta.main`. Tests may call the functions directly or spawn the CLI; each exit-code test must spawn the CLI.
- Run git through `Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env })`, following the `git()` helper in `packages/guard/hooks/comment-sweep.ts:44-49`. **Copy that helper; do not import it.** dispatch never imports from guard.
- Refs map to directory names by replacing `/` with `-`, so the ref `<bucket>/<NN>` becomes the dir `<bucket>-<NN>`.

### Paths and state

- Root: `join(dirname(repo), "." + basename(repo) + "-autopilot", slug)`. Worktree: `join(root, "<bucket>-<NN>")`.
- `state.json` in the root, keyed by ref. Per ref it holds `{ path, base }`, plus `{ previous, landed }` after a clean land: `previous` is the main `ours` tree before the land, and `landed` is the merged tree `R`. `unland` needs both. Write the file whole on every change. Only this script reads or writes it.
- Per ref it also holds `ops: { [id]: result }`: the printed result of every `land`, `unland`, and `rebase`, keyed by its `--op` id.

### Repeat calls

Follow "Repeat calls are safe" in `../_context/worktree.md`. An agent can finish a call and then lose its structured result, so the orchestrator may run the same call twice.
- `land`, `unland`, and `rebase` take a required `--op <id>`. The orchestrator builds it from the attempt and step, for example `a2-land`.
- Each of them first looks up `ops[<id>]` for the ref. On a hit, print the recorded result and exit 0, touching nothing. This check runs **before** the leak check. Without it, a repeated `land` would see its own first write as a leak.
- A new id always acts, even when every other argument matches a recorded call. Comparing inputs is not enough: after a conflict the worktree changes while `--expect` stays the same, and an input-keyed cache would replay the old conflict forever.
- Record `ops[<id>]` only after the command fully succeeds. A call that fails part-way records nothing, so a retry runs it for real.
- `remove` and `create` drop the ref's `ops` along with the rest of its state.
- `create` removes any existing worktree for the ref first, so a repeat builds it again from a fresh snapshot.
- `remove`, `sweep`, `show`, and `fingerprint` are naturally idempotent and record nothing.

### Snapshot (shared by create, land, rebase, fingerprint)

Follow the numbered steps in "Snapshot technique" of `../_context/worktree.md`.
- Copy `worktreeTree` from `comment-sweep.ts:51-64`: seed a throwaway index from the real one in a `mkdtempSync` scratch dir, then run `git add -A` under `GIT_INDEX_FILE`.
- Then run `git rm -r --cached -q --ignore-unmatch -- docs/<slug>` under the same env, and `git write-tree`.
- `commit-tree <tree> -p HEAD` produces the snapshot commit.
- Always remove the scratch dir in a `finally`.
- Taking a snapshot inside a worktree uses that worktree's own index path, found through the same `rev-parse --git-path index`.
- The fingerprint is the snapshot **tree** hash, not the commit hash, because the commit hash changes with time and parent.

### create

- If a worktree for the ref is already recorded or present on disk, remove it first with `git worktree remove --force`, then `git worktree prune`.
- Snapshot the main tree and run `git worktree add --detach <path> <snapshot-commit>`.
- Seed ignored paths as described in "Seeding ignored paths" of `../_context/worktree.md`.
  - List them with `git ls-files --others --ignored --exclude-standard --directory`, and skip anything under `docs/<slug>/`.
  - Copy each with `cp -c -R`, creating parent dirs first. When that fails, fall back to `cp -R`.
  - A seed failure is never fatal.
- Record `{ path, base }` and print `{ path, base }`.

### land

Follow "Land" in `../_context/worktree.md`, with the leak check first. **Every result carries all six keys** — `status`, `drift`, `files`, `paths`, `fingerprint`, `previous` — with the values from "Land result fields" in `../_context/worktree.md`:

```ts
export type LandResult = {
  status: "clean" | "conflict" | "leak";
  drift: boolean;
  files: string[];
  paths: string[];
  fingerprint: string;
  previous: string;
};
```

1. Snapshot the main tree (`ours`). If `--expect` differs from the `ours` tree, print the **leak** row: `status: "leak"`, `drift: false`, `files: []`, `paths` = `git diff --name-only <expect> <ours-tree>`, `fingerprint` = the ours-tree (the actual main fingerprint), `previous` = the `--expect` value. Leave the main tree and this ref's merge state (`base`, `previous`, `landed`) untouched, but still record the printed result under `ops[<op>]`, so a retry replays it.
2. Snapshot the worktree (`theirs`). `drift` = the tree of `ours` differs from the tree of `base`.
3. Run `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>`.
   - **Exit 1**: print the **conflict** row: `status: "conflict"`, `drift` as computed, `files` = the conflicted paths (merge-tree lists them after the tree OID; add `--name-only` if that makes parsing simpler), `paths: []`, `fingerprint` = ours-tree, `previous` = ours-tree. Leave the main tree and this ref's merge state untouched, but still record the printed result under `ops[<op>]`.
   - **Exit 0**: the first stdout line is `R`. Run `git diff --binary <ours-tree> <R>` and pipe it into `git apply --binary` in the main repo, **with no `--index` and no `--3way`**.
4. Record `previous` and `landed` in state, and print the **clean** row: `status: "clean"`, `drift` as computed, `files` = `git diff --name-only <ours-tree> <R>`, `paths: []`, `fingerprint` = `R`, `previous` = ours-tree.

### unland

- Read `previous` and `landed` from state.
- Run `git diff --binary <landed> <previous>` and apply it with `git apply --binary` to the main working tree. This touches only the paths that the land changed.
- Print `restored` = the `--name-only` list of that diff.
- Clear `previous` and `landed` from state.

### rebase

Follow "Rebase" in `../_context/worktree.md`.
- Run the same merge-tree. Take the first stdout line as the tree, even on exit 1, because it carries the conflict markers.
- Move the worktree's detached HEAD to the new `ours` commit with `git -C <wt> reset --soft <ours>`, then check the tree out with `git -C <wt> read-tree -u --reset <tree>`. A worktree's HEAD keeps its commit reachable, so `git gc` cannot drop the new base while the worktree exists. (`create` gets the same protection, because `worktree add --detach` sets HEAD to the snapshot.)
- Set `base` to the new `ours` commit.
- Test: after a rebase, `git -C <wt> rev-parse HEAD` equals the new `base`.
- Print `path`, the new `base`, and `conflicted` (empty when the merge was clean, as after an `unland`).

### fingerprint, show, remove, sweep

- `fingerprint` prints the `ours` tree. With `--expect`, `paths` = `git diff --name-only <expect> <tree>`. Without it, `paths` is `[]`.
- `show` is read-only and used by a single-task resume. It prints `{ path, base, exists }`.
  - `path` is always the computed worktree path for the ref, even for a ref with no state, so a resume can name the missing path.
  - `base` is the recorded base commit, or `null` when state has no entry for the ref.
  - `exists` is true only when the path is a directory on disk.
  - An unknown ref is not an error: it prints `base: null, exists: false` and exits 0. A malformed ref still exits 2.
  - It writes neither state nor git.
- `remove` runs `git worktree remove --force <path>` if the path exists, drops the state entry, and prints `removed: true` only when something was removed. A second call prints `removed: false` and exits 0.
- `sweep` removes every worktree dir under the root whose ref is not in `--keep`, then runs `git worktree prune` and drops the matching state entries.
  - It touches only paths under the slug's root. It never removes a worktree registered elsewhere, including another slug's root under the same `.<repo>-autopilot/` dir or a worktree the user made. It also removes a previous run's leftovers under this root unless `--keep` names them.
  - Map a dir name back to a ref by replacing only the last `-` with `/`.
  - Delete `state.json` and the root dir once no worktree remains.
  - Print `removed` as an array of refs and `kept` as an array of `{ ref, path }` objects.
  - `--keep-all` lists every worktree under the root as `kept` and removes nothing. It runs no `prune` and leaves `state.json` untouched.

### Test harness

- Build each fixture as `<tmp>/parent/repo`, a real `git init` with one commit, so the sibling root `<tmp>/parent/.repo-autopilot/<slug>` lands inside the temp dir.
- Set `user.name` and `user.email` locally in each fixture.
- Clean up in `afterEach`.

## Acceptance criteria

- [x] `create` returns a `path` under `<parent>/.<repo>-autopilot/<slug>/`. That worktree holds the tracked files and an **untracked** file from the main tree, holds an ignored `node_modules/x/index.js` seeded from the main tree, and does **not** hold `docs/<slug>/`.
- [x] **Clean land:** a worktree edit to `a.txt` returns all six keys: `status: "clean"`, `drift: false`, `files: ["a.txt"]`, `paths: []`, `previous` equal to the pre-land `fingerprint` output, and `fingerprint` equal to a fresh `fingerprint` output taken after the land. The main tree's `a.txt` now carries the edit.
- [x] **Drift:** when a second path in main changes after `create` and matches `--expect`, `land` returns `status: "clean"` with `drift: true`, and both edits are present in main.
- [x] **Conflict:** when main and the worktree edit the same line, `land` returns all six keys: `status: "conflict"`, `files: [that file]`, `paths: []`, and `fingerprint` and `previous` both equal to the unchanged main fingerprint. Main is byte-identical to before. `rebase` then leaves `<<<<<<<` markers in the worktree file and returns it in `conflicted`.
- [x] `unland` after a clean land restores every landed path to its pre-land bytes and returns them in `restored`.
- [x] **Leak:** `land --expect <stale tree>` returns all six keys: `status: "leak"`, `drift: false`, `files: []`, `paths` = the differing paths, `fingerprint` = the actual main fingerprint, and `previous` = the stale tree passed in. Main is untouched. `fingerprint --expect` returns the same `paths`.
- [x] **show:** it returns `exists: true` and the recorded `base` after `create`, and `exists: false` with `base` unchanged after the worktree dir is deleted from disk. An unknown ref returns the computed `path`, `base: null`, `exists: false`, and exits 0.
- [x] Changes under `docs/<slug>/` in main change neither `fingerprint` nor the `--expect` leak check.
- [x] The real index is unchanged across `create`, `land`, `unland`, and `rebase`: `git diff --cached --name-only` stays empty, and the index file's bytes are identical before and after.
- [x] With two worktrees created, `sweep --keep-all` removes nothing, prints both as `kept` with their paths, and `git worktree list` still shows both.
- [x] With three worktrees created, `sweep --keep <one of their refs>` removes the other two and keeps the named one, and `git worktree list` afterwards shows only the main tree plus the kept one. A worktree under another slug's root and a user worktree outside `.<repo>-autopilot/` both survive the sweep. `remove` twice returns `removed: true`, then `removed: false`, both exit 0.
- [x] **Repeat op:** after a clean land, a second `land` with the same `--op` and `--expect` prints a result deep-equal to the first (`status: "clean"`, never `"leak"`), and the main tree is byte-identical to the state after the first call. A repeated `unland` with the same `--op` prints the same `restored` and leaves main byte-identical.
- [x] **New op acts:** `land --op a1-land` returns `conflict`; the worktree is then fixed so the conflicting line matches main; `land --op a2-land` with the same `--expect` returns `status: "clean"`, and the fix is present in main.
- [x] **Rebase per op:** two `rebase` calls with different `--op` ids both act, and each moves `base` to the main snapshot current at that call.
- [x] **Repeat create:** calling `create` twice for one ref leaves exactly one worktree registered for it in `git worktree list`, at the same `path`.
- [x] The CLI exits `2` for a missing `--repo`, an unknown subcommand, `unland` on a ref with no state, and a `land`, `unland`, or `rebase` without `--op`.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/worktree.test.ts` passes.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/flightplan/scripts/worktree` prints nothing.
- [x] `rg -n "from \"[./]*guard|packages/guard" packages/dispatch/skills/flightplan/scripts/worktree.ts` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | land writes the real index, a conflict mutates main, or a subcommand's JSON keys differ from the contract | happy paths work but drift, leak, the `docs/<slug>/` exclusion, `unland`, or a repeat call is wrong | every subcommand matches the contract table; a repeat call with identical inputs changes nothing; main and the real index are touched only by a clean land or unland; sweep never leaves the slug root |
| Test coverage | ×2 | no real-git tests | clean land and create only | every acceptance criterion has a real-git test, exit codes included |
| Interface & readability | ×1 | git calls scattered with ad-hoc error handling, I/O mixed into logic | one helper, but functions return inconsistent shapes | one copied `git()` helper, one exported function per subcommand, thin `main`, `type` over `interface` |
| Assumptions & docs | ×1 | the copied snapshot code carries no source note | assumptions implicit | a one-line note cites `comment-sweep.ts` as the copy source; the `cp -c` fallback and the merge-tree exit-1 tree read are each explained in one line |

## Out of scope

- Calling this script from the orchestrator, the agent schemas, and the main-tree lock — deferred to the pipeline-integration task in this bucket. Reason: the lock serialises every main-tree read and write across concurrent task pipelines, which is the orchestrator's concern; this script does no locking of its own.
- Documentation in `SKILL.md` files — deferred to the docs bucket.
- Non-macOS clone primitives beyond the `cp -R` fallback — deferred. Reason: Q runs macOS / APFS.
