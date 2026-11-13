# Backend Reference — CLI flags, headless output, and install

> Verified locally (2026-06-15). Each backend section translates a `relay` mode into the canonical CLI invocation.

## Live-pane mode (herdr or herdr-app)

Inside herdr (`HERDR_ENV=1`) or a herdr-app terminal (`HC_TERMINAL_ID` set), delegate and review launch the backend's **interactive TUI**. The TUI opens in **its own new tab**, not a split of the caller's pane, so your working pane keeps its full size. This launch replaces the headless invocations below (`--headless` opts out of it).

The prompt rides a file (`live-prompt.md`). The pane only receives a one-line bootstrap. The answer is captured from `result.md` via an end-marker contract.

relay asks herdr to confirm the bootstrap landed, accepting the whole lifecycle enum — `unknown` included, which herdr leaves out of its own defaults — so the check returns as soon as the agent reacts. Failing to confirm never fails the run: relay logs `agent_prompt_stalled` or `timeout` and continues, because a cold start can exceed herdr's five-second window and the nudge loop heals a genuine miss. A rejected send still fails, since `agent_blocked` means nothing was delivered and the pane needs a human. This needs herdr 0.8.2 and herd.ts 0.4.0; an older pair silently skips the check and relies on the nudge loop alone. Under herdr-app, relay sends no bootstrap: the agent starts with it as its argv prompt, and the nudge loop heals a prompt the TUI swallowed.

This design makes the work visible and take-over-able. It also sidesteps headless flakiness: opencode's `run` in particular can hang around the #26855 family.

Per-backend live launch (argv extras only — never `exec`/`-p`/`-o`):

| Backend  | TUI binary            | `--model` mapping                          | `--dangerous` (YOLO) mapping                              |
| -------- | --------------------- | ------------------------------------------ | --------------------------------------------------------- |
| codex    | `codex` (`CODEX_BIN`) | `-m <model>`                               | `--dangerously-bypass-approvals-and-sandbox`              |
| claude   | `claude`              | `--model <model>`, plus `--effort <level>` | `--dangerously-skip-permissions`                          |
| opencode | `opencode`            | `-m <model>`                               | `--auto` (auto-approve permissions not explicitly denied) |

`--dangerous` is a **uniform YOLO switch** across all three live backends. It lets an **unattended** run proceed without stopping on approval prompts.

Without `--dangerous`, relay passes no approval-bypass flag. The TUI's own approval prompts then surface **in the pane**, where a human can answer them — the point of a _visible_ live pane. So `--dangerous` means fire-and-forget; no flag means supervised. `image` has no live path (codex `invokeLive("image")` returns null).

Caveats on the uniformity (see the opencode section below for details):

- opencode's `--auto` is **not a full bypass**: it auto-approves only what is _not explicitly denied_ — config `deny` rules (and built-in deny patterns) still block. codex's flag bypasses everything.
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

Generated PNGs land under `~/.codex/generated_images/`. After the run, locate the newest PNG written since the run started, falling back to a `*.png` path parsed out of the output, then copy it to `--out` (timestamp-suffixed). That order matters: the fallback matches any path-shaped token that exists on disk, so a model merely referring to an older image would otherwise copy the wrong file.

### Model

Unset by default, so codex uses its own configured model. When a caller passes `--model <model>`, delegate and live append `-m <model>`, and review appends `-c model="<model>"` because `codex review` has no `-m`. Image ignores it.

### Output capture

`-o <lastfile>` writes the final message to a file. Read the file, and fall back to stdout if it is absent.

---

## opencode (2.x)

Verified on opencode 2.2.6. The 2.x TUI takes no `-m`, so a run with a model (from `--model` or the relay config) has no live path and runs headless, with a one-line stderr note. Relay still parses the 1.x error event shape.

Binary: `opencode`. Headless subcommand: `opencode run`, prompt on stdin.

### Delegate

```bash
opencode run [-m <model>] --format json [--auto] < prompt
```

Write-capable by default. `--dangerous` maps to `--auto` on the headless path
too (same flag as the live TUI). Without it, headless `run` **auto-rejects**
approval prompts — there is no pane and no human to answer — so a non-dangerous
headless delegate silently loses approval-gated operations instead of failing
loudly. Use `--dangerous` for unattended headless runs that may need approvals.

### Review (emulated, read-only prompt)

```bash
opencode run [-m <model>] --format json < read-only-review-prompt
```

There is no native review. The prompt must instruct "analyze only, do not modify files."

Read-only is prompt-level only, and opencode's default permissions allow `edit`
— a headless review _could_ write files if the model ignores the instruction.
Hard read-only is possible via an agent profile that denies `edit`/`bash`
(`--agent <name>` with `permission` deny rules) but relay does not wire one in:
the profile would have to exist in every machine's opencode config.

### Relevant flags

- `-m, --model <provider/model#variant>` — model specification (optional; relay passes it only when `--model` or the relay config sets one, otherwise opencode uses its own configured or provider default). `#variant` is optional, e.g. `opencode-go/qwen3.8-max#high`; an unknown variant fails with `Variant unavailable for <model>: <variant>`. The TUI rejects `-m` ("Unrecognized flag"), and `OPENCODE_CONFIG_CONTENT` does not reach the background service that resolves the model, so there is no live equivalent
- `--agent <name>` — agent profile (optional)
- `--format <default|json>` — output format
- `--auto` — auto-approve permissions that are not explicitly denied (dangerous!). Maps to relay's `--dangerous` on `run` and the TUI alike. It still respects explicit deny rules, unlike codex's full bypass.
- The prompt rides stdin, never argv, so flag-like task text (e.g. "add --help flag") cannot be parsed as options. The live TUI gets its one-line bootstrap through `--prompt`.

### Output parsing

**Used:** `--format json` produces JSONL (one event per line: `step_start`, `text`, `step_finish`). The answer lives in the `text` events; relay's `parseJsonl` concatenates every `part.text` from lines where `type === "text"`.

- Equivalent to: `jq -r 'select(.type=="text") | .part.text'`
- Why not `--format default`: that stream interleaves the answer with TUI and progress noise, so a naive trim returns garbage. JSON gives a clean, structured extraction.
- KNOWN BUG #26855: `run --format json` can exit before it emits the terminal `step_finish` event. `parseJsonl` never blocks on a terminal event — it just concatenates whatever `text` parts arrived, so this is a non-issue.

> **Invoke non-interactively with closed stdin.** `opencode run` inherits stdin. If stdin stays open (no TTY, it never EOFs), the command hangs waiting for input. relay calls it via `Bun.spawnSync` (stdin closed on spawn), so it returns normally. A bare shell `opencode run … > file` can hang from a non-interactive context — that is a limit of the harness, not of opencode.

### Model

`relay.ts` pins no opencode model. Precedence is `--model` flag, then relay config, then opencode's own default (`-m` omitted). A `cli-default` value also omits `-m`. Format is `provider/model`, optionally `provider/model#variant`; without `#variant` the model runs at its default variant.

The suggested models ship in `references/config.suggested.json` and reach the user's config only through `relay.ts config apply`. They are `cli-default`, because a pinned model has no live path; pinned ids ride `suggestions` instead.

### Errors

A failed `opencode run` leaves stderr empty and reports the cause as a JSONL `error` event on stdout. `opencode run` exits 1. On 2.x the event is `{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: nope/bogus-model"}}`; relay prints `error.message`, falling back to `error.type`. It also reads the 1.x shape (`error.data.message`, else `error.name`). The failure line names the model or "CLI default". It never echoes the argv or the prompt.

---

## claude

Binary: `claude`. Headless: `claude -p "<prompt>"`.

### Delegate

```bash
claude -p "<prompt>" --output-format json
```

Parse the JSON envelope for the final assistant text.

On failure, stderr holds only a code such as `[claude-code:unrecognized_model]`. Relay prints the `result` text of the `is_error` result event instead.

### Review

```bash
claude -p "<review prompt>" --output-format json
```

Relay uses the same report-only prompt contract as the other backends. It does not invoke the PR-oriented `/code-review` command.

### Model and effort

Unset by default, so claude uses its configured default. When a caller passes `--model <model>`, relay appends `--model <model>` to both the headless and the live form. When a caller passes `--effort <low|medium|high|xhigh|max>`, relay appends `--effort <level>` the same way. Relay refuses `--effort` on codex and opencode rather than dropping it.

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
