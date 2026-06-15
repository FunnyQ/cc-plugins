# BACKENDS-02: Codex backend

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Status**: done

## Goal

Implement the codex `Backend` — the full superset of odin-codex's behaviour (delegate, native review with prompt-file fallback, image) behind the `Backend` interface.

## Files to create / modify

- `packages/relay/skills/relay/scripts/backends/codex.ts` (new) — `codexBackend: Backend` + image PNG helpers.
- `packages/relay/skills/relay/scripts/backends/codex.test.ts` (new) — argv + parseOutput + image-path unit tests.

## Implementation notes

**The contract is the argv/behaviour spec in `../_context/cli-reference.md` (codex section) plus the details below** — implement to it. A reference implementation exists at `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex/scripts/codex.ts` that you may copy from if present, but grading is against the spec here, not that path. Reshape into the `Backend` contract from the shared types. Binary via `CODEX_BIN` env (default `codex`).

Behaviours that constitute the "odin-codex superset" (must all be present): delegate via `codex exec` (workspace-write + dangerous toggle), native review with `--uncommitted`/`--base`/`--commit`, custom-file-scope review via read-only `codex exec`, image via gpt-image-2 with PNG discovery + copy to `--out`, and `-o <lastFile>` output capture. No other odin-codex behaviour is in scope.

```ts
export const codexBackend: Backend = {
  name: "codex",
  supports: new Set(["delegate", "review", "image"]),
  strategy(mode, opts) {
    // review is native unless a custom file scope was requested (then "prompt")
    if (mode === "review") return opts.scope === "custom-files" ? "prompt" : "native";
    if (mode === "delegate") return "prompt";
    return "native"; // image
  },
  invoke(mode, opts) { /* returns { argv, stdin? } per cli-reference.md */ },
  parseOutput(raw) { return raw; },
  postRun(mode, parsed, opts) {
    if (mode !== "image") return parsed;
    // locate the generated PNG (extractGeneratedPngPath(parsed) ?? findNewestPng(...)),
    // copy it to addTimestampSuffix(opts.out), return `Image saved: <finalPath>`.
  },
};
```

The `postRun` hook is how the codex-only image copy happens without `relay.ts` branching on backend name — `relay.ts` calls `postRun` generically for every backend; only codex defines it.

argv per mode (see `cli-reference.md`). The prompt body always arrives as `opts.promptText` (relay.ts reads the prompt file); the backend never reads files itself:
- **delegate** (strategy=prompt): `codex exec -s workspace-write -a never -o <opts.lastFile> -`, `stdin = opts.promptText`. `opts.dangerous` → `codex exec --dangerously-bypass-approvals-and-sandbox -o <opts.lastFile> -`.
- **review native**: `codex review` + scope flag — `--uncommitted` | `--base <ref>` | `--commit <sha>` parsed from `opts.scope`.
- **review prompt fallback** (custom files): `codex exec -s read-only -o <opts.lastFile> -`, `stdin = opts.promptText`.
- **image**: `codex exec -o <lastfile> "<imagePrompt>"` where `imagePrompt = "Generate an image of: <opts.focus or task>. Use gpt-image-2."`.
- **model**: never pass `-m` (codex unset).

Image PNG handling (port the helpers):
```ts
export function buildImagePrompt(prompt: string): string;
export function extractGeneratedPngPath(output: string): string | null; // scan output for an existing *.png
// baseDir is injectable so tests point it at a fixture dir, not the real home.
export function findNewestPng(after: Date, baseDir?: string): string | null; // default baseDir = join(homedir(), ".codex/generated_images")
```
After an image run, resolve the source PNG (extract-from-output → fallback newest) and copy to `opts.out` via `addTimestampSuffix` from `../shared`. Tests pass a temp `baseDir` containing PNG files with controlled mtimes to verify the newest-after-`after` selection deterministically.

`invoke` stays pure (returns argv/stdin); `relay.ts` owns the spawn + `-o <lastFile>` capture, then calls `postRun`. The image PNG copy lives in `codexBackend.postRun` (the generic seam). Keep `buildImagePrompt` and the PNG-path-resolution functions **pure and unit-tested**; the `cp`/copy side effect is the only impurity, isolated inside `postRun`.

## Acceptance criteria

- [x] `codexBackend.supports` = `{delegate, review, image}`.
- [x] `strategy` returns `native` for default review, `prompt` for custom-file review, `prompt` for delegate, `native` for image.
- [x] delegate argv uses `-s workspace-write -a never`; `dangerous` switches to the bypass flag.
- [x] review native argv maps `uncommitted`/`base:<ref>`/`commit:<sha>` to the correct codex flags.
- [x] `buildImagePrompt` produces the gpt-image-2 line; `extractGeneratedPngPath`/`findNewestPng` resolve a PNG path.
- [x] `postRun` returns `parsed` unchanged for delegate/review, and for image copies the PNG to `opts.out` (timestamp-suffixed) and returns `Image saved: <path>`.
- [x] No `-m` flag is ever emitted for codex.

## Verification

- [x] `bun test packages/relay/skills/relay/scripts/backends/codex.test.ts` passes.
- [x] Tests cover: each mode's argv; scope→flag mapping; dangerous toggle; `buildImagePrompt` text; `extractGeneratedPngPath` hit/miss; `findNewestPng` against a temp fixture `baseDir` (newest-after-`after` selection). No real `codex` spawn.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | argv wrong or image path broken | core modes ok but a branch (dangerous/scope/fallback) drifts | every mode argv + strategy + image resolution matches the spec; all five superset behaviours present |
| Test coverage | ×2 | no tests | argv happy path only | all modes + scope mapping + image path hit/miss |
| Interface & readability | ×1 | spawn baked into pure argv builder | usable but I/O leaks | argv + PNG-resolution pure; spawn/copy isolated |
| Assumptions & docs | ×1 | image dir/CLI assumptions unstated | present | `~/.codex/generated_images`, `CODEX_BIN`, gpt-image-2 noted |

## Out of scope

- Changing codex's sandbox defaults — Deferred. Reason: preserve odin-codex semantics (`-s workspace-write -a never`).
