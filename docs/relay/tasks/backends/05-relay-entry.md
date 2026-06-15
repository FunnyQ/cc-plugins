# BACKENDS-05: Relay entry point

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: backends/01, backends/02, backends/03, backends/04, core/03
> **Status**: done

## Goal

Wire the CLI entry `relay.ts` that ties the layers together: parse `<backend> <mode>`, gate, resolve strategy, build a prompt when needed, invoke the backend, and honor the output contract (full stdout + temp file).

## Files to create / modify

- `packages/relay/skills/relay/scripts/backends/index.ts` (new) — assemble the concrete `BACKENDS` registry (imports all three backend files).
- `packages/relay/skills/relay/scripts/relay.ts` (new) — CLI entry + dispatch.
- `packages/relay/skills/relay/scripts/relay.test.ts` (new) — dispatch/gate/flag-parse unit tests.

## Implementation notes

```
relay <backend> <mode> [flags]
  flags: --task <text> | --files <csv> | --focus <text>
         --scope <uncommitted|base:<ref>|commit:<sha>|custom-files>
         --model <provider/model> | --out <path> | --git-scope <s> | --no-project
         --prompt-file <p>   (optional override — skip internal prompt building)
         --dangerous
```

The entry point is **single-step**: for prompt strategy it builds the prompt itself (via the imported `buildPromptFile`) from `--task`/`--focus`/`--files`, so `relay codex delegate --task "x"` works without a separate prompt step. `--prompt-file` is an optional override for a pre-built prompt.

**Trailing positional text** (everything after `<backend> <mode>` that isn't a flag) is joined into one string and used as: the **task** for delegate, the **image prompt** for image, the **focus** for review. Explicit `--task`/`--focus` take precedence over the positional. So `relay codex image "a cat" --out a.png` and `relay codex delegate "refactor X"` both work, equivalent to the `--task`/positional forms.

First, assemble the registry in `backends/index.ts`:

```ts
import type { Backend } from "../types";
import { codexBackend } from "./codex";
import { opencodeBackend } from "./opencode";
import { claudeBackend } from "./claude";
export const BACKENDS: Record<string, Backend> = {
  codex: codexBackend, opencode: opencodeBackend, claude: claudeBackend,
};
```
`relay.ts` imports `BACKENDS` from `./backends` and `getBackend`/`capabilityGate` from `./backends/gate`.

Dispatch flow:
1. `parseFlags` extracts the raw `backend` + `mode` strings (it does **not** hardcode the valid set). Validation happens at dispatch: `const b = getBackend(BACKENDS, backend)`; if `undefined` → usage error listing `Object.keys(BACKENDS).join("|")` (so a 4th backend needs no parser edit). Mode is validated against the `Mode` union (`delegate|review|image`).
2. `const err = capabilityGate(b, mode)`; if `err` → `stderr.write(err)` + `exit 1` **before any spawn**.
3. `resolveModel(backend, mode, flags.model)` → resolved model into `InvokeOpts`.
4. **Create the tmp run dir + capture path up front**: `const dir = createTmpRunDir(); opts.lastFile = join(dir, "raw.txt")`. `raw.txt` is the backend's raw capture (codex's `-o <lastFile>`); it is distinct from the durable contract artifact `last.md` written in step 8 — two different files, no ambiguity.
5. `const strat = b.strategy(mode, opts)`:
   - `strat === "prompt"`: obtain the prompt file — use `--prompt-file` if given, else call `buildPromptFile({ kind: mode, files, focus, task, gitScope, noProject })` (imported from the prompt module). **`relay.ts` reads the file once and sets `opts.promptText` for every prompt backend** (and keeps `opts.promptFile` too). Each backend consumes `opts.promptText` only — opencode/claude pass it as the message arg, codex returns it as `stdin`. No backend reads the file itself, and no codex-specific branch exists in `relay.ts`.
   - `strat === "native"`: no prompt file; use `--scope`/`--focus`.
6. `const { argv, stdin } = b.invoke(mode, opts)`.
7. Spawn via `run(argv, { stdin })` from `./shared`. Capture output: if `opts.lastFile` (`raw.txt`) was written (codex), read that file; otherwise use stdout. `const parsed = b.parseOutput(raw)`, then `const final = b.postRun ? b.postRun(mode, parsed, opts) : parsed` — this is where codex's image copy happens, with no backend-name branching.
8. **Output contract**: write `final` to `<dir>/last.md` (the durable contract artifact, distinct from `raw.txt`) AND print it to stdout. For image, `final` is the `Image saved: <path>` line returned by codex's `postRun`.
9. On non-zero CLI exit or empty output: write stderr summary + exit with the CLI's code. Never fabricate output.

Keep `parseFlags(argv): {backend, mode, flags}` a pure exported function (unit-tested). The spawn/file-write side effects live in a `main()` guarded by `import.meta.main`.

Note: `relay.ts` must go through `getBackend` + `capabilityGate` only — it must not branch on backend name (`if (backend === "codex")`). Backend-specific behaviour lives in the backend objects.

## Acceptance criteria

- [x] `parseFlags` exported + pure; extracts raw `<backend> <mode>` strings + trailing positional text (→ task/image-prompt/focus by mode, flags win) + all listed flags — it does NOT hardcode the valid backend set.
- [x] Unknown backend is rejected at dispatch with a message listing `Object.keys(BACKENDS)` (adding a backend needs no parser edit); unknown mode rejected against the `Mode` union.
- [x] Capability gate runs before any spawn; `relay opencode image` exits non-zero with the gate message and never spawns.
- [x] Single-step: `relay <backend> delegate --task "x"` builds the prompt internally (via `buildPromptFile`) and runs — no pre-built `--prompt-file` required; `--prompt-file` works as an override.
- [x] strategy=prompt obtains the prompt file (override or built); strategy=native uses scope/focus; selection comes from `b.strategy`, not a name check.
- [x] Output contract: a successful run writes `last.md` under `/tmp/relay/...` and prints identical text to stdout.
- [x] No `if (backend === ...)` branching in dispatch — verified by reading the file.

## Verification

- [x] `bun test packages/relay/skills/relay/scripts/relay.test.ts` passes.
- [x] Tests cover: `parseFlags` for each mode + bad input; gate rejection path (no spawn); strategy selection per (backend, mode) using the real backends. Spawning is mocked/avoided (test the pure dispatch decisions).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | gate bypassable or output contract missing | dispatch works but a strategy/output branch drifts | gate-before-spawn; correct strategy routing; output contract honored; no name branching |
| Test coverage | ×2 | no tests | flag parse only | parse + gate rejection + strategy selection across cells |
| Interface & readability | ×1 | name-based branching | usable but mixes parse + spawn | pure parseFlags + gate/strategy routing; side effects isolated |
| Assumptions & docs | ×1 | capture seam unexplained | present | `-o lastfile` vs stdout capture + prompt-text seam documented |

## Out of scope

- Smart-apply of results — Deferred. Reason: that is the host agent's judgment, specified in SKILL.md.
- The agent's file-picking judgment — Deferred. Reason: the host agent decides which `--files` to pass; relay just consumes them.
