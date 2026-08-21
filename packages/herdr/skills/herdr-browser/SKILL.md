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

The browser is [terminal-browser](https://terminal-browser.sh). Every operation
below runs over CDP; only `open`, `new-tab`, `activate`, and `raw` go through its
CLI. When the binary is missing the error names the install command. Never
install it for the user without asking.

## Open a page

```bash
B open https://news.ycombinator.com
B open <url> --new
B open <url> --new --split right|left|down|up --ratio 0.4
```

Loads the URL in the browser that is already open. Opens a new one only when
none is live, or when you pass `--new`.

A new browser gets **its own Herdr tab**, so the pane the human is working in
stays whole. Pass `--split` to carve up the focused pane instead — `--ratio`
sets its share (0.2 to 0.95) and is only valid alongside `--split`.

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
B screenshot --output <path> [--full]
B console                     # this page load only; --all keeps older entries
```

Every one answers in one line. A selector that matches nothing, a key that does
not exist, and a URL that fails to resolve all fail loudly — none of them
reports success.

`screenshot` captures the viewport at the device pixel ratio, so the file comes
out twice the CSS size on a retina display.

`--full` captures the whole scroll height into that one file, without touching
the viewport. **Trust it only on a static page.** On a page with scroll-triggered
reveals it fails silently, and in two different ways: run it bare and it returns
wide blank bands, because the composite never scrolls and the reveals never fire;
scroll the page first and it returns the content composited twice, even though
the DOM holds one copy and nothing on the page is `fixed` or `sticky`. Neither
reports an error, and a long page also costs tens of thousands of pixels and
several megabytes.

Such a page has no one height to capture — `scrollHeight` read 12315, then 14247,
then 27295 on the same site as the viewport and the animations changed. Scroll it
and take a viewport shot per screen instead. Enlarging the viewport with `emulate
--size` is not the way around this: Chromium clamps that capture at 16384px, and
the override is sticky.

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

**When you already know what the thing is called, skip the snapshot entirely:**

```bash
B raw -- find role button click --name "Sign in"
B raw -- find text "Add to cart" click
B raw -- find label Email fill you@example.com
```

`find` locates and acts in one call, and answers `✓ Done`. A snapshot on a real
page costs 5,340 chars before you have clicked anything — this costs seven.
Reach for `snapshot` when you need to discover what is on the page, not when you
already know.

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
sees. Closing the last tab closes the browser, and the Herdr tab `open` made
goes with it; that prints `closed <view>`.

## Gotchas

**Every pane shares one Chromium process and one CDP port.**
`/json/list` on that port therefore carries other panes' pages too. This script
scopes every command to the pane behind `--view`, but a raw CDP client will not.

`open --new` makes another browser in its own Herdr tab; `new-tab` makes a page
tab inside the browser you already have.

**There is no PDF.** terminal-browser's Chromium is Electron's, and it does not
expose `Page.printToPDF` — CDP answers `'Page.printToPDF' wasn't found`. `B raw
-- pdf` fails the same way, so this is a limit of the browser, not of the skill.

**terminal-browser rewrites `~/.config/herdr/config.toml` on first open**, with
no prompt: it sets `[experimental] kitty_graphics = true` and reloads the config.

## Cookies and headers

```bash
B cookies                                   # name=value domain/path flags
B cookies set <name> <value> [--url U] [--domain D] [--path P]
                            [--http-only] [--secure] [--same-site Lax] [--expires N]
B cookies clear
B headers '{"Authorization":"Bearer ..."}'  # on every request from now on
```

`eval 'document.cookie'` reaches only what JS may read: it never sees an
httpOnly cookie and cannot write one. These go over CDP and do. Use `eval` for
`localStorage` and `sessionStorage` — JS owns those outright.

**Chrome answers a cookie it rejects with success, not an error.** A wrong
domain, or `--secure` on an http page, is a silent no-op at the protocol level.
`cookies set` turns that into a failure.

`headers` replaces the whole set — pass `{}` to clear.

**`cookies clear` empties the whole browser, not the current site.** `cookies`
reads only the current page's cookies, so the pair reads as if both were scoped
to it — they are not. `clear` is `Network.clearBrowserCookies`, and the profile
behind it is shared and on disk, so one call logs every pane out of every site,
permanently. To drop one cookie, overwrite it with `cookies set <name> ""
--expires 1` instead.

## Logging in

A login persists on its own — terminal-browser keeps one Chromium profile on
disk, and it survives a browser close. There is only that one, and every pane
shares it, so a login is global and outlives the session that made it. Read
`references/auth.md` before logging in anywhere, and for what an agent can read
off a logged-in page.

## Everything else — the raw escape hatch

```bash
B raw -- cookies set session abc123 --url https://example.com --httpOnly
B raw -- cookies get
B raw -- route '**/api/**' --abort
B raw -- har start /tmp/run.har
B raw -- vitals
```

`raw` hands everything after `--` to agent-browser, the CLI terminal-browser
bundles. It reaches what JS through `eval` cannot: httpOnly cookies, request
mocking, HAR, traces, video, Core Web Vitals, axe-core audits.

Read its surface with `B raw -- <command> --help` rather than guessing flags —
`cookies set` takes `<name> <value>`, not `name=value`, and the wrong shape
fails as a CDP error, not a usage error.

**Prefer a native command whenever one exists** — but the gap is narrower than
it looks, and it is worth knowing where it actually is. agent-browser is verbose
in exactly one place: `snapshot`, where it prints the whole accessibility tree
and this skill prints only what you can act on (27,363 chars to our 5,340 on
Hacker News). Everywhere else it is already terse — measured on the same page,
`get value` and `is visible` answer in 0 and 4 chars, `get box` in 61, and
`fill` and `scroll` in 7. Reimplementing those natively would save nothing, so
they are deliberately left on `raw`.

agent-browser keeps session state across separate `raw` calls — a `network
route`, a `storage local set`, or a set of `headers` outlives the command that
made it, because a daemon holds it. That is also why `route` cannot be native
here: this skill attaches and detaches per command, and a CDP interception
handler needs a connection that stays open.

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
