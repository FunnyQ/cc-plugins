# GUARD-01: Honest guard tests on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: guard/02
> **Status**: todo

## Goal

guard's bun test suite stops assuming POSIX paths, spawn paths and line endings, so every Windows failure left in it is a real product bug.

## Files to create / modify

- `packages/guard/hooks/comment-guard.test.ts` (modify) — the `describe("main")` spawn path and its scratch dir.
- `packages/guard/hooks/comment-sweep.test.ts` (modify) — the spawn path in `a reported Edit is not asked again`, and `core.autocrlf false` in the temp repo.
- `packages/guard/skills/comments-reaper/scripts/scan.test.ts` (modify) — `core.autocrlf false` in the temp repo, and the deck-path expectation built with `join`.

Change test files only. Do not touch `packages/guard/hooks/*.mod.test.ts`; `bunfig.toml` excludes them from bun.

## Implementation notes

Line numbers are as of 554083d. Re-locate each site by the quoted content.

### Spawn paths (shared.md rule 3; windows.md "File names and paths")

`new URL(rel, import.meta.url).pathname` returns `/D:/a/...` on Windows, which `bun` cannot load, so every spawned hook exits 1.

- `comment-guard.test.ts:645` — `const HOOK = new URL("./comment-guard.ts", import.meta.url).pathname;` becomes `const HOOK = join(import.meta.dir, "comment-guard.ts");`.
- `comment-sweep.test.ts:186` — `["bun", new URL("./comment-guard.ts", import.meta.url).pathname]` becomes `["bun", join(import.meta.dir, "comment-guard.ts")]`.

Add `join` to the existing `node:path` import where it is missing.

### Scratch dir in comment-guard's `main` tests

`comment-guard.test.ts:648` builds `` `/tmp/cg-main-${Math.random().toString(36).slice(2)}` ``, and `:649` builds `` `${dir}/app.ts` ``. On Windows `/tmp/...` is drive-relative (windows.md). Replace both:

```ts
const dir = mkdtempSync(join(tmpdir(), "cg-main-"));
const path = join(dir, "app.ts");
```

Keep the existing `rm -rf ${dir}` cleanup. `Bun.write` no longer needs to create the directory, but leave the write as it is.

### Temp git repos (shared.md rule 7)

Both fixtures run `git("init", "-q")` under `tmpdir()`, then `git config user.email` / `user.name`. Add one line after them in each `beforeEach`:

```ts
git("config", "core.autocrlf", "false");
```

Sites: `comment-sweep.test.ts` `beforeEach` (`git("init", "-q")` at :22) and `scan.test.ts` `beforeEach` (`git("init", "-q")` at :24). On the runner, `core.autocrlf=true` otherwise turns the LF fixtures into CRLF on checkout.

### Deck path expectation in scan.test.ts

The `--workflow prints the shard count and the deck…` test (around :150–165) expects:

```ts
expect(lines[2]).toStartWith(
  `deck ${home}/q-lab/flightdeck/comments-reaper-scan-`,
);
```

`scan.ts:161` builds that path with `join(dataHome, "q-lab/flightdeck", …)`, which yields backslashes on Windows. Build the expectation the same way: `` `deck ${join(home, "q-lab", "flightdeck", "comments-reaper-scan-")}` ``. The test overrides only `XDG_DATA_HOME`, which `scan.ts:205` reads before `homedir()`, so it needs no `USERPROFILE`.

### Environment overrides (shared.md rule 2)

A grep of guard's bun tests at 554083d finds no `HOME` or `TMPDIR` override and no `#!/bin/sh` stub. Re-run the grep below. If it finds any, apply rule 2 (`HOME` → also `USERPROFILE`; `TMPDIR` → also `TEMP` and `TMP`) or rule 4 (`.cmd` shim or `["bash", script]`).

```bash
grep -rnE 'HOME|TMPDIR|#!/bin/sh' --include='*.test.ts' packages/guard | grep -v '\.mod\.test\.ts'
```

`XDG_DATA_HOME` hits are expected and need no change.

## Acceptance criteria

- [ ] `grep -rn "import.meta.url" --include='*.test.ts' packages/guard | grep -v '\.mod\.test\.ts'` prints nothing.
- [ ] `grep -rn "/tmp/cg-main" packages/guard` prints nothing.
- [ ] `grep -c '"core.autocrlf", "false"' packages/guard/hooks/comment-sweep.test.ts packages/guard/skills/comments-reaper/scripts/scan.test.ts` reports at least 1 per file.
- [ ] `grep -n 'flightdeck/comments-reaper-scan-' packages/guard/skills/comments-reaper/scripts/scan.test.ts` prints nothing (the expectation is built with `join`).
- [ ] Every `HOME` override in guard's bun tests sets `USERPROFILE` too, and every `TMPDIR` override sets `TEMP` and `TMP` (the grep in Implementation notes shows none unpaired).
- [ ] `git diff --name-only -- packages/guard` lists only `*.test.ts` files, and none ends in `.mod.test.ts`.

## Verification

- [ ] `bun test packages/guard` passes on macOS.
- [ ] `bunx --bun tsc --noEmit` from the repo root prints nothing.
- [ ] `git status --short -- packages/guard/hooks/comment-guard.test.ts packages/guard/hooks/comment-sweep.test.ts packages/guard/skills/comments-reaper/scripts/scan.test.ts` shows all three as modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                           | 2–3 (below bar)                                                                         | 4–5 (pass)                                                                             |
| ----------------------- | ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A product file changed, a `.mod.test.ts` changed, or a guard test now fails on macOS | Spawn paths fixed but the `/tmp/cg-main` dir or a repo's `core.autocrlf` left as it was | Every site above fixed, macOS suite green, only `*.test.ts` touched                    |
| Test coverage           | ×2     | An assertion was deleted or loosened to pass                                         | An expectation weakened beyond the path separator (e.g. `toContain("flightdeck")`)      | Every assertion keeps its strength; only how the expected path is built changed        |
| Interface & readability | ×1     | New test helpers or wrappers added for one call site                                 | Inline `replaceAll("\\", "/")` hacks instead of `join`                                  | Plain `join(import.meta.dir, …)` / `join(tmpdir(), …)`, matching the surrounding style |
| Assumptions & docs      | ×1     | A `skipIf(win32)` added for a case that is class (a) or (b)                          | A Windows fact assumed without a source                                                 | Every change traces to a `windows.md` fact; no skip added                              |

## Out of scope

- `scan.test.ts` around :98 (`/^report (\S+)\/report-…/`) and :161 (`/^shards 1 in \/\S+\/scan-\w+$/`) pin the `/tmp/q-lab/guard/comments-reaper` scratch root. Deferred. Reason: that root is a product bug (drive-relative on Windows); the guard product-fix task changes `scan.ts`'s root and rewrites these expectations against it.
- `comment-sweep.test.ts` around :122 and :133 (a ledger entry recorded under one spelling of a path is not found under git's spelling). Deferred. Reason: the ledger key needs the path-identity normaliser in product code (`comment-sweep.ts` / `comment-guard.ts` / `sweep-state.ts`), which the guard product-fix task adds.
- `reap.workflow.test.ts`'s `/tmp/q-lab/...` and `/repo` literals. Deferred. Reason: they are opaque strings passed through a pure function and passed on Windows CI.
- `packages/guard/hooks/ledger.ts` `DEFAULT_STATE_DIR` and `comment-core.ts` `isGuardedPath`. Deferred. Reason: product code, owned by the guard product-fix task.
