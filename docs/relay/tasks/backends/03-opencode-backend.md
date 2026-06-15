# BACKENDS-03: OpenCode backend

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Status**: todo

## Goal

Implement the opencode `Backend`: delegate + emulated (prompt-based, read-only) review via `opencode run`, with per-mode model defaults and robust output parsing that tolerates the `--format json` early-exit bug.

## Files to create / modify

- `packages/relay/skills/relay/scripts/backends/opencode.ts` (new) — `opencodeBackend: Backend`.
- `packages/relay/skills/relay/scripts/backends/opencode.test.ts` (new) — argv + JSONL parse tests.

## Implementation notes

Binary `opencode`. Both modes use `strategy = "prompt"` (no native review). Model defaults resolved via `resolveModel("opencode", mode, opts.model)` from `../shared` — delegate `opencode-go/kimi-k2.7-code`, review `opencode-go/qwen3.7-max`; `--model` overrides.

```ts
export const opencodeBackend: Backend = {
  name: "opencode",
  supports: new Set(["delegate", "review"]),
  strategy() { return "prompt"; },
  invoke(mode, opts) {
    // prompt text comes from the prompt-file (read by relay.ts) and is passed as the message arg
    // argv: ["opencode", "run", "-m", <resolved model>, "--format", "default", <promptText>]
  },
  parseOutput(raw) { /* see below */ },
};
```

Output parsing (`cli-reference.md`):
- **v1 uses `--format default`** → `parseOutput` just trims the formatted stdout.
- Also export a `parseJsonl(raw: string): string` helper that concatenates `.part.text` from lines where `.type === "text"` — used if/when JSON mode is enabled. It must **not** require a terminal `step_finish` line (bug #26855): parse whatever text parts exist, ignore malformed lines.

Note on prompt passing: opencode has no `--prompt-file` flag, so the backend receives the prompt **text** via the shared `InvokeOpts.promptText` field (the relay entry point reads the prompt file and populates it). `invoke` stays pure by consuming `opts.promptText` — do not read files inside the backend, and do not invent a new option (the shared contract already carries `promptText`).

Read-only guarantee for review is **prompt-based only** (the builder's "Analyze only — do not modify any files" line); document this limitation in a comment. Hard read-only via `--agent` is deferred.

## Acceptance criteria

- [ ] `opencodeBackend.supports` = `{delegate, review}` (no image).
- [ ] `strategy()` always returns `"prompt"`.
- [ ] delegate argv carries `-m opencode-go/kimi-k2.7-code`; review carries `-m opencode-go/qwen3.7-max`; `opts.model` overrides both.
- [ ] `parseOutput` trims formatted stdout; `parseJsonl` concatenates `text` parts and ignores malformed/absent terminal events.
- [ ] A comment flags the prompt-based (non-enforced) read-only review and bug #26855.

## Verification

- [ ] `bun test packages/relay/skills/relay/scripts/backends/opencode.test.ts` passes.
- [ ] Tests cover: model default per mode + `--model` override; `parseJsonl` with multiple text parts, a malformed line, and missing `step_finish`. No real `opencode` spawn.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong model/argv or JSONL parse breaks on the bug | core ok but override or malformed-line handling drifts | correct per-mode model + override; JSONL parse robust to #26855 |
| Test coverage | ×2 | no tests | argv only | model resolution + JSONL edge cases (malformed, no terminal event) |
| Interface & readability | ×1 | spawn in invoke | usable | pure argv/parse; seam for prompt text documented |
| Assumptions & docs | ×1 | bug/limitation unmentioned | one noted | #26855 + non-enforced read-only both flagged in comments |

## Out of scope

- Hard read-only via a shipped `--agent` — Deferred. Reason: v1 relies on the review prompt; the agent file is a later enhancement.
- `opencode serve` + SDK output capture — Deferred. Reason: stdout scraping is sufficient for v1.
