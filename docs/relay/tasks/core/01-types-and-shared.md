# CORE-01: Types and shared utilities

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: core/03, backends/01
> **Status**: done

## Goal

Provide the shared type vocabulary and mechanical utilities every other relay script builds on: the `Backend` contract, a `run()` spawn wrapper, temp-run-dir/timestamp helpers, and model resolution with config + flag precedence.

## Files to create / modify

- `packages/relay/skills/relay/scripts/types.ts` (new) — `Mode`, `Strategy`, `Backend`, `RunResult`, related option types.
- `packages/relay/skills/relay/scripts/shared.ts` (new) — `run()`, `createTmpRunDir()`, timestamp helpers, `TMP_ROOT`, model resolution.
- `packages/relay/skills/relay/scripts/shared.test.ts` (new) — unit tests for the pure parts.

## Implementation notes

### types.ts

```ts
export type Mode = "delegate" | "review" | "image";
export type Strategy = "native" | "prompt";

export type RunResult = { ok: boolean; stdout: string; stderr: string; code: number };

// What relay.ts hands a backend after parsing argv + (maybe) building a prompt.
// This is the single shared seam — backends must not invent their own extensions.
export type InvokeOpts = {
  promptFile?: string;   // path to the built prompt (strategy === "prompt"); codex feeds it on stdin
  promptText?: string;   // prompt body already read from promptFile, for CLIs with no --prompt-file flag (opencode/claude)
  task?: string;         // raw task/focus text (e.g. codex image prompt source)
  scope?: string;        // native review scope: "uncommitted" | "base:<ref>" | "commit:<sha>" | "custom-files"
  focus?: string;        // user's specific concern (review) / effort level
  out?: string;          // image output path
  model?: string;        // resolved model (may be undefined → CLI default)
  lastFile?: string;     // pre-created output-capture path (codex `-o <lastFile>`); relay creates the tmp dir first
  dangerous?: boolean;   // delegate sandbox opt-out
};

export type Backend = {
  name: string;   // registry key (codex/opencode/claude today) — string so a 4th backend needs no core edit
  supports: Set<Mode>;
  strategy(mode: Mode, opts: InvokeOpts): Strategy;
  // Build the argv (and optional stdin) for this mode. Pure — no spawning here.
  invoke(mode: Mode, opts: InvokeOpts): { argv: string[]; stdin?: string };
  // Extract clean final text from a completed run (file content or stdout).
  parseOutput(raw: string): string;
  // Optional post-run step run by relay.ts AFTER the spawn + parseOutput. Receives the parsed
  // text + opts, returns the final text relay prints. This is the generic seam for backend-only
  // side effects (e.g. codex image: locate the PNG, copy it to opts.out, return "Image saved: <path>").
  // relay.ts calls `b.postRun ? b.postRun(mode, parsed, opts) : parsed` — no backend-name branching.
  postRun?(mode: Mode, parsed: string, opts: InvokeOpts): string;
};
```

### shared.ts

Mirror odin-codex's helpers (port source in `cli-reference.md`):

```ts
export const TMP_ROOT = "/tmp/relay";

export function run(args: string[], opts?: { stdin?: string }): RunResult; // Bun.spawnSync wrapper
export function createTmpRunDir(): string;          // TMP_ROOT/<ts>-<pid>-<rand8>, mkdir -p, returns path
export function timestampForPath(now?: Date): string;
export function addTimestampSuffix(filePath: string): string; // foo.png -> foo_YYYYMMDD-HHMM.png
```

Model resolution — precedence `--model` flag > config file > built-in constants:

```ts
export const DEFAULT_MODELS: Record<string, Partial<Record<Mode, string>>> = {
  codex: {},                                              // unset → CLI default
  claude: {},                                             // unset → CLI default
  opencode: {
    delegate: "opencode-go/kimi-k2.7-code",
    review: "opencode-go/qwen3.7-max",
  },
};

export const CONFIG_PATH =
  join(homedir(), ".config", "q-lab", "cc-plugins", "relay", "config.json");
// config shape: { models?: { [backend]: { [mode]: "provider/model" } } }

// flagModel wins; else config.models[backend][mode]; else DEFAULT_MODELS[backend][mode]; else undefined.
export function resolveModel(
  backend: string, mode: Mode, flagModel?: string,
  readConfig?: () => unknown,   // injectable for tests; defaults to reading CONFIG_PATH
): string | undefined;
```

`resolveModel` must be pure given an injected `readConfig` so tests don't touch the filesystem. Reading a missing/malformed config file returns `undefined` silently (never throw).

## Acceptance criteria

- [x] `types.ts` exports `Mode`, `Strategy`, `RunResult`, `InvokeOpts`, `Backend` exactly as above (uses `type`, not `interface`).
- [x] `InvokeOpts` is the complete shared seam — it carries `promptFile`, `promptText`, `task`, `scope`, `focus`, `out`, `model`, `lastFile`, `dangerous`, so no downstream backend needs to extend it. (`lastFile` and the tmp dir are created by the relay entry point before `invoke()` is called.)
- [x] `shared.ts` exports `run`, `createTmpRunDir`, `timestampForPath`, `addTimestampSuffix`, `resolveModel`, `TMP_ROOT`, `DEFAULT_MODELS`, `CONFIG_PATH`.
- [x] `resolveModel` returns flag > config > constant, and `undefined` for codex/claude with no flag/config.
- [x] Malformed/missing config never throws; `resolveModel` falls back cleanly.
- [x] `addTimestampSuffix("./a.png")` returns `./a_<ts>.png`; `createTmpRunDir()` returns a path under `/tmp/relay`.

## Verification

- [x] `bun test packages/relay/skills/relay/scripts/shared.test.ts` passes.
- [x] Tests cover: each `resolveModel` precedence branch (flag, config hit, constant fallback, undefined), malformed config, and `addTimestampSuffix` shape.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong precedence or throws on bad config | precedence ok but edge cases (undefined, malformed) drift | flag>config>constant exact; missing/malformed config safe; helpers match odin-codex behaviour |
| Test coverage | ×2 | no tests | only one precedence branch | all precedence branches + malformed config + timestamp shape |
| Interface & readability | ×1 | I/O baked into resolveModel | usable but config read not injectable | resolveModel pure via injected reader; clear `type`s |
| Assumptions & docs | ×1 | model ids/paths unlabeled | present but unexplained | model ids + CONFIG_PATH + TMP_ROOT labeled constants |

## Out of scope

- The actual prompt building and CLI dispatch — Deferred. Reason: those live in the prompt builder and the backends layer; this task is types + mechanics only.
- A config-write helper — Deferred. Reason: saving `--model` to config is agent-driven (SKILL.md), v1 scripts only read.
