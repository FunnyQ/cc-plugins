# COMMIT-01: Port analyze-changes script

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: commit/03
> **Status**: done

## Goal

Port odin-git's `analyze-changes.ts` into chronicle's commit skill so it gathers git status/diff/recent-commits as structured JSON, resolving chronicle's own commit template (no odin-git path), with its pure functions unit-tested.

## Files to create / modify

- `packages/chronicle/skills/commit/scripts/analyze-changes.ts` (new) — git change-data gatherer.
- `packages/chronicle/skills/commit/scripts/analyze-changes.test.ts` (new) — unit tests for the pure parsers.

## Implementation notes

This script gathers raw git change data as JSON; the LLM does the grouping later. The full algorithm is inlined below so the task is self-contained — **no external file is required to complete it**. (An original reference implementation may exist at `~/.claude/plugins/cache/odin-marketplace/odin-git/3.2.3/skills/atomic-commit/scripts/analyze-changes.ts`, but treat it as optional/absent — do not depend on it.)

### Algorithm (inline spec — reconstruct from this)

1. Run `git status --porcelain -uall` (the `-uall` lists individual untracked files). `trimEnd()` then split on newlines so leading spaces in status lines survive.
2. Parse each line with `parseStatusLine` (below) into zero or more `ParsedStatus` entries — a single line like `MM file` yields both a staged and an unstaged entry.
3. For each entry, fetch its diff + stats **in parallel** (`Promise.all`):
   - Untracked (`added && !staged`) non-binary, non-lock file → read whole content, diff is `+++ new file: <path>\n<content>`, insertions = line count.
   - Lock file (`shouldSkipDiff`) → diff `"[lock file - diff skipped]"`, count lines only.
   - Binary (`isBinaryFile`) → diff `"[binary file - diff skipped]"`, stats 0/0.
   - Otherwise → stats from `git diff [--cached] --numstat -- <path>` (parse `^(\d+|-)\t(\d+|-)`), diff from `git diff [--cached] -- <path>`. Use `--cached` when the entry is staged.
4. Collect recent commits for style reference: `git log --oneline -10` → string[].
5. Build the `AnalysisResult`, write it to a temp file, print the three-key summary.

### Keep (port as-is, export for tests)

```ts
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type ParsedStatus = { path: string; oldPath?: string; staged: boolean; status: FileStatus };
export function parseStatusLine(line: string): ParsedStatus[]
export function unquoteGitPath(rawPath: string): string
export function shouldSkipDiff(path: string): boolean
export function isBinaryFile(path: string): boolean
```

The CLI entry (`if (import.meta.main)`) writes the full analysis to a temp file and prints `{ outputPath, promptPath, totalFiles }` so the calling agent reads the big payload via the Read tool rather than through stdout.

**`parseStatusLine` rules** (porcelain `XY PATH`; `X`=index/staged at pos 0, `Y`=worktree/unstaged at pos 1, path from pos 3; renames are `old -> new`, take the new path, keep `oldPath`):
- `?` index → single `{staged:false, status:"added"}` (untracked), return early.
- index `A`/`D`/`R`/`M` → push `{staged:true, status: added/deleted/renamed/modified}`.
- worktree `M`/`D` → push `{staged:false, status: modified/deleted}` (independent of index, so `MM`/`AM`/`AD` yield two entries).
- line length `< 4` → return `[]`.

**`unquoteGitPath`**: if the path is wrapped in double-quotes, `JSON.parse` it (git's C-style escaping is JSON-compatible for the common cases); on parse failure, strip the surrounding quotes.

**`shouldSkipDiff` patterns** (regex, content not useful — stats only): `/\.lock$/`, `/lock\.json$/`, `/lock\.yaml$/`, `/\.lockb$/`, `/yarn\.lock$/`, `/node_modules/`.

**`isBinaryFile` extensions** (lowercased `extname`): images `.png .jpg .jpeg .gif .bmp .ico .webp .avif .svg`; audio/video `.mp3 .mp4 .wav .ogg .webm .avi .mov .flac`; docs/archives `.pdf .zip .tar .gz .bz2 .7z .rar .xz`; fonts `.woff .woff2 .ttf .otf .eot`; binaries `.exe .dll .so .dylib`; db `.sqlite .db .lockb`.

### Change 1 — template resolution (chronicle's own, no odin-git)

Replace the odin-git settings lookup. Default to chronicle's bundled template; allow a user override under a `chronicle` settings namespace.

```ts
const DEFAULT_PROMPT_PATH = resolve(SCRIPT_DIR, "../references/commit-template.md");
// override path: ~/.claude/settings.json → settings?.skills?.chronicle?.commit?.templatePath
// expand a leading "~" to homedir(); fall back to DEFAULT_PROMPT_PATH on any miss/error
```

The default template file is produced by a sibling task (the commit-template task) — at runtime this script only needs to resolve and return the path string; it does not read the template contents.

### Change 2 — temp output dir

`/tmp/odin/atomic-commit/...` → `/tmp/chronicle/commit/...`. Keep the `${dir}/${Date.now()}.json` filename pattern.

### Change 3 — drop odin-specific naming

No references to "odin", "atomic-commit" settings keys, or odin paths anywhere in the file or comments.

### Tests

Port/author `bun:test` cases for the four pure functions. Cover at minimum:
- `parseStatusLine`: untracked `?? f`, staged add `A  f`, combined `MM f`, rename `R  old -> new`, deletion, a `< 4`-char line → `[]`.
- `unquoteGitPath`: plain path unchanged; `"path with spaces.txt"` unquoted; malformed quotes fall back to slice.
- `shouldSkipDiff`: `bun.lockb`, `package-lock.json`, `node_modules/x` → true; `src/a.ts` → false.
- `isBinaryFile`: `.png`/`.woff2` → true; `.ts` → false; case-insensitive.

## Acceptance criteria

- [x] `analyze-changes.ts` exists under the commit skill and imports only Bun built-ins + `node:` stdlib (no npm, no odin path).
- [x] The four functions above are exported and pass the concrete cases in the Tests section (status combos `??`/`A `/`MM`/`R old -> new`/deletion/`<4`-char; quoted-path unquoting + fallback; lock/node_modules skip; binary-extension detection, case-insensitive).
- [x] Template resolution returns `../references/commit-template.md` by default and honors `settings.skills.chronicle.commit.templatePath` (with `~` expansion) when set.
- [x] Temp output goes to `/tmp/chronicle/commit/`.
- [x] No string "odin" or "atomic-commit"-as-settings-key appears in the file.
- [x] CLI run prints a JSON object with keys `outputPath`, `promptPath`, `totalFiles`.

## Verification

- [x] `bun test packages/chronicle/skills/commit/scripts/analyze-changes.test.ts` is green.
- [x] In a dirty git tree: `bun packages/chronicle/skills/commit/scripts/analyze-changes.ts` prints the three-key JSON, and the referenced `outputPath` file parses as JSON with a `files[]` array.
- [x] `grep -ri "odin" packages/chronicle/skills/commit/scripts/analyze-changes.ts` returns nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | parsing diverges from source / odin path leaks | works on happy path but a status combo or template override breaks | identical parsing, template resolves to chronicle's own, temp dir changed, no odin leak |
| Test coverage | ×2 | no tests | only one function tested | all four pure fns + edge cases (rename, combined status, malformed quote) |
| Interface & readability | ×1 | tangled, unclear types | usable but exports unclear | clean exports, types preserved, I/O at edges |
| Assumptions & docs | ×1 | magic paths unexplained | partial notes | settings key + temp dir documented in comments |

## Out of scope

- Classifying simple vs atomic — Deferred. That judgment lives in the commit skill's analyze fork, not this script.
- Staging or committing — Deferred. The write fork does that with plain git.
