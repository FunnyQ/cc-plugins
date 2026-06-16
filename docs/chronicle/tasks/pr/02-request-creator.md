# PR-02: request-creator script

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: pr/03
> **Status**: todo

## Goal

Build `request-creator.ts`: given a confirmed PR/MR payload, open the request via the right CLI (`gh` for GitHub, `glab` for GitLab) and return the URL, degrading gracefully when the CLI or remote is missing.

## Files to create / modify

- `packages/chronicle/skills/pr/scripts/request-creator.ts` (new) — the create step.
- `packages/chronicle/skills/pr/scripts/request-creator.test.ts` (new) — unit tests with a mocked runner.

## Implementation notes

This is the **execute fork's** tool. It does NOT detect the provider — it receives it (detected upstream by the analysis script). Keep the CLI spawn injectable so tests don't shell out.

### Input + output

```ts
type CreateInput = {
  provider: "github" | "gitlab";
  title: string;
  body: string;
  base: string;   // target branch
  head: string;   // source branch
  draft: boolean;
};

type CreateResult =
  | { ok: true; url: string }
  | { ok: false; reason: "missing-cli" | "no-remote" | "cli-error"; message: string };

// Injectable runner so tests don't spawn real processes.
type Runner = (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function buildArgs(input: CreateInput): string[]   // pure — the gh/glab argv
export async function createRequest(input: CreateInput, run: Runner): Promise<CreateResult>
```

### Command shapes (pure `buildArgs`)

- **github**: `gh pr create --base <base> --head <head> --title <title> --body <body>` plus `--draft` when `draft`.
- **gitlab**: `glab mr create --source-branch <head> --target-branch <base> --title <title> --description <body>` plus `--draft` when `draft`; add `--yes` to avoid the interactive prompt.

### createRequest behavior

1. Pick the binary (`gh` / `glab`) from `provider`.
2. Pre-flight: if the binary isn't on `PATH` → `{ ok:false, reason:"missing-cli", message }` with a hint to install it. (Check via the runner, e.g. `command -v`, or catch ENOENT from the spawn.)
3. Run `buildArgs`. On exit 0, parse the URL from stdout (both CLIs print the created URL; take the last `https://...` token) → `{ ok:true, url }`.
4. Non-zero exit whose stderr indicates no remote/repo → `reason:"no-remote"`; otherwise `reason:"cli-error"` with the stderr message.

The CLI default entry (`import.meta.main`) reads a JSON `CreateInput` from argv/stdin, calls `createRequest` with a real Bun-spawn runner, and prints the `CreateResult` as JSON.

### Tests (mock the runner)

- `buildArgs`: github non-draft, github draft (`--draft` present), gitlab draft (`--source-branch`/`--target-branch` correct, `--yes` present).
- `createRequest`: runner returns exit 0 + a URL → `{ok:true,url}`; runner reports missing binary → `reason:"missing-cli"`; exit non-zero with "not a git repository"/"no remote" stderr → `reason:"no-remote"`; other non-zero → `reason:"cli-error"`.

## Acceptance criteria

- [ ] Script exists; imports only Bun built-ins + `node:` stdlib.
- [ ] `buildArgs` is pure and produces correct argv for github + gitlab, with/without draft.
- [ ] `createRequest` takes an injectable runner and never spawns in tests.
- [ ] Missing CLI, no remote, and generic CLI error each map to the right `reason` without throwing.
- [ ] On success it extracts and returns the PR/MR URL.
- [ ] CLI mode reads a `CreateInput` JSON and prints a `CreateResult` JSON.

## Verification

- [ ] `bun test packages/chronicle/skills/pr/scripts/request-creator.test.ts` is green (no network, no real `gh`/`glab`).
- [ ] `echo '{"provider":"github","title":"t","body":"b","base":"develop","head":"x","draft":true}' | bun packages/chronicle/skills/pr/scripts/request-creator.ts` returns a structured `CreateResult` (likely `missing-cli`/`cli-error` outside a real repo — that's a pass, it must not throw).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.2 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×4 | wrong argv / throws on missing CLI | works for github but gitlab flags wrong, or error mapping coarse | correct argv both providers, all failure reasons mapped, URL parsed |
| Test coverage | ×2 | no tests | only buildArgs | buildArgs both providers + all createRequest branches via mocked runner |
| Interface & readability | ×1 | spawn hard-wired, untestable | injectable but messy | clean Runner injection, pure buildArgs, typed result union |
| Assumptions & docs | ×1 | failure modes silent | partial | each reason documented, install hint included |

## Out of scope

- Provider detection — Deferred. Received from the analysis payload, not computed here.
- Editing / merging an existing PR/MR — Deferred to future review/merge skills.
