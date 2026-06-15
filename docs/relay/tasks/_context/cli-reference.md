# CLI reference — headless invocation ground truth

> Verified on Q's machine (2026-06-15). Each backend translates a `relay` mode into one of these invocations. Authoritative for argv construction and output parsing.

## codex

Port source: `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex/scripts/codex.ts`. Binary: `codex` (override via `CODEX_BIN`).

- **delegate** (write-capable):
  `codex exec -s workspace-write -a never -o <lastfile> -` with the prompt on stdin.
  Dangerous opt-in (only if user explicitly asks): `codex exec --dangerously-bypass-approvals-and-sandbox -o <lastfile> -`.
- **review, native** — operates on git itself, no prompt needed:
  `codex review --uncommitted` | `codex review --base <ref>` | `codex review --commit <sha>`.
- **review, custom-file scope (strategy degrades to prompt)** — read-only exec with a built review prompt:
  `codex exec -s read-only -o <lastfile> -` with prompt on stdin.
- **image** (codex-only): `codex exec -o <lastfile> "<image prompt>"`. Prompt text: `Generate an image of: <prompt>. Use gpt-image-2.`. Generated PNGs land under `~/.codex/generated_images/`; locate the newest after the run (or parse a `*.png` path from output) and `cp` it to `--out` (timestamp-suffixed).
- **model**: unset — codex uses its own configured/last-used model. Do not pass `-m`.
- **output capture**: `-o <lastfile>` writes the final message to a file; read it, fall back to stdout if absent.

## opencode (1.17.6)

Binary: `opencode`. Headless subcommand: `opencode run [message..]`.

- **delegate**: `opencode run -m opencode-go/kimi-k2.7-code "<prompt>"` (write-capable by default).
- **review (emulated, read-only prompt)**: `opencode run -m opencode-go/qwen3.7-max "<read-only review prompt>"`. There is no native review; the prompt must instruct "analyze only, do not modify files". (Hard read-only via a `--agent` with `edit/bash: deny` is deferred.)
- **model**: resolved default per mode (above); `--model` flag overrides. Format is `provider/model`.
- **relevant flags**: `-m, --model <provider/model>`, `--agent <name>`, `--format <default|json>`.
- **output parsing**:
  - `--format default` → formatted text straight to stdout (simplest; **preferred for v1**).
  - `--format json` → JSONL (one JSON object per line); final text via lines where `.type == "text"` → `.part.text`. Extract with `jq -r 'select(.type=="text") | .part.text'`.
  - **KNOWN BUG #26855**: `run --format json` can exit before emitting the terminal `step_finish` event. Mitigation: prefer default formatted stdout; if using JSON, do not rely on seeing a terminal event — concatenate all `text` parts captured. Never block waiting for `step_finish`.

## claude

Binary: `claude`. Headless: `claude -p "<prompt>"` (print mode).

- **delegate**: `claude -p "<prompt>" --output-format json`. Parse the JSON envelope for the final assistant text (`--output-format json` yields a structured result object; fall back to raw stdout for `--output-format text`).
- **review (native)**: `claude -p "/code-review <effort> [focus]"` — `/code-review` reviews the working diff; supports effort levels (low/medium/high/ultra). relay does **not** pass `--fix` (review = report-only). Do not use `/review` (that is PR-scoped).
- **model**: unset — claude uses its session/configured default.

## Distribution recap

- **Claude Code / Codex**: installed via the marketplace registries; no manual step.
- **OpenCode**: reads `~/.claude/skills/` (and `~/.config/opencode/skills/`). Install = symlink the skill folder once:
  `ln -s <repo>/packages/relay/skills/relay ~/.claude/skills/relay`.
  SKILL.md frontmatter (`name`/`description`) is identical across all three; opencode also honors optional `user-invocable` / `argument-hint`.
