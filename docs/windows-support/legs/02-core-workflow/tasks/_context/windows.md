# Windows runtime facts

Measured on GitHub's windows-latest runner, Bun 1.4.4, 2026-10-29, under both pwsh and Git Bash (identical results). Every task relies on these instead of re-measuring.

## Processes

- `Bun.spawn` / `Bun.spawnSync` run a `.cmd` file given by absolute path, and resolve a bare name to `<name>.cmd` through `PATH` + `PATHEXT`. `Bun.which("codex")` returns `C:\npm\prefix\codex.cmd`. npm installs `codex` and `opencode` as `.cmd` shims; both answer `--version` when spawned by bare name.
- **Bun throws before spawning a `.cmd` file when any argument contains `"`, `%`, `&`, `^`, `|`, `<`, `>` or a newline**: `The argument 'args[N]' contains a cmd.exe special character and cannot be safely passed to a .bat/.cmd file.` Spaces, tabs, `( ) ! ' $ * \` backticks and CJK text pass through intact.
- Data written to a `.cmd` child's stdin arrives intact, special characters included.
- An extensionless `#!/bin/sh` script cannot be spawned: `Executable not found in $PATH`. `Bun.spawn(["bash", script, ...])` runs it, because Git Bash's `bash` is on the runner's `PATH`. Git for Windows is optional on user machines.
- `Bun.spawn(["start", ...])` fails with `Executable not found in $PATH`: `start` is a cmd builtin. `["cmd", "/c", "start", "", url]` is the working form; the empty string is the window title `start` would otherwise take from a quoted URL.
- A `.cmd` test stub has the form `@"<process.execPath>" "<fake>.ts" %*` followed by `\r\n`.

## Environment

- `os.homedir()` in a child process reads `USERPROFILE`. Setting only `HOME` changes nothing; setting `USERPROFILE` redirects it.
- `os.tmpdir()` reads `TEMP` / `TMP`. Setting only `TMPDIR` changes nothing.
- `os.tmpdir()` returns the 8.3 short form `C:\Users\RUNNER~1\AppData\Local\Temp`. `realpathSync` keeps the short form; `realpathSync.native` expands it to `C:\Users\runneradmin\AppData\Local\Temp`. `git rev-parse --show-toplevel` and `git worktree list` print the long form with forward slashes (`C:/Users/runneradmin/...`).
- Windows paths are case-insensitive; the drive letter's case can differ between sources.
- The runner's git has `core.autocrlf=true`, so a fresh `git init` repo there converts LF to CRLF on checkout. The repo's own `.gitattributes` does not reach repos created under `tmpdir()`.
- `symlinkSync(target, link, "junction")` for a directory works (junctions need no Developer Mode or admin rights). A plain directory symlink needs Developer Mode or admin; the runner is admin, users usually are not.
- `WSL_DISTRO_NAME` is unset on native Windows.

## File names and paths

- NTFS forbids `<`, `>`, `:`, `"`, `|`, `?`, `*` and control characters (newline included) in file names.
- `\tmp\x` (what `join("/tmp", "x")` returns on Windows) is drive-relative, not absolute: two processes whose cwd sit on different drives resolve it to different directories.
- `new URL(rel, import.meta.url).pathname` returns `/D:/a/...`, which `bun` cannot load. Use `join(import.meta.dir, rel)` or `fileURLToPath`.
- `path.join` and `path.resolve` return backslash paths on Windows; `Bun.Glob.scanSync` returns backslash paths.
- In `.gitignore` and git pathspecs a backslash is an escape, not a separator: patterns for git stay POSIX (`path.posix.join` or a literal).
- `chmodSync(f, 0o000)` does not make a file unreadable on Windows.
- `/dev/null/nope` is a writable path on Windows (`D:\dev\null\nope`).

## WSL

- WSL reports `process.platform === "linux"`. Detect it by `WSL_DISTRO_NAME` being set, or `/proc/version` containing `microsoft` (case-insensitive).
- `xdg-open` is often absent on WSL. `wslview` (from `wslu`) opens a URL in the Windows browser when installed; `cmd.exe /c start "" <url>` works from WSL through interop.
