# Logging in, and reusing the login

`B` is `bun "$SKILL_DIR/scripts/browser.ts"`, as in `SKILL.md`.

## A login survives on its own

terminal-browser keeps one persistent Chromium profile, the Electron user-data
directory:

```
~/Library/Application Support/terminal-browser-<hash>/    # Cookies, Local Storage, Session Storage
```

So the plain case needs no work. Open the site, let the human log in, and the
login is still there after the browser closes and after a reboot — verified with
a real Google account, across a full browser exit.

What does not survive is a **session cookie**, one with no expiry. Chromium never
writes those to disk. Verified on one page: `cookies set a v --url <u>` was gone
after a full close, while the same cookie with `--expires <epoch>` came back. Most
real logins set an expiry, so most survive.

## There is exactly one profile, and everything shares it

This is the real constraint, and it cuts two ways.

`open` has no profile flag, and `raw -- --profile` refuses outright. So there is
no second profile: no way to hold two accounts for one site, and no clean room
for a test run.

**Every pane shares that one profile.** A login is therefore visible to every
terminal-browser pane, including panes another agent opens, and it stays visible
across sessions until something clears it. Treat a login here as global and
long-lived, not as scoped to the pane that made it. agent-browser isolates with
`--session`, but that flag is launch-time, so it is unreachable here.

To end one login, log out in the page. To wipe everything, close all browsers and
delete the profile directory above.

**Do not reach for `cookies clear` to tidy up.** It is
`Network.clearBrowserCookies` — the whole jar, not the current site, and not the
current pane. Because the profile is shared and on disk, one call logs the human
out of everything they were signed into, in every pane, for good. `cookies` reads
only the current page, which makes the pair look symmetric; it is not. To drop a
cookie you set, overwrite it: `cookies set <name> "" --expires 1`.

## Snapshotting a login to a file

Reach for this to move a login to another machine, or to keep a restore point for
one that expires. It is not needed for ordinary persistence.

```bash
B raw -- state save ~/.config/agent-browser/auth/<name>.json
chmod 600 ~/.config/agent-browser/auth/<name>.json
```

Restore in this order, and no other:

```bash
B open https://example.com
B raw -- state load ~/.config/agent-browser/auth/<name>.json
B goto https://example.com
```

`state load` answers `State path set to …`, which reads like a setting for the
next launch. It is not — it injects into the running browser, and the cookies
survive navigation. agent-browser's own `state load` before `open` order is
impossible here, because `raw` needs a browser that already exists.

The state carries cookies and `localStorage`, httpOnly cookies included.

**The file is cleartext**, written `0644`. `AGENT_BROWSER_ENCRYPTION_KEY` does
nothing: terminal-browser reimplements this CLI and never implemented encryption,
so the flag documented in `agent-browser state --help` is not wired here. `chmod
600` it, and never print its contents.

## What an agent can read off a logged-in page

Let the human type the password. `type` echoes its argument back, so a password
the agent types lands in the transcript.

`snapshot` and `text` mask a password field. `raw -- get value <selector>` and
`eval` return it in cleartext — the masking is cosmetic, and both of those are
credential reads. `cookies` prints values, so on a logged-in page it prints
session tokens; count the lines instead of printing them.

Nothing leaks anywhere else: neither `chromium.log` nor `stderr.log` records
typed values.

## User agent

It announces `Electron`. Google accepts it — a real sign-in, password and all,
completes and lands on `myaccount.google.com` with no interstitial.
