# Backend Reference — CLI flags, headless output, and install

> Verified on Q's machine (2026-06-15). Each backend section translates a `relay` mode into the canonical CLI invocation.

## codex

Binary: `codex` (override via `CODEX_BIN`).

### Delegate (write-capable)

```bash
codex exec -s workspace-write -a never -o <lastfile> -
```

Dangerous opt-in (only if user explicitly asks):
```bash
codex exec --dangerously-bypass-approvals-and-sandbox -o <lastfile> -
```

### Review (native — operates on git itself)

```bash
codex review --uncommitted
codex review --base <ref>
codex review --commit <sha>
```

### Review (custom-file scope — degrades to prompt-based)

```bash
codex exec -s read-only -o <lastfile> -
```

### Image (codex-only)

```bash
codex exec -o <lastfile> "<image prompt>"
```

Generated PNGs land under `~/.codex/generated_images/`; locate the newest after the run (or parse a `*.png` path from output) and `cp` it to `--out` (timestamp-suffixed).

### Model

Unset — codex uses its own configured/last-used model. Do not pass `-m`.

### Output capture

`-o <lastfile>` writes the final message to a file; read it, fall back to stdout if absent.

---

## opencode (1.17.6)

Binary: `opencode`. Headless subcommand: `opencode run [message..]`.

### Delegate

```bash
opencode run -m opencode-go/kimi-k2.7-code "<prompt>"
```

Write-capable by default.

### Review (emulated, read-only prompt)

```bash
opencode run -m opencode-go/qwen3.7-max "<read-only review prompt>"
```

There is no native review; the prompt must instruct "analyze only, do not modify files." (Hard read-only via a `--agent` with `edit/bash: deny` is deferred.)

### Relevant flags

- `-m, --model <provider/model>` — model specification (required)
- `--agent <name>` — agent profile (optional)
- `--format <default|json>` — output format

### Output parsing

**Preferred (v1):** `--format default` → formatted text straight to stdout (simplest).

**Alternative:** `--format json` → JSONL (one JSON object per line).
- Extract final text via: `jq -r 'select(.type=="text") | .part.text'`
- KNOWN BUG #26855: `run --format json` can exit before emitting the terminal `step_finish` event. Mitigation: do not rely on seeing a terminal event — concatenate all `text` parts captured.

### Model

Resolved per mode (opencode-go/kimi-k2.7-code for delegate; opencode-go/qwen3.7-max for review). `--model` flag overrides. Format is `provider/model`.

---

## claude

Binary: `claude`. Headless: `claude -p "<prompt>"`.

### Delegate

```bash
claude -p "<prompt>" --output-format json
```

Parse the JSON envelope for the final assistant text.

### Review (native)

```bash
claude -p "/code-review <effort> [focus]"
```

Supports effort levels: low, medium, high, ultra. Relay does **not** pass `--fix` (review = report-only). Do not use `/review` (that is PR-scoped).

### Model

Unset — claude uses its session/configured default.

---

## Installation

### Claude Code / Codex

Installed via the marketplace registries (`marketplace.json`). No manual step required.

### OpenCode

OpenCode reads from `~/.claude/skills/` (and `~/.config/opencode/skills/`). Install relay once:

```bash
ln -s <repo>/packages/relay/skills/relay ~/.claude/skills/relay
```

Replace `<repo>` with the absolute path to the cc-plugins repository. Example:

```bash
ln -s /Users/funnyq/Projects/q-lab/cc-plugins/packages/relay/skills/relay ~/.claude/skills/relay
```

The skill's frontmatter (`name`, `description`) is portable across all three harnesses. OpenCode also honors optional `user-invocable` and `argument-hint` fields.

---

## Known Caveats

- **#26855 (opencode):** JSON format output may exit before the terminal `step_finish` event. If using `--format json`, concatenate all `text` parts captured; do not block waiting for a closing event.
- **Image (codex-only):** `/relay opencode image` and `/relay claude image` fail fast before any CLI invocation.
- **Claude review:** Uses `/code-review`, not `/review` (the latter is PR-scoped and unavailable headlessly).
