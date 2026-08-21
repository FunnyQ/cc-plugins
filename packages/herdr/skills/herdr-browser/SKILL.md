---
name: herdr-browser
description: >-
  Open web pages in a terminal browser pane, read and drive them, and attach
  Playwright or other CDP clients.
when_to_use: >-
  Use whenever a page needs opening, reading, or driving — screenshots, clicks,
  form input, console or network debugging, viewport emulation — and Herdr is
  running. Drives terminal-browser. Also use to hand a CDP endpoint to
  Playwright, Chrome DevTools MCP, or Browser Use.
version: 2
---

# Herdr Browser

Every operation is one command. `${CLAUDE_PLUGIN_ROOT}` is not reliable inside an
agent Bash call. Resolve the script from the load-time **"Base directory for this
skill"** banner instead:

```bash
B="$SKILL_DIR/scripts/browser.ts"
bun "$B" open https://news.ycombinator.com
```

Written `B <command>` below — expand it to `bun "$B" <command>` every time.

## Requirements

The browser is [terminal-browser](https://terminal-browser.sh); every operation
runs over CDP rather than through its CLI. When the binary is missing the error
names the install command. Never install it for the user without asking.

## Open a page

```bash
B open https://news.ycombinator.com
B open <url> --new --split right|left|down|up --ratio 0.4
```

Loads the URL in the browser that is already open. Opens a new one only when
none is live, or when you pass `--new`. A new browser splits the focused pane —
`--split` picks the side, `--ratio` its share (0.2 to 0.95).

With several browsers live, every command refuses to guess — pass `--view ID`,
and the error lists the candidates.

## Read and drive the page

```bash
B status                      # url, title, then the tab list
B text                        # page text
B goto <url> | back | forward | reload
B eval <expression>
B selector-click <selector>
B type <selector> <text>
B press [selector] <key>      # Enter, Tab, ArrowDown, Control+a, a
B wait <expression> [timeoutMs]
B click <x> <y> | wheel <x> <y> <deltaY>
B screenshot --output <path>
B console                     # this page load only; --all keeps older entries
```

Every one answers in one line. A selector that matches nothing, a key that does
not exist, and a URL that fails to resolve all fail loudly — none of them
reports success.

`console` reads the buffer the page itself kept, so it covers lines printed
before this command ran, **including uncaught exceptions**. Use `watch` when you
need the network alongside them, or the order between them.

## Debug a page load

```bash
B watch [url]                    # navigate there, or reload, and record
B watch <url> --body <fragment>  # also print that response's body
```

One pass over the load: every request, every console line, and every uncaught
exception, in the order they happened.

```
200 Document http://localhost:8899/
log boot ok
error a deliberate error
404 Fetch http://localhost:8899/missing.json
FAIL Fetch http://localhost:8899/x.json net::ERR_CONNECTION_REFUSED
EXCEPTION TypeError: Cannot read properties of null (reading 'boom')
```

CDP only reports while attached, so `watch` always drives the load itself — it
cannot report on something that already happened. It stops 1.5s after the last
event, or at 15s.

## Click without guessing a selector

```bash
B snapshot        # 8 button "+1"
B click-ref 8
```

`snapshot` lists only elements worth acting on — links, buttons, fields — as
`ref role name`, and `click-ref` clicks one. Refs survive a detach, so the two
commands may be separate calls, but they die on navigation or re-render.

## Viewport

```bash
B emulate --device iphone|ipad|laptop|desktop
B emulate --size 1440x900
```

The override is **sticky and has no clear** — it outlives the command, and
another size is the only way back.

## Tabs inside the pane

```bash
B tabs                        # 1* https://... Title   — the star is the active tab
B new-tab <url>
B activate <n>                # n is the row number from `tabs`
B close <n>
```

Row numbers come from the pane's own tab strip, so they match what the user
sees. Closing the last tab closes the pane; that prints `closed <view>`.

## Gotchas

**Every pane shares one Chromium process and one CDP port.**
`/json/list` on that port therefore carries other panes' pages too. This script
scopes every command to the pane behind `--view`, but a raw CDP client will not.

`open --new` makes another browser pane; `new-tab` makes a tab inside the one
you have.

**terminal-browser rewrites `~/.config/herdr/config.toml` on first open**, with
no prompt: it sets `[experimental] kitty_graphics = true` and reloads the config.

## External CDP clients

```bash
B endpoint    # view, cdp_http, browser_ws
```

Use the browser-level endpoint so the client can drive multiple tabs.

- Playwright: `chromium.connectOverCDP(cdp_http)`; Playwright MCP:
  `--cdp-endpoint=<cdp_http>`.
- Chrome DevTools MCP: `--browser-url=<cdp_http>`.
- Browser Use: `BU_CDP_URL=<cdp_http>` or `BU_CDP_WS=<browser_ws>`.

The client sees every pane's pages, per the gotcha above.

terminal-browser owns Chromium: disconnecting a client leaves it running,
closing the pane closes the browser.

## OpenCode only — skip on Claude Code and Codex

There is no banner and `CLAUDE_PLUGIN_ROOT` is empty. Set the path directly:

```bash
B=~/.config/opencode/skills/herdr-browser/scripts/browser.ts
bun "$B" status
```
