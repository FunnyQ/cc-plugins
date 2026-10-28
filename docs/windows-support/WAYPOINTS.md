# Windows Support — Waypoints

> Rolling-wave roadmap. One leg planned in detail at a time.
> Status: [x] done · [~] active (exactly one) · [ ] pending

## Legs

- [x] 1. Windows baseline — windows-latest and ubuntu-latest CI jobs run `bun test` and `tsc` and record which suites fail, and no plugin prints an error in a native Windows session, CLI or Desktop app, with or without Git Bash (monitor hooks exit quietly under both Git Bash and PowerShell)
      → legs/01-baseline/
- [~] 2. Core workflow plugins — chronicle, dispatch, guard and relay pass their suites on windows-latest, and commit / release / flightplan / autopilot / the comment reviewer each run once on a real Windows PC and pass on WSL (shared fixes: temp dir, home dir, file opener for macOS / Windows / Linux / WSL, `sh -c`, CRLF)
      → legs/02-core-workflow/
- [ ] 3. Browser and UI plugins — browsers (chrome, firefox, zen), runes and herdr work on Windows and WSL: browsers find Windows- and Linux-installed binaries, explain opens its HTML page, herdr-browser drives a pane; safari refuses with a clear "macOS only" message
      → legs/03-browser-ui/
- [ ] 4. Monitor usage dashboard on Windows — cockpit-rs builds for x86_64-pc-windows-msvc in CI, the release ships that binary, the shim fetches it on Windows, and `cockpit atlas serve` shows Windows usage data
      → legs/04-monitor-atlas/
- [ ] 5. Monitor cockpit live on Windows — the cockpit daemon, its hooks, the permission relay and the inbox send work in a Windows Claude Code session, with process checks ported off `libc::kill`
      → legs/05-monitor-cockpit/
