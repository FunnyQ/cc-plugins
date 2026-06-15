# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

`relay` is the third plugin in the `cc-plugins` (q-lab-marketplace) monorepo, alongside `monitor` and `dispatch`. It is a single portable skill that lets an agent in any harness (Claude Code, Codex, OpenCode) delegate a task **out** to another harness's CLI, capture the output, smart-apply when safe, and report back. It generalizes the codex-only `odin-codex` skill into a multi-backend adapter and is intended to become its superset.

Package root: `packages/relay/`. Skill: `packages/relay/skills/relay/`.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Uses `Bun.spawnSync`, `Bun.file`.
- **Deps**: none. No external npm packages — the repo vendors what it needs and otherwise stays dependency-free.
- **External CLIs invoked**: `codex`, `opencode` (1.17.6), `claude`. See `cli-reference.md`.

## Code style

- Use `type` over `interface`.
- Export pure functions (arg building, output parsing, gate, resolution) so they unit-test without spawning a CLI. Keep `Bun.spawnSync` calls behind a thin `run()` wrapper, not inlined into pure logic.
- Match the existing `odin-codex` script style: a `run(args, {stdin})` helper returning `{ok, stdout, stderr, code}`; CLI entry guarded by `if (import.meta.main)`. (One exception: the ported `context-collector.ts` owns its own internal `shell()` spawn helper and does not import `run()` — it stays dependency-free for a clean port.)
- Per-1M-token pricing and other constants live as clearly-labeled module constants, not magic numbers.
- Authoritative style source (verification only): existing scripts under `packages/monitor/skills/*/scripts/` and the `odin-codex` port source.

## File / directory layout

```
packages/relay/
├── .claude-plugin/plugin.json        # Claude manifest, version 0.1.0
├── .codex-plugin/plugin.json         # Codex manifest, skills: "./skills/", version 0.1.0
├── commands/                        # slash commands (auto-discovered at plugin root)
│   ├── relay.md                     # the canonical /relay entry
│   ├── codex.md                     # alias: /codex → /relay codex
│   ├── opencode.md                  # alias: /opencode → /relay opencode
│   └── claude.md                    # alias: /claude → /relay claude
└── skills/relay/
    ├── SKILL.md                      # orchestration, smart-apply, report formats, install docs
    ├── references/backends.md        # per-CLI flags + headless output + opencode symlink install
    └── scripts/
        ├── relay.ts                  # entry: relay <backend> <mode> [flags]; gate + dispatch + capture; builds prompt internally
        ├── relay-prompt.ts           # backend-agnostic prompt: formatPrompt (pure) + buildPromptFile (impure)
        ├── context-collector.ts      # git/file/project context (ported from odin-codex)
        ├── shared.ts                 # run(), createTmpRunDir, timestamp, model+config resolution
        ├── types.ts                  # Mode, Strategy, Backend, InvokeOpts, RunResult
        ├── backends/
        │   ├── gate.ts               # capabilityGate + getBackend (pure; no concrete-backend imports)
        │   ├── index.ts              # concrete BACKENDS registry (imports the three backends; built at the entry point)
        │   ├── codex.ts              # native review + exec + image PNG handling (postRun)
        │   ├── opencode.ts           # opencode run + JSONL parse + model defaults
        │   └── claude.ts             # claude -p + /code-review native review
        └── *.test.ts                 # unit tests; integration.test.ts gated by RELAY_INTEGRATION=1
```

New test files are `<name>.test.ts` colocated in `scripts/`. Run with `bun test packages/relay/skills/relay/scripts/`.

## Architecture: two layers + strategy axis

- **Mode layer (backend-agnostic)**: `relay-prompt.ts` + `context-collector.ts`. Builds a canonical intent/context prompt. Knows nothing about which CLI will run.
- **Backend layer (per-harness)**: each `backends/<name>.ts` exports a `Backend` with `supports`, `strategy()`, `invoke()`, `parseOutput()`. Registered in `backends/index.ts`.
- **strategy ∈ {native, prompt}**: `native` = the backend runs its own command and gathers its own git context (the built prompt is bypassed); `prompt` = the backend consumes a prompt file built by `relay-prompt.ts`.
- **`relay.ts`** orchestrates: parse `<backend> <mode>` → `capabilityGate` → ask `strategy` → build prompt if needed → `invoke` → capture output. `relay.ts` must never name a CLI; backends must never build another backend's prompt.

## Capability matrix (the gate)

| Mode | codex | opencode | claude |
|---|---|---|---|
| delegate | ✓ prompt | ✓ prompt | ✓ prompt |
| review | ✓ native; custom-file scope → prompt | ⚠ emulated → prompt | ✓ native |
| image | ✓ | ✗ (fail fast) | ✗ (fail fast) |

`capabilityGate(backend, mode)` exits non-zero with a clear message (e.g. `image is only supported on codex`) before any CLI runs.

## Output contract

Every successful run writes the backend's full final output to `/tmp/relay/<timestamp>-<pid>-<rand>/last.md` **and** prints the same text to stdout. The temp file is the durable artifact (re-readable for long reviews); the host agent gets the full text inline. This mirrors odin-codex's `-o lastfile` then print-to-stdout pattern. `TMP_ROOT = "/tmp/relay"`.

## Model resolution

Precedence: **`--model` flag > config file > built-in constants**.

- codex: **unset** (codex uses its own last-used/configured model).
- claude: **unset**.
- opencode delegate: `opencode-go/kimi-k2.7-code`.
- opencode review: `opencode-go/qwen3.7-max`.

Config file: `~/.config/q-lab/cc-plugins/relay/config.json` (XDG `$HOME/.config`), shape `{ "models": { "<backend>": { "<mode>": "provider/model" } } }`. The script only **reads** it. When the user passes an explicit `--model`, the host agent (SKILL.md) is the one that asks whether to save it — the scripts never prompt.

## Smart-apply policy (backend-independent, enforced by SKILL.md)

- **delegate** → auto-apply concrete in-scope changes, then run available verification (lint/types/tests). On verification failure, revert only relay's own edit and downgrade to report-only.
- **review** → report-only. Apply only on explicit user approval.
- Never auto-apply: architectural changes, behavior/logic changes, multi-file interconnected edits, deletions, out-of-scope changes, anything uncertain.

## Report formats

After a run, the host agent writes one of these (reported in zh-TW, matching odin-codex). `<backend>` = the harness that ran. If the relay script exits non-zero or returns empty, report the failure (command intent, exit code, stderr summary, suggested next step) — never fabricate findings.

### Review report

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

### Delegate report

```markdown
## Relay 回覆 (<backend>)

### 任務
[what was delegated]

### 建議摘要
[concise summary]

### 已套用變更
- [Applied] `file.ts:42` — description

### 待確認建議
- [Suggestion] description — why it needs human review

### 驗證
- Lint/Tests: pass / fail / skipped
```

## Commit & branching style

- Branch off: `develop` (the repo's working branch; `main` is release).
- Commit format: emoji + conventional (e.g. `✨ feat:`, `🔧 release:`), matching existing history.
- Use `/odin-git:simple-commit` (single change) or `/odin-git:atomic-commit` (multiple logical changes) — and confirm with the user first.

## Verification baseline

- Unit tests: `bun test packages/relay/skills/relay/scripts/`
- Integration smoke (local only): `RELAY_INTEGRATION=1 bun test packages/relay/skills/relay/scripts/integration.test.ts`
- Run a script directly: `bun packages/relay/skills/relay/scripts/relay.ts <backend> <mode> …`

## Decisions frozen during interview

- **image kept, codex-only** — it borrows codex's gpt-image-2; not a delegation concept, but Q uses it and it ships in the superset.
- **relay supersedes odin-codex** — must cover delegate+review+image so odin-codex can be retired after relay stabilizes. No migration work in this build.
- **claude review = `/code-review`** (not `/review`, which is PR-scoped).
- **opencode review = read-only prompt** (v1); hard read-only agent deferred.
- **output = full stdout + always temp file.**
- **models**: codex/claude unset; opencode kimi (delegate) / qwen (review); `--model` overrides; save-to-config is agent-driven.
- **install = docs only** (opencode symlink); no install script.
- **tests = pure unit + env-gated local integration**, never CI.
- **version 0.1.0**, pre-stable.
