---
name: relay
description: >-
  Use when the user invokes `/relay:relay <codex|opencode|claude> <delegate|review|image>` to
  delegate a task to another harness's CLI. Slash-command only; do NOT auto-trigger on "ask codex".
argument-hint: "<codex|opencode|claude> <delegate|review|image> [task]"
version: 0.3.0
---

# Relay Skill

Wraps the local `codex`, `opencode`, and `claude` CLIs to delegate tasks across harnesses. All output is reported in zh-TW.

```
/relay:relay <codex|opencode|claude> delegate <task>
/relay:relay <codex|opencode|claude> review [task]
/relay:relay codex image [prompt] [--out <path>]
```

**Choosing between modes:**

- **`delegate`** — ask a backend to *do* something (implement, refactor, debug). Code changes expected.
- **`review`** — ask a backend for analysis. Output is critique + suggestions. No code changes.
- **`image`** — generate an image (codex only via gpt-image-2).

If the user says "review", "看看", "檢查", "找問題" → use `review`.
If the user says "幫我做", "實作", "重構", "想個辦法" → use `delegate`.
If the user says "生圖", "畫圖", "Generate image" → use `image` (codex only).

---

## Running the relay script

Every command below runs the bundled `scripts/relay.ts`. `${CLAUDE_PLUGIN_ROOT}` is Claude Code's official plugin-root variable, but it is **not reliably set inside an agent Bash call** (and is empty under Codex) — so don't depend on it, and don't use a `packages/relay/...` repo-relative path (that only exists inside the source repo). Resolve the script from the load-time **"Base directory for this skill"** banner Claude Code prints when the skill loads:

```bash
# Substitute the real banner path for <BANNER_PATH>
SKILL_DIR="<BANNER_PATH>"            # e.g. ~/.claude/plugins/cache/.../skills/relay
RELAY="$SKILL_DIR/scripts/relay.ts"
test -f "$RELAY" || { echo "relay.ts not found at $RELAY" >&2; exit 1; }
```

For brevity the examples below write `relay.ts <backend> <mode> …` as shorthand for `bun "$RELAY" <backend> <mode> …`. Run it from the user's current project directory — `relay.ts` invokes the backend CLIs against that working tree's git context.

---

## Live-pane mode (inside herdr)

Inside herdr (`HERDR_ENV=1`), `delegate` and `review` auto-route to a live TUI pane in a new tab.
Before running in that environment, read `references/live.md`.
It covers flags (`--headless` / `--keep-pane` / `--wait-timeout` / `--dangerous`), stdout/stderr output contract, pane lifecycle, and pending-report semantics.
`image` stays headless/native.

**Keep the default live — `--headless` needs a real reason.** Editing capability is identical (same CLI/model/write access), so "more precise/deterministic" is never it; override only for nested delegation, no live seam, or no pane surface. And `relay.ts` is one blocking call — don't poll it while it runs. See `references/live.md`.

---

## `/relay:relay <backend> delegate <task>`

For non-review tasks: implementing features, refactoring, suggesting an approach, debugging.

1. Identify relevant files from the task context (ask the user if unclear).
   - Prefer `git diff --name-only`, `git status --short`, and `rg --files` to discover candidate files.
   - If the target files or ownership boundaries are unclear, ask before delegating.

2. Run relay in a single step:

   ```bash
   relay.ts <backend> delegate --task "<task>" --files <file1,file2,...>
   ```

   where `<backend>` ∈ `{codex, opencode, claude}`.

   Examples:
   ```bash
   relay.ts codex delegate --task "add error handling to api.ts" --files api.ts
   relay.ts opencode delegate --task "refactor the auth flow" --files auth.ts,middleware.ts
   relay.ts claude delegate --task "implement the feature" --files main.ts
   ```

3. Inspect the backend's result, run available verification (lint/types/tests), then write the report. Apply additional local fixes only when they are required to complete the delegated task and remain inside the agreed scope.

---

## `/relay:relay <backend> review [task]`

Review is report-only. Never apply changes from review output unless the user asks separately.

- No task: run `relay.ts <backend> review`. Relay reviews only uncommitted changes.
- Task present: pass it unchanged as positional text. Do not translate it into `--scope`, `--files`, or `--focus`.

```bash
relay.ts codex review
relay.ts opencode review "Review auth.ts for race conditions"
relay.ts claude review "Review changes since main"
```

---

## `/relay:relay codex image [prompt] [--out <path>]`

Generate an image via codex (gpt-image-2). **Image mode is codex-only.**

If **prompt** is missing, ask the user:

```
AskUserQuestion("要生什麼圖？")
```

If **--out** is missing, ask the user (offer default: `./generated/image.png`).

In non-interactive contexts (invoked by a sub-agent or headless), do not block on AskUserQuestion; fail fast with a clear message naming the missing argument.

Once both are known, run:

```bash
relay.ts codex image "<prompt>" --out <path>
```

The script auto-adds a timestamp suffix to the filename (e.g., `./foo.png` → `./foo_20260430-1708.png`) and returns the final path.

Report the final saved path. If the user wants a different name, use a non-destructive rename command.

---

## Smart Apply Policy

Evaluate each backend suggestion and act:

**Auto-apply** (for delegate only):
- The backend provided a concrete diff or exact file/line edit
- The change is inside the selected scope
- The current agent can run verification afterward

In delegate mode, backends are write-capable and may have already edited the working tree; this apply policy governs suggestions in the report, while already-applied changes are verified and reported under 已套用變更.

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
   relay.ts <backend> <mode> --model "<provider/model>" ...
   ```

2. After a successful run, ask via AskUserQuestion:
   ```
   AskUserQuestion("儲存 <model> 作為 <backend> <mode> 的預設值嗎？")
   ```

3. If the user approves, save it through the relay config command:
   ```bash
   relay.ts config set-model <backend> <mode> "<provider/model>"
   ```

Config file location: `~/.config/q-lab/cc-plugins/relay/config.json`.

---

## Failure Handling

If the script exits non-zero, report the failure in zh-TW and stop — do not guess or fabricate suggestions. (Exception: a live-mode **pending report** exits 0 by design — see `references/live.md`.) Include:

- Command intent
- Exit code if available
- Relevant stderr summary
- Suggested next step

Capability gates (e.g., `/relay:relay opencode image` → unsupported) fail fast with a clear error message before any CLI runs.

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

- **`references/backends.md`** — read only when installing the OpenCode symlink integration or debugging a backend CLI failure; `relay.ts` already encodes all CLI invocations, so normal runs never need it.
- **`references/live.md`** — read only when `HERDR_ENV=1`; covers live-pane flags, output contract, pane lifecycle, and pending-report semantics.
