---
name: chrome
description: >-
  Open web pages in an isolated headless Chrome, read and drive them, and take
  screenshots, over the Chrome DevTools Protocol.
when_to_use: >-
  Use when a page must be tested, previewed, or screenshotted in Chrome, and
  Herdr is not running or the work must not touch a Herdr pane. Inside Herdr,
  prefer herdr-browser, which adds console and network debugging. Use the
  firefox skill for Firefox or Zen and the safari skill for Safari.
version: 1
---

# Chrome

Every operation is one command. Resolve the script from the load-time **"Base
directory for this skill"** banner; a plugin-root variable is not reliably set
inside an agent's Bash call:

```bash
C="$SKILL_DIR/scripts/chrome.ts"
bun "$C" open http://localhost:3000
```

Written `C <command>` below — expand it to `bun "$C" <command>` every time.

## Open a page

```bash
C open <url>                   # reuses the open instance, or launches one
C open <url> --new             # always launches another instance
C open <url> --headed          # a visible window instead of headless
C open <url> --size 1280x800   # window size; default 1440x900
```

Each instance is its own Chrome process with a throwaway profile. It never
touches the Chrome you have open, and it shares no login, cookie, or extension
with it.

Headless is the default. Pass `--headed` only when someone needs to watch, because
a headed window takes focus on the user's screen.

`open` prints the instance id first. With several instances open, every command
refuses to guess — pass `--id`, and the error lists the candidates.

The browser comes from the first installed of Google Chrome, Chrome Canary, and
Chromium.

## Read and drive the page

```bash
C status                          # id, mode, url, title — per instance
C text                            # page text
C goto <url> | back | forward | reload
C eval <expression>               # strings print raw, everything else as JSON; promises are awaited
C click <selector>                # a real mouse click at the element's centre
C type <selector> <text>
C press [selector] <key>          # Enter, Tab, Escape, ArrowDown, a — no selector: the focused element
C wait <expression> [timeoutMs]   # default 10000
C screenshot --output <path> [--full]
C close                           # stops the instance and deletes its profile
```

Selectors are CSS. A selector that matches nothing fails with `no such element:
<selector>` and exit 1.

Navigation commands return once the page has loaded. A `click` or `press` that
starts loading a page waits until loading stops; a navigation a page timer starts
later than 50ms is not waited for, so follow such a click with `wait`. A URL that
does not resolve fails with Chrome's own error, such as
`net::ERR_NAME_NOT_RESOLVED`.

## Gotchas

**The viewport is shorter than the window.** `--size 1440x900` gives a 1440x813
viewport (measured on Chrome 154). Pass a taller `--size` when the screenshot height matters.

**Close what you open.** An instance outlives the command that launched it. A
record whose process has died is pruned on the next command, but a live one runs
until `close`.

There is no console stream and no network log. Use herdr-browser when a bug needs
them.

Instance records live under `/tmp/q-lab/browsers/chrome/instances/`.
