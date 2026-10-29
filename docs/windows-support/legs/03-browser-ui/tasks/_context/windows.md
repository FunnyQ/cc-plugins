# Windows and WSL runtime constraints

## Measured on windows-latest in leg 2

Use these facts instead of assuming POSIX behavior. Measurements used Bun 1.4.4 on 2026-10-29, under pwsh and Git Bash.

- Bun resolves bare executable names through PATH and PATHEXT and can spawn .cmd shims.
- Bun refuses a .cmd argv item containing a double quote, percent sign, ampersand, caret, pipe, angle bracket or newline. Feed arbitrary text through stdin. Do not assume quoting fixes that rejection.
- An extensionless shebang stub cannot execute directly. Use a .cmd wrapper around a fake Bun script on Windows, or explicitly invoke bash only for a test of shell code.
- Git Bash is on the CI runner, but is optional on user machines.
- MSYS can collapse doubled backslashes in argv from a non-MSYS parent. Feed bash source on stdin and values through env.
- A symlinked MSYS cat.exe in a PATH-only fixture can exit 127. Preserve the host environment; remove PATH case-insensitively when overriding it, since Windows can name it Path.
- os.homedir() reads USERPROFILE on Windows. A test overriding HOME must also override USERPROFILE.
- os.tmpdir() reads TEMP/TMP on Windows. A test overriding TMPDIR must also override TEMP and TMP.
- tmpdir() can return an 8.3 short path. realpathSync.native expands it; realpathSync alone does not. Git can print the long path with forward slashes.
- JSON-encode Windows paths; never splice raw backslash paths into JSON strings.
- Windows paths and Bun.Glob results use backslashes. Normalize separators for comparisons intended to be separator-independent.
- fileURLToPath converts file URLs; URL.pathname can yield unusable /D:/... spawn paths.
- path.join uses the host OS even when a test injects another platform. Use path.win32 or path.posix where constructing foreign-platform paths is intentional.
- Fresh fixture git repos inherit core.autocrlf=true; set it false inside each fixture when testing byte-level output.
- NTFS forbids angle brackets, colons, double quotes, pipes, question marks, asterisks and control characters in filenames. Skip only cases impossible on that filesystem; do not skip path portability bugs.
- chmod 000 does not reproduce Unix unreadability on Windows. Use a failing filesystem operation with portable semantics.
- Directory junctions need no Developer Mode; directory symlinks generally do. Git worktree remove can exit zero while leaving a junction; remove owned junctions before removal. This leg creates no new worktree tooling.

## Scratch and identity

Use join(tmpdir(), "q-lab", plugin, ...) on native Windows. Keep existing /tmp/q-lab/<plugin>/ paths on macOS and Linux. Resolve and compare both sides consistently. Use native realpath for identity of existing paths, with Windows case normalization. For new paths, canonicalize the nearest existing ancestor. Keep git patterns and .gitignore entries POSIX.

## WSL

Detect Linux plus WSL_DISTRO_NAME or a case-insensitive microsoft marker in /proc/version. Inject detection inputs for tests. Ordinary Linux must not invoke Windows commands.

WSL counts as Linux for the browsers plugin and the runes checker: they use Linux-installed browsers only and never launch a Windows executable. The one WSL-to-Windows crossing in this leg is the runes file opener below. When it hands a WSL path to a Windows opener, convert it with wslpath first, and do not hardcode /mnt/c or assume the user's Windows profile name.

## Openers

Use macOS open, Windows cmd.exe /c start with an empty title, and Linux xdg-open. On WSL try wslview, then the Windows opener with a converted path/file URL. Distinguish a missing opener and a nonzero opener exit. Treat paths as data, including spaces, CJK, &, %, # and apostrophes; do not concatenate them into shell source. Use a fixed-source PowerShell child with values on stdin if cmd parsing cannot preserve a tested input. Verify the actual child invocation, not just the planned argv array.

## References

- https://learn.microsoft.com/en-us/windows/wsl/networking
- https://learn.microsoft.com/en-us/windows/wsl/filesystems
- docs/windows-support/legs/02-core-workflow/tasks/_context/windows.md
