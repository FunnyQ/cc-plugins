---
name: herdr-browser
description: >-
  Open web pages in a Herdr browser pane, read and drive them, and attach
  Playwright or other CDP clients.
when_to_use: >-
  Use whenever a page needs opening, reading, or driving — screenshots, clicks,
  form input, console or network debugging, viewport emulation — and Herdr is
  running. Also use to hand a CDP endpoint to Playwright, Chrome DevTools MCP,
  or Browser Use. Needs a live Herdr session; outside one, reach for another
  browser tool.
version: 1
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

## Prerequisite

Every command needs Herdr's official browser plugin. When one reports the plugin
is missing, tell the user to install it:

```bash
herdr plugin install ogulcancelik/herdr-browser
```

Installed but disabled reports `herdr plugin enable official.browser` instead.
Never install it for the user without asking.

## Open a page

```bash
B open https://news.ycombinator.com
```

Loads the URL in the browser pane that is already open. Opens a pane in a **new
Herdr tab** only when none is live, or when you pass `--new`. Add `--placement
split|overlay|zoomed` for other layouts of a new pane. Needs a running Herdr
session.

With several panes live, `open` refuses to guess — pass `--view <view_id>` or
`--new`.

## Read and drive the page

```bash
B text                        # page text, raw
B goto <url>                  # navigate the active tab
B eval <expression>
B selector-click <selector>
B type <selector> <text>
B press [selector] <key>
B wait <expression> [timeoutMs]
B click <x> <y> | wheel <x> <y> <deltaY>
B screenshot --output <path>
B console                     # this page load only; --all keeps older entries
B back | forward | reload | status
```

`console` reads the buffer the pane already keeps. It misses uncaught
exceptions — use `watch` when a page might be throwing.

## Debug a page load

```bash
B watch [url]                    # navigate there, or reload, and record
B watch <url> --body <fragment>  # also print that response's body
```

One pass over the load: every request, every console line, and the uncaught
exceptions `console` never sees, in the order they happened.

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
`ref role name`, and `click-ref` clicks one. Refs die on navigation or re-render,
so snapshot again after the page changes.

## Viewport

```bash
B emulate --device iphone|ipad|laptop|desktop
B emulate --size 1440x900
```

The override is **sticky and has no clear** — it outlives the command, and
another size is the only way back. Dark mode and offline are not offered here:
those overrides die with the session, so they need a persistent client via
`endpoint`.

## Chromium tabs inside the pane

```bash
B tabs                        # 1* https://... Title   — the star is the active tab
B new-tab <url>
B activate <n>                # n is the row number from `tabs`
B close <n>
```

`open --new` makes a Herdr tab; `new-tab` makes a Chromium tab. Both print the
tab list.

## Gotchas

Several browser panes live at once: every command takes `--view <view_id>`, and
the script lists the candidates rather than guessing. A view whose pane just
closed is ignored — it renders nowhere.

## External CDP clients

```bash
B endpoint    # view, cdp_http, browser_ws, plugin_cli
```

Use the browser-level endpoint so the client can drive multiple tabs.

- Playwright: `chromium.connectOverCDP(cdp_http)`; Playwright MCP:
  `--cdp-endpoint=<cdp_http>`.
- Chrome DevTools MCP: `--browser-url=<cdp_http>`.
- Browser Use: `BU_CDP_URL=<cdp_http>` or `BU_CDP_WS=<browser_ws>`.
- PinchTab: enable external attach, bridge to either URL.

`Target.createTarget`, `Target.activateTarget`, `Page.bringToFront`, and
`Target.closeTarget` sync with the Herdr tab strip. A client that changes only
its own selected-page state must also bring that page to front.

Herdr owns Chromium: disconnecting a client leaves it running, closing the pane
closes the view. Do not install `herdr-browser` globally.

## OpenCode only — skip on Claude Code and Codex

There is no banner and `CLAUDE_PLUGIN_ROOT` is empty. Set the path directly:

```bash
B=~/.config/opencode/skills/herdr-browser/scripts/browser.ts
bun "$B" status
```
