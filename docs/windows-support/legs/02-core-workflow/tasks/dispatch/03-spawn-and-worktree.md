# DISPATCH-03: Spawn safety and worktrees on Windows

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: dispatch/02
> **Blocks**: platform/02
> **Status**: todo
> **Models**: dev=opus/high

## Goal

Dispatch's worktree tooling round-trips files byte for byte, seeds ignored files and links the plan dir on Windows, `opencode-run.ts` keeps its prompt out of argv, and autopilot's browser opener works on WSL.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/worktree.ts` (modify) — pin `core.autocrlf=false`, `cpSync` fallback in `seedIgnored`, junction link on win32.
- `packages/dispatch/skills/flightplan/scripts/worktree.test.ts` (modify) — tests for the three worktree changes.
- `packages/dispatch/skills/flightplan/scripts/opencode-run.ts` (modify) — move the message out of argv.
- `packages/dispatch/skills/flightplan/scripts/opencode-run.test.ts` (modify) — special-character prompt test.
- `packages/dispatch/skills/autopilot/scripts/launch.ts` (modify) — pure opener argv builder with the WSL branch.
- `packages/dispatch/skills/autopilot/scripts/launch.test.ts` (modify) — opener tests per platform.

Work test-first: write each test, watch it fail on macOS, then change the product code.

## Implementation notes

### 1. Pin `core.autocrlf=false` in worktree git calls

`worktree.ts` runs every git command through `gitRaw(root, args, options)`, which spawns `["git", "-C", root, ...args]`. A system or user `core.autocrlf=true` (the windows-latest default, `windows.md`) makes `worktree add`, `read-tree -u` and `git apply` write CRLF back into files that were LF on disk. Add `"-c", "core.autocrlf=false"` to the argv in `gitRaw`, right after `-C root`, so every snapshot and replay command is covered by one change:

```ts
return Bun.spawnSync(["git", "-C", root, "-c", "core.autocrlf=false", ...args], { ... });
```

Test: build the existing `fixture()` repo, then run `git config core.autocrlf true` in it (this simulates the Windows default on macOS, where git honours it the same way). Write an LF file, run `create` and then `land` for a ref, and assert the file's bytes in the main tree and in the worktree contain no `\r`. This test fails before the change on macOS too, because `autocrlf=true` converts on checkout on every OS.

### 2. `seedIgnored` falls back to `fs.cpSync`

`seedIgnored(repo, path, excluded)` copies each ignored path with `Bun.spawnSync(["cp", "-c", "-R", source, destination])`, then on a non-zero exit with `cp -R`. Plain cmd or PowerShell has no `cp`, so `Bun.spawnSync` throws (`Executable not found`), and with Git's `usr/bin` absent every ignored seed (`node_modules`) is silently skipped.

Change the copy so that when both `cp` attempts fail, or the spawn throws, it runs `cpSync(source, destination, { recursive: true })` (import from `node:fs`). Keep the existing `cp -c` (APFS clone) path first on macOS: it is the fast path there.

Make the copier injectable so the test needs no PATH stub (shared rule 4 bans extensionless stubs, and `inventory.md` classes the PATH-stub test `(c)` on Windows). One shape that works:

```ts
type Spawn = (argv: string[]) => { exitCode: number | null };
function seedIgnored(
  repo: string,
  path: string,
  excluded: string,
  spawn: Spawn = defaultSpawn,
): void;
```

`defaultSpawn` wraps `Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: process.env })` and turns a throw into `{ exitCode: null }`. If `create` is the only caller, thread the parameter through an exported test seam rather than through the CLI. Test: call the seam with a spawn that always fails, and assert an ignored directory (with a nested file) arrives in the worktree with the same bytes.

### 3. Junction link for the plan dir on win32

`create` links the plan directory into the worktree with `symlinkSync(join(resolve(options.repo), planOf(options)), link)`. A plain directory symlink needs Developer Mode or admin on Windows (`windows.md`); a junction needs neither. Use:

```ts
symlinkSync(target, link, platform === "win32" ? "junction" : undefined);
```

`platform` is a parameter defaulting to `process.platform` (shared rule 1's injectable pattern), so a macOS test asserts the win32 branch picks `"junction"` and every other platform passes `undefined`. Extract the type choice as a small pure function, for example `export function linkType(platform: NodeJS.Platform = process.platform): "junction" | undefined`, and unit-test it. Do not run a real junction on macOS; `symlinkSync` ignores the type there.

### 4. `opencode-run.ts` keeps the message out of argv

Today `run(mode, prompt, model)` spawns:

```ts
[
  OPENCODE_BIN,
  "run",
  ...(model ? ["-m", model] : []),
  "--format",
  "json",
  message,
];
```

with `stdin: "ignore"`. npm's `opencode` on Windows is a `.cmd` shim, and Bun throws before spawning a `.cmd` file when any argument holds `"`, `%`, `&`, `^`, `|`, `<`, `>` or a newline (`windows.md`). Every real prompt holds a newline, so every call throws on Windows.

Follow the "Prompts leave argv" frozen decision in `shared.md`:

1. **Probe first, on macOS**, before changing the code: `printf 'Reply with the single word PONG.' | opencode run --format json`. Record the full command output (or "opencode not installed") in your report.
2. **If the output contains `PONG`**: drop `message` from argv and pass it as `stdin: new TextEncoder().encode(message)` (or a `Buffer`) instead of `"ignore"`. A finished stdin buffer reaches EOF, which also satisfies the existing comment's reason for `"ignore"` (opencode hangs on an open stdin with no EOF); update that comment to say so.
3. **If it does not, or `opencode` is not installed**: write `message` to a file inside a `mkdtempSync(join(tmpdir(), "q-lab-opencode-run-"))` leaf, pass `-f <file>` and the fixed message `Follow the instructions in the attached file.` in argv, keep `stdin: "ignore"`, and delete the leaf (`rmSync(dir, { recursive: true, force: true })`) in a `finally` after the child exits.

Either way, no prompt text appears in argv. Keep `env: { ...process.env, RELAY_DELEGATED: "1" }` and the `OPENCODE UNREACHABLE` catch unchanged.

Test in `opencode-run.test.ts`: the existing fake `opencode` stub (as made honest by the test-env work: a `.cmd` shim on win32, a shell stub elsewhere) records its argv and its stdin to a file. Run the wrapper with a prompt holding `"`, `%`, `&` and a newline (for example `say "hi" 100% & bye\nline two`) and assert:

- on the stdin path, the stub's stdin equals the full message (contract prefix + prompt), and no argv element contains `100%` or a newline;
- on the file path, argv contains `-f` and the fixed message, the attached file held the full message, and the leaf is gone after exit.

Write only the test for the path you took. Run it through the `.cmd` stub on win32 and the normal stub elsewhere; on macOS the win32 branch is proven by the argv assertion, since Bun's `.cmd` refusal only fires on Windows.

### 5. WSL branch in autopilot's browser opener

`launch.ts` has a private `openBrowser(url)` that picks `["open", url]` on darwin, `["cmd", "/c", "start", "", url]` on win32, else `["xdg-open", url]`, then `Bun.spawn(command, { detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref()`, logging `flightdeck notice: browser opener unavailable: …` on a throw. `xdg-open` is often missing on WSL (`windows.md`).

Extract a pure, exported builder that returns the commands to try in order, and keep the spawning in `openBrowser`:

```ts
export function openerCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  readProcVersion: () => string = () => readFileSync("/proc/version", "utf8"),
): string[][];
```

- `darwin` → `[["open", url]]`
- `win32` → `[["cmd", "/c", "start", "", url]]`
- `linux` on WSL → `[["wslview", url], ["cmd.exe", "/c", "start", "", url]]`
- other `linux` (and any other platform) → `[["xdg-open", url]]`

WSL is `env.WSL_DISTRO_NAME` set (non-empty), or `readProcVersion()` containing `microsoft` case-insensitively. A throwing `readProcVersion` means not WSL. Only call `readProcVersion` when the platform is `linux` and `WSL_DISTRO_NAME` is unset.

`openBrowser` tries each command in order: `Bun.spawn` throws synchronously when the executable is missing, so on a throw it moves to the next command, and logs the existing notice only when every command threw.

Tests in `launch.test.ts`: one per branch — darwin, win32, WSL via `WSL_DISTRO_NAME`, WSL via a `/proc/version` reader returning `Linux version 5.15.0-microsoft-standard-WSL2`, plain linux (reader returns a non-Microsoft string), and plain linux with a throwing reader. The darwin, win32 and plain-linux results must equal today's argv exactly.

## Acceptance criteria

- [ ] `gitRaw` in `worktree.ts` passes `-c core.autocrlf=false` on every git call, and a test with `core.autocrlf true` set in the fixture repo proves an LF file comes back from create and land with no `\r` (the test fails without the pin).
- [ ] `seedIgnored` copies an ignored directory with `cpSync` when the injected spawn fails for both `cp` attempts, proven by a test with no PATH stub.
- [ ] The plan-dir link uses type `"junction"` when the injected platform is `win32` and no type otherwise, proven by a unit test of the type choice.
- [ ] The report records the `opencode run` stdin probe output (or that opencode is absent) and which path (stdin or `-f` file) `opencode-run.ts` now uses.
- [ ] `opencode-run.ts` spawns opencode with no prompt text in argv, and a test passes a prompt holding `"`, `%`, `&` and a newline that reaches the stub intact.
- [ ] `openerCommands` returns the exact argv lists above for darwin, win32, WSL (both detection routes) and plain linux, and darwin/win32/plain-linux output equals the pre-change argv.
- [ ] `openBrowser` falls back from `wslview` to `cmd.exe` when the first spawn throws.
- [ ] macOS and Linux behaviour is unchanged apart from the autocrlf pin: `/tmp/q-lab` paths, `cp -c` first, `open` / `xdg-open` argv all as before.

## Verification

- [ ] `bun test packages/dispatch/skills/flightplan/scripts/worktree.test.ts` passes.
- [ ] `bun test packages/dispatch/skills/flightplan/scripts/opencode-run.test.ts` passes.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/launch.test.ts` passes.
- [ ] `bun test packages/dispatch` passes.
- [ ] `bunx --bun tsc --noEmit` prints nothing.
- [ ] `git status --short -- packages/dispatch/skills/flightplan/scripts/worktree.ts packages/dispatch/skills/flightplan/scripts/opencode-run.ts packages/dispatch/skills/autopilot/scripts/launch.ts` lists all three as modified.
- [ ] `rg -U -n '"--format",\s*"json",\s*message' packages/dispatch/skills/flightplan/scripts/opencode-run.ts` finds nothing (run it once before the change and confirm it matches the current argv).

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                      | 2–3 (below bar)                                                                                                                                          | 4–5 (pass)                                                                                                                   |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A prompt still reaches argv, autocrlf is pinned on only some git calls, or the darwin/linux opener argv changed | Fixes land but one path drifts: the `cpSync` fallback skips nested files, the leaf file outlives the child, or a throwing `/proc/version` reader crashes | All five changes match the spec on every named platform, and macOS/Linux behaviour differs only by the autocrlf pin          |
| Test coverage           | ×2     | No new tests, or tests that pass before the change                                                              | Happy paths only; the win32 junction or WSL `/proc/version` branch untested                                                                              | Each change has a test that failed first; win32 and WSL branches covered by injection; special-character prompt test present |
| Interface & readability | ×1     | Platform checks scattered inline, untestable                                                                    | Seams exist but are awkward (CLI flags added only for tests)                                                                                             | Small pure seams (`openerCommands`, `linkType`, injected spawn) with plain names and real defaults                           |
| Assumptions & docs      | ×1     | Probe skipped or its result not reported                                                                        | Probe reported but the chosen path not tied to it                                                                                                        | Probe output and chosen path in the report; each Windows assumption traces to `windows.md`                                   |

## Out of scope

- relay's opencode backend and codex image mode — Deferred. Reason: relay owns its own copy of the spawn code; plugins import nothing from each other.
- Bypassing the `.cmd` shim so a temp path holding `&` or `%` works with the `-f` fallback — Deferred. Reason: banked as a known gap; it only applies when the stdin probe fails.
- Path-identity normalisation in `registeredPaths` and the task-path regexes — Deferred. Reason: handled by the path-handling work this task depends on.
- Test-only fixes (`HOME`/`USERPROFILE` isolation, `.cmd` stubs, `fixture()` autocrlf, the newline file name, the `cp` PATH-stub skip) — Deferred. Reason: done by the dispatch test-env work before this task.
