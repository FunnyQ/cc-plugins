# Runes platform and checker contract

## Mod runtime boundary

Runes hooks run in Claude Code, not Bun. Do not introduce Bun globals or Node-only imports into a module loaded by the mod. Keep pure data/command planning in hooks/platform.ts. Use hooks/platform-cli.ts, invoked with bun, for runtime filesystem and process work. Each hook retains its own engine object; pass plain values or callbacks instead of passing that object to another module.

Use an explicit platform snapshot populated through a Bun child, because the mod has no process.platform. Proposed JSON result:

```ts
type RuntimeInfo = {
  platform: "darwin" | "linux" | "win32";
  wsl: boolean;
  home: string;
  tmp: string;
  chrome: string | null;
};
```

Resolve HOME when available and USERPROFILE on native Windows when HOME is absent or empty. Keep .config/q-lab/cc-plugins/runes/config.yaml and .local/share/q-lab/runes/explain under that home. Preserve existing macOS paths. Pass the resolved HOME and USERPROFILE into Windows child environments that need them. Cache the runtime snapshot per session, with a diagnostic if probing fails; do not silently assume macOS. Inject the snapshot and operation callbacks into unit fixtures.

Three modules read `process.env.HOME` directly and must take the resolved home instead: hooks/transcript/open-image.ts:9, hooks/minimap/index.ts:7 (both build `<home>/.claude/projects` at module load), and hooks/teacher/lessons-cli.ts:20, a Bun child that resolves its own home and so needs the same HOME-then-USERPROFILE fallback. Move the two module-load constants behind a function of the resolved home so they never capture `undefined/.claude/projects`.

## Platform operations

Use platform-cli.ts as a small fixed-operation child, with structured JSON on stdin for path-bearing operations. Proposed operations: info, mkdir, open, trash and cleanup-check. Parse a closed operation set and reject unknown operations. Do not build a generic shell execution service. Test child exits and errors through injected operations before adding real subprocess coverage.

Replace explain.ts's ["mkdir", "-p", dir] call with the structured mkdir operation, implemented with recursive filesystem creation in the Bun child. Test first-run HTML generation without Unix mkdir on PATH.

Use os.tmpdir() only in Bun children. Preserve /tmp/q-lab/runes on macOS/Linux and use <system-temp>/q-lab/runes on native Windows, including raw, images and glow roots. Set glow's child environment consistently so it does not write a literal ~ directory. Preserve its existing graceful fallback when glow is absent; give a platform-appropriate install hint without installing it.

Keep qlmanage and osascript only on macOS. Open raw Markdown and pasted-image files with the system file opener elsewhere. Derive image transcript paths from the resolved home, accept native Glob path separators and preserve the existing missing-image diagnostic. Both history reopen and checker settlement must share the same opener behavior. Catch opening failures, retain HTML and surface the failed operation rather than losing the completed explanation.

For WSL opening, try wslview, then a Windows opener after path conversion. Follow windows.md for data-safe path handling. Decode/encode file URLs through a URL-aware implementation; do not concatenate file:// with raw Windows paths.

Keep explicit page deletion recoverable. On macOS preserve trash. On Windows use a native recycle operation through a fixed-source PowerShell child, with paths passed as structured data. On Linux use an available trash facility; if unavailable, preserve the page and report a clear error. Do not substitute rm or permanent deletion. Keep screenshot deletion separate from persisted-page trash: cleanup-check deletes exactly the page's `<name>.check.png` and `<name>.check-narrow.png`, tolerates either being absent and never deletes HTML or a directory.

## Checker execution

This is a port, not a redesign. Keep the existing checker flow in hooks/explain/checker.ts: the `cN` verdict tokens, the `pending` map, `expire`, the 180,000 ms timeout, agent-type matching, denied-spawn handling and late-verdict isolation. Change only what fails on Windows or Linux:

1. **Chrome discovery.** Add `chrome: string | null` to RuntimeInfo, resolved by platform-cli.ts's `info` operation: the existing macOS path on darwin, ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA `Google\Chrome\Application\chrome.exe` on win32, and google-chrome / google-chrome-stable / chromium / chromium-browser on PATH on Linux, WSL included. Never return a Windows executable on WSL. Find Chrome without importing browsers plugin code. Replace `$.fs.exists(CHROME)` with `runtime.chrome !== null`. Keep the current no-Chrome outcome: check skipped, explanation opened.
2. **Screenshot command.** Replace the hardcoded Chrome command in CHECKER_PROMPT with a fixed helper, hooks/explain/checker-cli.ts, invoked as `bun '<plugin root>/hooks/explain/checker-cli.ts' <wide|narrow> '<page>'`, with every `\` in both paths converted to `/` first (a UNC `\\server\share` becomes `//server/share`) and each path in single quotes, where Bash expands nothing. The helper resolves Chrome itself (reusing platform-cli.ts's discovery function), derives `<name>.check.png` or `<name>.check-narrow.png` beside the page, encodes the page with `pathToFileURL`, launches Chrome with an argv array and a `mkdtemp` profile it removes after Chrome exits, keeps wide 1280×4000 and narrow 420×7000, prints `{"output": "<png>"}` on success and exits nonzero with a stderr diagnostic on failure. It accepts no other argument. The task message gives the checker both exact commands for its page.
3. **Bash permission.** Replace `allowsBash` with an exact match: allow a checker Bash call only when its command equals one of the two commands the engine wrote into that pending check's task message. Store them in the `Pending` record. When the plugin root or the page path contains `'` or a newline, write no auto-allowed command and let the call fall through to the normal permission flow. This removes the `explainDir.includes(" ")` refusal, which denies every call on a Windows home with a space.
4. **Read/Edit containment.** Keep the root-scoped rule. Fix `inside`: normalize separators to `/`, compare case-insensitively on win32, require the root plus a separator as the prefix (so `explain-other/` is outside) and reject any `..` segment.
5. **Settle.** Replace `["open", path]` with the shared opener from runes/02 and `["rm", "-f", …]` with platform-cli.ts's cleanup-check. Run cleanup even when opening fails, and record an opener failure in the entry note without changing the verdict.
6. **Geometry.** Pass `runtime.chrome` to geometry-cli.ts. Replace its `file://` concatenation with `pathToFileURL(page).href`. Keep its `{faults: string[]}` output, its isolated `mkdtemp` profile and the 20,000 ms caller timeout.

Do not add job manifests, per-page locks, process-ownership tracking or a cancel operation. A screenshot still being written when a check times out is existing behavior on every OS and stays out of this leg.

Add regression fixtures for Windows-looking paths injected on a macOS host: spaces, CJK, `&`, `%`, `#`, apostrophes, backslash separators, case aliases, `..`, sibling prefixes and a plugin root carrying `$(…)`, a UNC home and a path carrying `'`. Never widen permissions merely to make the Windows happy path pass.

## Verification split

The mod suite imports claude-code/testing and runs through claude plugin test packages/runes. Its current baseline is 428 passing tests. Keep host fixtures isolated in memory and explicitly support HOME absent / USERPROFILE present.

Create hooks/platform.spec.ts for pure helpers and Bun child contracts. It must not import claude-code or claude-code/testing. Run it with hooks/explain/themes.spec.ts from the package directory. Do not rename the entire mod suite or remove root exclusions to make Bun collect it. Extend mod tests for the integration behavior, not just pure helper outputs.

Use claude plugin validate packages/runes and the complete mod suite as local execution gates. Record native Windows/WSL rendering and presses as owed. No model invocation or API credits are needed for deterministic hook tests.
