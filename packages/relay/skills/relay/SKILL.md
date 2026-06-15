---
name: relay
description: >-
  Use when the user invokes `/relay <codex|opencode|claude> <delegate|review|image>` to
  delegate a task to another harness's CLI. Slash-command only; do NOT auto-trigger on "ask codex".
version: 0.1.0
---

# Relay Skill

Wraps the local `codex`, `opencode`, and `claude` CLIs to delegate tasks across harnesses. All output is reported in zh-TW.

```
/relay <codex|opencode|claude> delegate <task>
/relay <codex|opencode|claude> review [scope]
/relay codex image [prompt] [--out <path>]
```

**Choosing between modes:**

- **`delegate`** — ask a backend to *do* something (implement, refactor, debug). Code changes expected.
- **`review`** — ask a backend for analysis. Output is critique + suggestions. No code changes.
- **`image`** — generate an image (codex only via gpt-image-2).

If the user says "review", "看看", "檢查", "找問題" → use `review`.
If the user says "幫我做", "實作", "重構", "想個辦法" → use `delegate`.
If the user says "生圖", "畫圖", "Generate image" → use `image` (codex only).

---

## `/relay <backend> delegate <task>`

For non-review tasks: implementing features, refactoring, suggesting an approach, debugging.

1. Identify relevant files from the task context (ask the user if unclear).
   - Prefer `git diff --name-only`, `git status --short`, and `rg --files` to discover candidate files.
   - If the target files or ownership boundaries are unclear, ask before delegating.

2. Run relay in a single step:

   ```bash
   bun packages/relay/skills/relay/scripts/relay.ts <backend> delegate --task "<task>" --files <file1,file2,...>
   ```

   where `<backend>` ∈ `{codex, opencode, claude}`.

   Examples:
   ```bash
   bun packages/relay/skills/relay/scripts/relay.ts codex delegate --task "add error handling to api.ts" --files api.ts
   bun packages/relay/skills/relay/scripts/relay.ts opencode delegate --task "refactor the auth flow" --files auth.ts,middleware.ts
   bun packages/relay/skills/relay/scripts/relay.ts claude delegate --task "implement the feature" --files main.ts
   ```

3. Inspect the backend's result, run available verification (lint/types/tests), then write the report. Apply additional local fixes only when they are required to complete the delegated task and remain inside the agreed scope.

---

## `/relay <backend> review [scope]`

For code analysis: ask a backend for an opinion on existing code.

**No scope** — review uncommitted working tree changes:

```bash
bun packages/relay/skills/relay/scripts/relay.ts codex review --scope uncommitted
bun packages/relay/skills/relay/scripts/relay.ts claude review --focus high
```

**Scope names a git reference** — call the backend's native review:

| Scope intent | Command |
|---|---|
| "review uncommitted changes" | `relay.ts codex review --scope uncommitted` |
| "review against main" | `relay.ts codex review --scope main` |
| "review commit abc123" | `relay.ts codex review --scope abc123` |

**Scope names specific files / a directory / cross-cutting concern** — collect context and run review with a custom prompt:

1. Identify the files from the scope (ask if unclear).
   - Prefer `git diff --name-only`, `git status --short`, and `rg --files` to discover candidate files.

2. Run relay with a prompt:

   ```bash
   bun packages/relay/skills/relay/scripts/relay.ts <backend> review --files <file1,file2,...> --focus "<user's specific concern>"
   ```

   Supported backends: codex, opencode, claude.

3. After receiving output, write the report. **Do not apply changes** from review output unless the user explicitly asks to apply them.

---

## `/relay codex image [prompt] [--out <path>]`

Generate an image via codex (gpt-image-2). **Image mode is codex-only.**

If **prompt** is missing, ask the user:

```
AskUserQuestion("要生什麼圖？")
```

If **--out** is missing, ask the user (offer default: `./generated/image.png`).

Once both are known, run:

```bash
bun packages/relay/skills/relay/scripts/relay.ts codex image "<prompt>" --out <path>
```

The script auto-adds a timestamp suffix to the filename (e.g., `./foo.png` → `./foo_20260430-1708.png`) and returns the final path.

Report the final saved path. If the user wants a different name, use a non-destructive rename command.

---

## Smart Apply Policy

Evaluate each backend suggestion and act:

**Auto-apply** (for delegate only):
- Codex provided a concrete diff or exact file/line edit
- The change is inside the selected scope
- The current agent can run verification afterward

After applying, run any available verification (lint / type check / tests) via Bash. If verification fails, undo only your own attempted edit and move the suggestion to "report only."

**Report only** (for review, or when uncertain):
- Architectural changes
- Logic changes affecting behavior
- Multi-file / interconnected changes
- Deletions of existing code
- Changes outside the selected scope
- Anything you're not 100% confident about

---

## Model Save-to-Config Flow

When the user passes an explicit `--model` flag:

1. Run relay with the specified model:
   ```bash
   bun packages/relay/skills/relay/scripts/relay.ts <backend> <mode> --model "<provider/model>" ...
   ```

2. After a successful run, ask via AskUserQuestion:
   ```
   AskUserQuestion("儲存 <model> 作為 <backend> <mode> 的預設值嗎？")
   ```

3. If the user approves, merge-write the config file:
   - Location: `~/.config/q-lab/cc-plugins/relay/config.json`
   - Shape: `{ "models": { "<backend>": { "<mode>": "<provider/model>" } } }`
   - Preserve existing keys; only update the target `<backend>.<mode>` entry

Example config after saving opencode delegate model:
```json
{
  "models": {
    "opencode": {
      "delegate": "opencode-go/kimi-k2.7-code"
    }
  }
}
```

---

## Failure Handling

If the script exits non-zero or returns empty output, report the failure in zh-TW and stop — do not guess or fabricate suggestions. Include:

- Command intent
- Exit code if available
- Relevant stderr summary
- Suggested next step

Capability gates (e.g., `/relay opencode image` → unsupported) fail fast with a clear error message before any CLI runs.

---

## Review Report Format

```markdown
## Relay Review (<backend>)

### 重大問題
- `file.ts:42` — issue, impact, suggested fix

### 其他建議
- `file.ts:88` — suggestion

### 可套用修正
- [Safe] description — pending explicit approval

### 驗證
- Lint/Tests: pass / fail / skipped
```

## Delegate Report Format

```markdown
## Relay 回覆 (<backend>)

### 任務
[what was delegated]

### 建議摘要
[concise summary in zh-TW]

### 已套用變更
- [Applied] `file.ts:42` — description

### 待確認建議
- [Suggestion] description — why it needs human review

### 驗證
- Lint/Tests: pass / fail / skipped
```

---

## Additional Resources

- **`references/backends.md`** — per-CLI flags, headless output handling, #26855 caveat, and install instructions
