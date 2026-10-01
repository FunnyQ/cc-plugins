---
name: safari
description: >-
  Open web pages in Safari, read and drive them, and take screenshots, over the
  safaridriver that ships with macOS.
when_to_use: >-
  Use when a page must be checked or screenshotted in Safari, or when a bug shows
  only in Safari or WebKit. It opens a visible window that takes focus, so prefer
  the firefox or chrome skill for anything that does not need Safari itself.
version: 1
---

# Safari

Every operation is one command. Resolve the script from the load-time **"Base
directory for this skill"** banner; a plugin-root variable is not reliably set
inside an agent's Bash call:

```bash
S="$SKILL_DIR/scripts/safari.ts"
bun "$S" open http://localhost:3000
```

Written `S <command>` below — expand it to `bun "$S" <command>` every time.

## Before the first run

Ask the user to run `safaridriver --enable` once. It asks for their password, so
suggest they type `! safaridriver --enable` in the prompt. When `open` fails to
create a session for any reason other than another client holding Safari, check
this first.

## Open a page

```bash
S open <url>                   # reuses the session, or starts one
S open <url> --size 1280x800   # window size
```

**Tell the user before the first `open`.** Safari has no headless mode. The
session opens a visible automation window — orange address bar — that takes focus
and lays a glass pane over itself, which swallows the user's mouse and keyboard
until the session ends.

**There is one session per machine.** Safari pairs with a single WebDriver session
at a time, so there is no `--new` and no `--id`: every caller shares the one
session until someone runs `close`. Never use this skill from parallel agents.

The window is isolated like a private window: it starts empty and shares no
history, login, or cookie with the user's Safari.

## Read and drive the page

```bash
S status                          # session id, url, title
S text                            # page text
S goto <url> | back | forward | reload
S eval <expression>               # strings print raw, everything else as JSON
S click <selector>
S type <selector> <text>
S press [selector] <key>          # Enter, Tab, Escape, ArrowDown, a — no selector: the focused element
S wait <expression> [timeoutMs]   # default 10000
S screenshot --output <path>      # viewport only; WebDriver has no full-page capture
S close                           # ends the session and stops safaridriver
```

Selectors are CSS. A selector that matches nothing fails with `no such element`
and exit 1.

## Gotchas

**Close as soon as you are done.** An open session keeps the glass pane over the
window, and the user cannot use that window until `close` runs.

**A user who breaks the glass pane ends the session.** The next command finds the
session dead, clears the record, and `open` starts a fresh one.

**Another WebDriver client holding Safari blocks `open`.** The error says so; ask
the user to end that session rather than killing processes you did not start.

The session record lives at `/tmp/q-lab/browsers/safari/session.json`.
