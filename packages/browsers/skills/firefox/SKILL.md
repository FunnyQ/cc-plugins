---
name: firefox
description: >-
  Open web pages in Firefox or Zen, read and drive them, and take screenshots,
  over Gecko's own Marionette protocol.
when_to_use: >-
  Use when a page must be tested, previewed, or screenshotted in a Gecko
  browser — Firefox Developer Edition, Firefox, or Zen — or when a bug shows
  only in Firefox or Zen. Use the chrome skill for Chrome and the safari
  skill for Safari.
version: 1
---

# Firefox

Every operation is one command. Resolve the script from the load-time **"Base
directory for this skill"** banner; a plugin-root variable is not reliably set
inside an agent's Bash call:

```bash
F="$SKILL_DIR/scripts/firefox.ts"
bun "$F" open http://localhost:3000
```

Written `F <command>` below — expand it to `bun "$F" <command>` every time.

## Open a page

```bash
F open <url>                   # reuses the open instance, or launches one
F open <url> --new             # always launches another instance
F open <url> --zen             # Zen instead of Firefox
F open <url> --headed          # a visible window instead of headless
F open <url> --size 1280x800   # window size; default 1440x900
```

Each instance is its own process with a throwaway profile and its own Marionette
port. It never touches the Firefox or Zen you have open, and it shares no login,
cookie, or extension with it.

Headless is the default. Pass `--headed` only when someone needs to watch, because
a headed window takes focus on the user's screen.

`open` prints the instance id first. With several instances open, every command
refuses to guess — pass `--id`, and the error lists the candidates.

The browser comes from the first installed of Firefox Developer Edition, Firefox,
and Firefox Nightly. Pass `--zen` to use Zen.

## Read and drive the page

```bash
F status                          # id, browser, mode, url, title — per instance
F text                            # page text
F goto <url> | back | forward | reload
F eval <expression>               # strings print raw, everything else as JSON
F click <selector>
F type <selector> <text>
F press [selector] <key>          # Enter, Tab, Escape, ArrowDown, a — no selector: the focused element
F wait <expression> [timeoutMs]   # default 10000
F screenshot --output <path> [--full]
F close                           # stops the instance and deletes its profile
```

Selectors are CSS. A selector that matches nothing fails with `no such element`
and exit 1.

`eval` runs in the page itself, so page globals are reachable directly.

## Gotchas

**Zen's sidebar eats the viewport.** `--size 1280x800` gives Zen a 1036px-wide
viewport (measured on Zen 1.22.3b), against Firefox's full width. Use Firefox for any screenshot
whose width matters. Use Zen only to reproduce what a Zen user sees.

**One command at a time per instance.** Marionette serves one connection at a time.
A second command against a busy instance waits 10 seconds, then fails with
`Marionette sent no greeting — another command may be holding this instance`. Give
each parallel agent its own `open --new`.

**Close what you open.** An instance outlives the command that launched it. A
record whose process has died is pruned on the next command, but a live one runs
until `close`.

There is no console stream and no network log. Marionette has neither; use
herdr-browser on Chromium when a bug needs them.

Instance records live under `/tmp/q-lab/browsers/firefox/instances/`.
