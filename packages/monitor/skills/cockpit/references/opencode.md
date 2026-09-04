# Cockpit · OpenCode provider

Provider value: **`opencode`**.

Read this once at Step 0. Then follow the selected mode reference, `pilot.md`
or `scribe.md`, using the OpenCode-specific bits below. Everything else is
shared by that mode.

## Plugin root

OpenCode prints no *"Base directory for this skill"* banner, and
`CLAUDE_PLUGIN_ROOT` is empty. State the path literally:

```text
<plugin-root>/skills/cockpit  →  ~/.config/opencode/skills/cockpit
```

So every command in a mode reference becomes
`bun ~/.config/opencode/skills/cockpit/scripts/…`. In `scribe.md`'s Step 1,
set `CLI="$HOME/.config/opencode/skills/cockpit/scripts/cockpit.ts"`. There is
no banner to substitute here, so the path is fixed — run it directly and let
bun's `error: Module not found "<path>"` report a broken install.

The skill directory is a symlink into a checkout of this repository, so an
edit in the checkout is live with no reinstall.

## Session id (Step 1)

```bash
bun ~/.config/opencode/skills/cockpit/scripts/find-session.ts --provider opencode
```

It returns `OPENCODE_SESSION_ID` or `OPENCODE_SESSION` when either is set.
Otherwise it reads the OpenCode database at
`${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db` and takes the
latest non-archived `session` row whose `directory` matches this project's
cwd. If it exits non-zero, generate one with `crypto.randomUUID()` and note
which id you used.

## Provider flag

Pass `--provider opencode` on **every** `cockpit` call — `scribe`, `prep`,
`--recent`, and every write. In `scribe.md` that means
`PROVIDER_FLAG="--provider opencode"`. The default is `claude`, so omitting
the flag resolves against the wrong vendor's sessions.

## Wait policy (needs_your_call)

OpenCode's bash tool has no background-run parameter. Run `cockpit wait <id>`
in the **foreground as a blocking tool call**, the way Codex does. Do not send
the final response while it is waiting. The wait's stdout is the wake-up
signal: when the user clicks a dashboard option, the command prints the
answer, and this same turn continues from it.

On exit `4` nobody is watching the cockpit — ask the same question in chat,
then record the answer with `cockpit send`. See "Nobody is watching" in
`pilot.md`.

## Sends go over the TUI HTTP bridge

OpenCode never registers the cockpit channel MCP server, so a send takes a
different path: `scripts/opencode-send.ts`, served by the cockpit daemon at
`/api/send-opencode-message`. It discovers the TUI server from
`OPENCODE_TUI_SERVER_URL` or `OPENCODE_SERVER_URL`, falls back to a `ps` scan
for `opencode --port <n>`, health-checks `/global/health`, resolves the
session through `/session/<id>`, and delivers via `/tui/append-prompt` then
`/tui/submit-prompt`.

Two preconditions, both observed on opencode 1.18.18:

- **Start the TUI with a port.** Run `opencode --port <n>`, or set
  `OPENCODE_TUI_SERVER_URL` before the cockpit daemon starts. An
  `opencode serve` process does **not** count — discovery scans `ps` for
  `opencode` and explicitly excludes `serve`, `web`, and `attach`.
- **A successful send is not a delivery receipt.** `/tui/append-prompt`
  returns `200 true` even with no TUI attached, so treat delivery as
  best-effort and confirm through the session itself.

Reads are unaffected. Transcript reads, the decision trail, and
`needs_your_call` behave as they do for the other providers.
