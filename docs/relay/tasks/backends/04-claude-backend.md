# BACKENDS-04: Claude backend

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Status**: todo

## Goal

Implement the claude `Backend`: delegate via `claude -p` and native review via `claude -p "/code-review …"`, parsing the structured `--output-format json` envelope.

## Files to create / modify

- `packages/relay/skills/relay/scripts/backends/claude.ts` (new) — `claudeBackend: Backend`.
- `packages/relay/skills/relay/scripts/backends/claude.test.ts` (new) — argv + output-parse tests.

## Implementation notes

Binary `claude`. delegate uses `strategy = "prompt"`; review uses `strategy = "native"` (the `/code-review` command gathers its own diff context — no built prompt). Model unset (claude uses its session default).

```ts
export const claudeBackend: Backend = {
  name: "claude",
  supports: new Set(["delegate", "review"]),
  strategy(mode) { return mode === "review" ? "native" : "prompt"; },
  invoke(mode, opts) {
    // delegate (prompt): ["claude", "-p", <promptText>, "--output-format", "json"]
    // review  (native):  ["claude", "-p", `/code-review ${effort}${focus ? " " + focus : ""}`]
    //   effort from opts.focus-style input or default "high"; NEVER pass --fix (review = report-only)
  },
  parseOutput(raw) { /* see below */ },
};
```

Output parsing (`cli-reference.md`). `claude -p --output-format json` emits a single result envelope of this shape (the assistant text lives in `.result`):

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "<final assistant text>", "session_id": "…", "total_cost_usd": 0.01 }
```

Extraction order in `parseOutput` (tolerant — never throw):
1. `JSON.parse(raw)`; if it fails, return `raw.trim()` (covers review's plain-text `/code-review` output, which is not JSON).
2. If the parsed object has a string `.result`, return it.
3. Else if it has `.text` or a `content[0].text` string, return that.
4. Else return `raw.trim()`.

Unit tests assert this against the fixture above (and a non-JSON string) — no real `claude` spawn required.

Same prompt-text seam as the opencode backend: delegate needs the prompt **text** (claude has no `--prompt-file`), so the relay entry point reads the prompt file and passes the text through the shared `InvokeOpts.promptText` field. Consume `opts.promptText` — do not read files in the backend or invent a second mechanism.

`effort` for review: accept low/medium/high/ultra; default `high`. Treat `opts.focus` as either an effort token or a focus phrase — document the parsing rule chosen (e.g. first token if it matches an effort level, remainder as focus).

## Acceptance criteria

- [ ] `claudeBackend.supports` = `{delegate, review}` (no image).
- [ ] `strategy` = `native` for review, `prompt` for delegate.
- [ ] delegate argv: `claude -p <text> --output-format json`.
- [ ] review argv: `claude -p "/code-review <effort> [focus]"`; never includes `--fix`; default effort `high`.
- [ ] `parseOutput` follows the documented extraction order (`.result` → `.text`/`content[0].text` → raw) and falls back to raw stdout on parse failure (no throw).

## Verification

- [ ] `bun test packages/relay/skills/relay/scripts/backends/claude.test.ts` passes.
- [ ] Tests cover: delegate argv; review argv with default + explicit effort + focus; `parseOutput` on valid JSON and on non-JSON (fallback). No real `claude` spawn.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | wrong command or `--fix` leaks into review | core ok but effort/focus parsing drifts | correct delegate + `/code-review` argv; report-only; robust JSON parse |
| Test coverage | ×2 | no tests | argv only | argv (both modes, effort variants) + JSON valid/invalid parse |
| Interface & readability | ×1 | spawn in invoke | usable | pure argv/parse; shared prompt-text seam reused |
| Assumptions & docs | ×1 | envelope assumptions unstated | present | JSON envelope field + effort-parsing rule documented |

## Out of scope

- `/review` (PR-scoped) support — Deferred. Reason: relay review targets the working diff; `/code-review` is the chosen native path.
- Applying `--fix` automatically — Deferred. Reason: review is report-only; smart-apply is the host agent's job.
