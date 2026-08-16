# Backend Reference — CLI flags, headless output, and install

> Verified locally (2026-06-15). Each backend section translates a `relay` mode into the canonical CLI invocation.

## Live-pane mode (herdr)

Inside herdr (`HERDR_ENV=1`), delegate and review launch the backend's **interactive TUI**. The TUI opens in **its own new tab**, not a split of the caller's pane, so your working pane keeps its full size. This launch replaces the headless invocations below (`--headless` opts out of it).

The prompt rides a file (`live-prompt.md`). The pane only receives a one-line bootstrap. The answer is captured from `result.md` via an end-marker contract.

This design makes the work visible and take-over-able. It also sidesteps headless flakiness: opencode's `run` in particular can hang around the #26855 family.

Per-backend live launch (argv extras only — never `exec`/`-p`/`-o`):

| Backend | TUI binary | `--model` mapping | `--dangerous` (YOLO) mapping |
|---|---|---|---|
| codex | `codex` (`CODEX_BIN`) | `-m <model>` | `--dangerously-bypass-approvals-and-sandbox` |
| claude | `claude` | `--model <model>` | `--dangerously-skip-permissions` |
| opencode | `opencode` | `-m <model>` | `--auto` (auto-approve permissions not explicitly denied) |

`--dangerous` is a **uniform YOLO switch** across all three live backends. It lets an **unattended** run proceed without stopping on approval prompts.

Without `--dangerous`, relay passes no approval-bypass flag. The TUI's own approval prompts then surface **in the pane**, where a human can answer them — the point of a *visible* live pane. So `--dangerous` means fire-and-forget; no flag means supervised. `image` has no live path (codex `invokeLive("image")` returns null).

Caveats on the uniformity (see the opencode section below for details):
- opencode's `--auto` is **not a full bypass**: it auto-approves only what is *not explicitly denied* — config `deny` rules (and built-in deny patterns) still block. codex's flag bypasses everything.
- **Headless `run` has no human to prompt.** Without `--auto`, opencode auto-rejects approval requests instead of asking. So on the headless path `--dangerous` → `--auto` too, and a non-dangerous headless run silently loses approval-gated operations (it does not abort).

codex is the exception on the sandbox axis: its live launch passes `-s danger-full-access` even when not dangerous. The approval prompts stay, only the filesystem/network sandbox goes. See the codex section below for why.

**New-tab placement.** `herd.ts` has no primitive to start an agent in a fresh empty tab, so `spawn({ newTab: true })` does the dance instead. Note first: `agent start --tab` steals focus despite `--no-focus`. The dance accounts for this: capture the focused tab → `tab create --no-focus --label <name>` → `agent start --tab <new>` → close the leftover shell root pane → restore focus to the caller's tab.

The tab is **labelled with the agent name** (e.g. `relay-codex-delegate-8b6f`), so you can tell at a glance which tab is which live run. An older `herd.ts` without `newTab` support silently ignores it and falls back to the `--split down` that relay also passes.

relay locates the herdr wrapper (`herd.ts`) in this order: `HERD_SCRIPT_PATH` env override, then a repo-sibling checkout (`packages/herdr/…`), then plugin caches of both harnesses (`~/.claude/plugins/cache`, `~/.codex/plugins/cache`), newest version first. If relay cannot resolve `herd.ts`, it prints one stderr note and falls back to headless mode. There is no hard herdr dependency: `herd.ts` is dynamically imported only on the live path.

## codex

Binary: `codex` (override via `CODEX_BIN`).

### Delegate (write-capable)

```bash
codex exec -s danger-full-access -o <lastfile> -
```

> `codex exec` is non-interactive by default. `-s` sets the sandbox.
>
> The default is `danger-full-access`, not `workspace-write`. The write sandbox
> blocks routine delegate work — writes outside the workspace root, network
> fetches — far more often than it catches anything. Approvals are unaffected:
> `exec` is non-interactive either way, and the live TUI still prompts.
>
> `--approve-for-me` is **not** the escape hatch: it forces the workspace-write
> sandbox by definition, so it reintroduces exactly the failure being avoided.
>
> codex ≥ 0.139 removed the old `-a never` approval flag. Passing it now errors
> with `unexpected argument '-a' found`. Verified against codex-cli 0.139.0.
>
> `codex review` takes no `-s` flag (only `-c`), so the review path is unchanged.
> Verified against codex-cli 0.147.0.

Dangerous opt-in (only if user explicitly asks):
```bash
codex exec --dangerously-bypass-approvals-and-sandbox -o <lastfile> -
```

### Review

```bash
codex review --uncommitted -  # no task; prompt arrives on stdin
codex review -                # task provided; prompt arrives on stdin
```

### Image (codex-only)

```bash
codex exec -o <lastfile> "<image prompt>"
```

Generated PNGs land under `~/.codex/generated_images/`. After the run, locate the newest PNG, or parse a `*.png` path from output, then `cp` it to `--out` (timestamp-suffixed).

### Model

Unset. codex uses its own configured or last-used model. Do not pass `-m`.

### Output capture

`-o <lastfile>` writes the final message to a file. Read the file, and fall back to stdout if it is absent.

---

## opencode (1.18.18)

Binary: `opencode`. Headless subcommand: `opencode run [message..]`.

### Delegate

```bash
opencode run -m opencode-go/deepseek-v4-light --variant max --format json -- "<prompt>"
```

Write-capable by default. `--dangerous` maps to `--auto` on the headless path
too (same flag as the live TUI). Without it, headless `run` **auto-rejects**
approval prompts — there is no pane and no human to answer — so a non-dangerous
headless delegate silently loses approval-gated operations instead of failing
loudly. Use `--dangerous` for unattended headless runs that may need approvals.

### Review (emulated, read-only prompt)

```bash
opencode run -m opencode-go/deepseek-v4-pro --format json -- "<read-only review prompt>"
```

There is no native review. The prompt must instruct "analyze only, do not modify files."

Read-only is prompt-level only, and opencode's default permissions allow `edit`
— a headless review *could* write files if the model ignores the instruction.
Hard read-only is possible via an agent profile that denies `edit`/`bash`
(`--agent <name>` with `permission` deny rules) but relay does not wire one in:
the profile would have to exist in every machine's opencode config. Create a
local `readonly` agent (e.g. via `opencode agent create --mode primary --permissions read,glob,grep,webfetch`) and pass `--agent readonly` manually if you need it.

### Relevant flags

- `-m, --model <provider/model>` — model specification (optional; falls back to the configured default model — relay always resolves one per mode)
- `--agent <name>` — agent profile (optional)
- `--format <default|json>` — output format
- `--auto` — auto-approve permissions that are not explicitly denied (dangerous!). Maps to relay's `--dangerous`. Hidden `--yolo` / `--dangerously-skip-permissions` aliases exist on `run` and currently collapse to the same boolean (1.18.18) — they are not a stronger bypass. `--auto` still respects explicit deny rules, unlike codex's full bypass.
- `--` — relay appends this separator before the message so flag-like task text (e.g. "add --help flag") is passed through as the message, not parsed as options.

### Output parsing

**Used:** `--format json` produces JSONL (one event per line: `step_start`, `text`, `step_finish`). The answer lives in the `text` events; relay's `parseJsonl` concatenates every `part.text` from lines where `type === "text"`.
- Equivalent to: `jq -r 'select(.type=="text") | .part.text'`
- Why not `--format default`: that stream interleaves the answer with TUI and progress noise, so a naive trim returns garbage. JSON gives a clean, structured extraction.
- KNOWN BUG #26855: `run --format json` can exit before it emits the terminal `step_finish` event. `parseJsonl` never blocks on a terminal event — it just concatenates whatever `text` parts arrived, so this is a non-issue.

> **Invoke non-interactively with closed stdin.** `opencode run` inherits stdin. If stdin stays open (no TTY, it never EOFs), the command hangs waiting for input. relay calls it via `Bun.spawnSync` (stdin closed on spawn), so it returns normally. A bare shell `opencode run … > file` can hang from a non-interactive context — that is a limit of the harness, not of opencode.

### Model

Delegate resolves to opencode-go/deepseek-v4-light with `--variant max`. Review resolves to opencode-go/deepseek-v4-pro. The `--model` flag overrides the model. Format is `provider/model`.

---

## claude

Binary: `claude`. Headless: `claude -p "<prompt>"`.

### Delegate

```bash
claude -p "<prompt>" --output-format json
```

Parse the JSON envelope for the final assistant text.

### Review

```bash
claude -p "<review prompt>" --output-format json
```

Relay uses the same report-only prompt contract as the other backends. It does not invoke the PR-oriented `/code-review` command.

### Model

Unset. claude uses its session or configured default.

---

## Installation

### Claude Code / Codex

Installed via the marketplace registries (`marketplace.json`). No manual step required.

### OpenCode

Install through the repo's OpenCode installer, run from the checkout — it symlinks every skill (relay included) into `~/.config/opencode/skills/` in one step:

```bash
bun opencode/install.ts --apply
```

**Remove the legacy `~/.claude/skills/relay` symlink.** These docs used to tell users to create it by hand. OpenCode scans both `~/.claude/skills/` and `~/.config/opencode/skills/`, so keeping it alongside a fresh installer run surfaces **two skills named `relay`**:

```bash
# legacy — remove if present
[ -L ~/.claude/skills/relay ] && rm ~/.claude/skills/relay
```

The skill's frontmatter (`name`, `description`) is portable across all three harnesses. OpenCode's skill frontmatter recognizes only `name`, `description`, `license`, `compatibility`, and `metadata`, and ignores every other key — including `user-invocable` and `argument-hint` — which is why no existing skill needs a frontmatter change for OpenCode.

---

## Known Caveats

- **#26855 (opencode):** JSON format output can exit before the terminal `step_finish` event. If using `--format json`, concatenate all `text` parts captured. Do not block while waiting for a closing event.
- **Image (codex-only):** `/relay:relay opencode image` and `/relay:relay claude image` fail fast before any CLI invocation.
- **codex trusted directory:** `codex exec` refuses to run outside a git repo ("Not inside a trusted directory and `--skip-git-repo-check` was not specified"). relay does not pass that flag by design. Run `/relay:relay codex …` from inside the project's git repo — the normal case. Verified against codex-cli 0.139.0.
