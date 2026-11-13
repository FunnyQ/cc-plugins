# Cockpit · OpenCode provider

Provider value: **`opencode`**.

Read this once at Step 0. Then follow the selected mode reference, `pilot.md`
or `scribe.md`, using the OpenCode-specific bits below. Everything else is
shared by that mode.

## Plugin root

OpenCode prints no _"Base directory for this skill"_ banner, and
`CLAUDE_PLUGIN_ROOT` is empty. State the path literally:

```text
<plugin-root>/skills/cockpit  →  ~/.config/opencode/skills/cockpit
```

So every command in a mode reference becomes
`~/.config/opencode/skills/cockpit/bin/cockpit …`. In `scribe.md`'s Step 1,
set `CLI="$HOME/.config/opencode/skills/cockpit/bin/cockpit"`. There is
no banner to substitute here, so the path is fixed — run it directly and let
the shell's missing-executable error report a broken install.

The skill directory is a symlink into a checkout of this repository, so an
edit in the checkout is live with no reinstall.

## Session id (Step 1)

```bash
~/.config/opencode/skills/cockpit/bin/cockpit find-session --provider opencode
```

It returns `OPENCODE_SESSION_ID` or `OPENCODE_SESSION` when either is set.
Otherwise it reads the OpenCode database at
`${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db` and takes the
latest non-archived `session_v2` row whose `directory` matches this project's
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

## Sends go over the background service prompt route

The monitor mod that delivers Claude sends does not run on OpenCode, so a send takes a
different path: the Rust OpenCode send bridge, served by the cockpit daemon at
`/api/send-opencode-message`. It discovers the background service from
`OPENCODE_TUI_SERVER_URL`, then `OPENCODE_SERVER_URL`, then
`~/.local/state/opencode/service.json`. An env URL authenticates with
`OPENCODE_SERVER_PASSWORD`, or with the file's password when both name the same
URL. It health-checks
`/api/info`, resolves the session through `/api/session/<id>`, and delivers with
`POST /api/session/<id>/prompt` and `delivery: "queue"`. The 1.x TUI HTTP bridge
(`/tui/append-prompt`, a `--port` TUI server, `/global/health`) is removed in
OpenCode 2.x.

- **Start OpenCode first.** The TUI and `opencode serve` both register the
  background service; the send needs it running.
- **A send is an admission, not a delivery receipt.** The prompt route admits
  the message durably; confirm the answer through the session itself.

Reads are unaffected. Transcript reads, the decision trail, and
`needs_your_call` behave as they do for the other providers.
