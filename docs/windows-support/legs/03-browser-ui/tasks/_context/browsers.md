# Browser launch contract

## Existing architecture

Chrome uses CDP over HTTP/WebSocket; Firefox and Zen use Marionette over TCP. Do not add geckodriver, Playwright or an npm dependency. Chrome binds a free port with --remote-debugging-port=0 and writes DevToolsActivePort into the isolated profile. Firefox currently chooses a free port before launch and writes marionette.port into user.js. Preserve those protocol contracts and existing navigation waits unless a measured platform failure requires changing them.

## Platform support matrix

| Browser | macOS     | Linux (including WSL) | Native Windows |
| ------- | --------- | --------------------- | -------------- |
| Chrome  | supported | supported             | supported      |
| Firefox | supported | supported             | refused        |
| Zen     | supported | supported             | refused        |
| Safari  | supported | refused               | refused        |

On native Windows, Firefox and Zen exit nonzero with an error containing `not supported on Windows` and naming the chrome skill as the alternative. Refuse at the executable CLI boundary, before state creation, argument execution or browser spawn, exactly like Safari's refusal. Keep the Firefox and Marionette parser and protocol helpers importable and testable on every OS.

WSL is Linux. On WSL, discover and launch Linux-installed browsers only. Never invoke a Windows executable from WSL. When no Linux candidate exists on WSL, the discovery error adds one line telling the user to install a Linux build of that browser inside WSL.

## Discovery

Keep macOS candidate order: Chrome stable, Canary, Chromium; Firefox Developer Edition, stable, Nightly; Zen at its existing app bundle path. Add Windows Chrome candidates from ProgramFiles, ProgramFiles(x86) and LOCALAPPDATA (`Google\Chrome\Application\chrome.exe`) without hardcoding the drive or username. Search Linux chrome/google-chrome/google-chrome-stable/chromium/chromium-browser, firefox/firefox-esr and zen/zen-browser through PATH plus standard product locations. Preserve deterministic ordering and report all attempted candidates. Treat these as explicit file/executable candidates, not shell command strings.

## Helper boundary

Keep discovery in skills/shared/platform.ts and test it beside the helper. The proposed public contract is:

```ts
type BrowserName = "chrome" | "firefox" | "zen";
type Platform = "darwin" | "linux" | "win32";
type PlatformInput = {
  platform: Platform;
  env: Record<string, string | undefined>;
  wsl: boolean;
};
function browserCandidates(name: BrowserName, input: PlatformInput): string[];
function browserStateDir(
  name: BrowserName,
  platform?: Platform,
  env?: Record<string, string | undefined>,
): string;
```

`browserCandidates("firefox" | "zen", { platform: "win32", … })` is never called; the CLI refuses first. `wsl` only selects the extra install hint. Inject candidate existence and executable lookup in tests. Preserve resolveBinary's existing callers while extending its executable validation; adapt callers together rather than retaining an unused compatibility layer.

## Native lifecycle

The existing Instance fields are id, pid, port, profile, browser and headless. Preserve native records unchanged. Keep normal user profiles untouched. Exercise registry reuse, stale record handling, graceful close, bounded termination and post-exit profile cleanup. Windows Chrome can keep files open briefly after its process exits. Never treat a launcher exit alone as permission to remove a live profile.

Use the protocol's close/quit operation where possible. If process termination is required, target the owned instance only. Do not use taskkill by executable name or a machine-wide process search. Surface cleanup failures rather than falsely reporting a clean close.

## Smoke launch ownership

For required smoke, create a fresh per-browser directory before launch and pass its absolute path as Q_BROWSER_STATE_DIR to every CLI child. The state helper places that browser's registry/profiles under this root; default paths remain unchanged when the variable is absent. Record a provisional owned instance immediately after spawn, before readiness or navigation waits, and update its port once ready. On timeout before open returns an id, terminate and await the CLI, then reclaim only records within this private root. Never infer ownership from a before/after difference of the shared registry.

## Safari and live tests

Place Safari's platform refusal at its executable CLI boundary, ahead of state creation, argument execution and driver spawn. Importing parser/protocol helpers remains portable. Require nonzero exit and "macOS only" for Linux and Windows CLI invocations.

Use a required smoke runner at .github/scripts/browser-smoke.ts, with optional --check-prerequisites. It requires Chrome on every OS and Firefox on macOS and Linux; on native Windows it requires Chrome alone and asserts that the Firefox CLI refuses with `not supported on Windows`. It executes each CLI in separate child invocations, opens a data/local test page, types/clicks, verifies page content, captures a PNG, reconnects by id and closes. Fail if a required browser is missing or any action fails. Report versions and selected binary paths. Close only smoke-owned instances in finally blocks. A child used against a server in the parent must be asynchronous to avoid deadlock. Keep existing optional local tests optional; explicitly required smoke must never turn absence into a skip.

## Evidence limit

Native CI proves Chrome on all three OS and Firefox on macOS and Linux. It does not prove WSL behavior. Keep WSL Linux-browser runs and Zen live checks owed in the verification ledger.
