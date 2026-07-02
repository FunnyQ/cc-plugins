# Backend Reference — CLI flags, headless output, and install

> Verified on Q's machine (2026-06-15). Each backend section translates a `relay` mode into the canonical CLI invocation.

## Live-pane mode (herdr)

Inside herdr (`HERDR_ENV=1`), delegate/review launch the backend's **interactive TUI** in **its own new tab** (not a split of the caller's pane, so your working pane keeps its full size) instead of the headless invocations below (`--headless` opts out). The prompt rides a file (`live-prompt.md`); the pane only receives a one-line bootstrap; the answer is captured from `result.md` via an end-marker contract. Motivation: the work becomes visible and take-over-able, and it sidesteps headless flakiness — opencode's `run` in particular can hang around the #26855 family.

Per-backend live launch (argv extras only — never `exec`/`-p`/`-o`):

| Backend | TUI binary | `--model` mapping | `--dangerous` (YOLO) mapping |
|---|---|---|---|
| codex | `codex` (`CODEX_BIN`) | `-m <model>` | `--dangerously-bypass-approvals-and-sandbox` |
| claude | `claude` | `--model <model>` | `--dangerously-skip-permissions` |
| opencode | `opencode` | `-m <model>` | `--auto` (auto-approve permissions not explicitly denied) |

`--dangerous` is a **uniform YOLO switch** across all three live backends: it lets an **unattended** run proceed without stopping on approval prompts. Without `--dangerous`, no sandbox/approval-bypass flag is passed and the TUI's own approval prompts surface **in the pane**, where a human can answer them — the point of a *visible* live pane. So: `--dangerous` = fire-and-forget; no flag = supervised. `image` has no live path (codex `invokeLive("image")` → null).

**New-tab placement** — `herd.ts` has no "start an agent in a fresh empty tab" primitive, so `spawn({ newTab: true })` does the dance: capture the focused tab → `tab create --no-focus` → `agent start --tab <new>` → close the leftover shell root pane → restore focus to the caller's tab (`agent start --tab` steals focus despite `--no-focus`). An older `herd.ts` without `newTab` support silently ignores it and falls back to the `--split down` that relay also passes.

relay locates the herdr wrapper (`herd.ts`) via: `HERD_SCRIPT_PATH` env override → repo-sibling checkout (`packages/herdr/…`) → plugin caches of both harnesses (`~/.claude/plugins/cache`, `~/.codex/plugins/cache`), newest version first. Unresolvable → one stderr note + headless fallback; there is no hard herdr dependency (herd.ts is dynamically imported only on the live path).

## codex

Binary: `codex` (override via `CODEX_BIN`).

### Delegate (write-capable)

```bash
codex exec -s workspace-write -o <lastfile> -
```

> `codex exec` is non-interactive by default; `-s` sets the sandbox. The old
> `-a never` approval flag was removed in codex ≥ 0.139 — passing it errors with
> `unexpected argument '-a' found`. Verified against codex-cli 0.139.0.

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

**Used:** `--format json` → JSONL (one event per line: `step_start`, `text`, `step_finish`). The answer lives in the `text` events; relay's `parseJsonl` concatenates every `part.text` from `type === "text"` lines.
- Equivalent to: `jq -r 'select(.type=="text") | .part.text'`
- Why not `--format default`: that stream interleaves the answer with TUI/progress noise, so a naive trim returns garbage. JSON gives a clean, structured extraction.
- KNOWN BUG #26855: `run --format json` can exit before emitting the terminal `step_finish` event. `parseJsonl` never blocks on a terminal event — it just concatenates whatever `text` parts arrived, so this is a non-issue.

> **Invoke non-interactively with closed stdin.** `opencode run` inherits stdin; if stdin stays open (no TTY, never EOFs) it hangs waiting for input. relay calls it via `Bun.spawnSync` (stdin closed on spawn), so it returns normally. A bare shell `opencode run … > file` from a non-interactive context can hang — that is the harness, not opencode.

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
- **Image (codex-only):** `/relay:relay opencode image` and `/relay:relay claude image` fail fast before any CLI invocation.
- **Claude review:** Uses `/code-review`, not `/review` (the latter is PR-scoped and unavailable headlessly).
- **codex trusted directory:** `codex exec` refuses to run outside a git repo ("Not inside a trusted directory and `--skip-git-repo-check` was not specified"). relay does not pass that flag by design — run `/relay:relay codex …` from inside the project's git repo (the normal case). Verified against codex-cli 0.139.0.
