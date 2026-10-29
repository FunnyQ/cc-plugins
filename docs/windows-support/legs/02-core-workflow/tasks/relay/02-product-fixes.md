# RELAY-02: Fix relay's Windows product bugs

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/inventory.md`
> - `../_context/rubric.md`
>
> **Depends on**: relay/01
> **Blocks**: platform/02
> **Status**: done

## Goal

relay writes its scratch to an absolute temp path on Windows, finds codex images at drive-letter paths, and never passes a prompt to a `.cmd` CLI in argv, while macOS and Linux keep `/tmp/q-lab/relay/relay` and their current behaviour.

## Files to create / modify

- `packages/relay/skills/relay/scripts/shared.ts` (modify) — platform-aware `TMP_ROOT`.
- `packages/relay/skills/relay/scripts/shared.test.ts` (modify) — both platform values; drop the `/tmp/q-lab` literal and the `split("/")`.
- `packages/relay/skills/relay/scripts/relay-prompt.test.ts` (modify) — line ~338 pins `"/tmp/q-lab/relay/relay/"`; compare against `TMP_ROOT`.
- `packages/relay/skills/relay/scripts/backends/codex.ts` (modify) — image-path regex and `~` slice; image mode prompt on stdin.
- `packages/relay/skills/relay/scripts/backends/codex.test.ts` (modify) — drive-letter cases, stdin image case.
- `packages/relay/skills/relay/scripts/backends/opencode.ts` (modify) — prompt leaves argv.
- `packages/relay/skills/relay/scripts/backends/opencode.test.ts` (modify) — spawn-safety cases.

Touch `relay.ts` only if the `-f` fallback below is taken and the run must delete the prompt file after the child exits.

## Implementation notes

Work test-first: write each failing test, watch it fail on macOS, then change product code. Every platform branch takes the platform as a parameter defaulting to `process.platform` (shared rule 1), so macOS tests cover win32.

### 1. Scratch root (`shared.ts:7`)

Today: `export const TMP_ROOT = "/tmp/q-lab/relay/relay";`. On Windows `\tmp\q-lab\…` is drive-relative (`windows.md`), so two processes on different drives disagree; this is inventory Part B cause 1 (`createTmpRunDir` ×2, relay-prompt 1).

```ts
export function tmpRoot(platform: NodeJS.Platform = process.platform): string;
// "win32" → join(tmpdir(), "q-lab", "relay", "relay")
// anything else → "/tmp/q-lab/relay/relay"  (byte-for-byte, a string literal, not join)
export const TMP_ROOT = tmpRoot();
```

Keep `TMP_ROOT` exported with the same name: `createTmpRunDir` and other callers already read it. Tests:

- `tmpRoot("darwin")` and `tmpRoot("linux")` equal `"/tmp/q-lab/relay/relay"`.
- `tmpRoot("win32")` equals `join(tmpdir(), "q-lab", "relay", "relay")`.
- `createTmpRunDir()` result starts with `TMP_ROOT`; take its leaf with `basename(dir)`, not `dir.split("/")`.
- relay-prompt.test.ts: `expect(promptPath.startsWith(TMP_ROOT + sep)).toBe(true)` instead of the literal.

### 2. Codex image-path extraction (`backends/codex.ts:24-27`)

Today the regex is `/(?:~|\/)[^\s"'`]+\.png/g`and`~/`is the only home prefix expanded. On Windows codex prints`C:\…\x.png`(never matched) or`C:/…/x.png`(matched from the`/`, drive dropped). Inventory Part B cause 5, codex.test.ts lines ~241, 269, 395, 455.

Change the regex to accept a drive prefix `[A-Za-z]:[\\/]`, a home prefix `~[\\/]`, or a leading `/`, and expand both `~/` and `~\` with `join(home, match.slice(2))`. The drive letter is part of the match. Sample inputs → outputs (with the file existing):

| Output text contains                                 | Returns                                         |
| ---------------------------------------------------- | ----------------------------------------------- |
| `saved to C:\Users\me\.codex\generated_images\a.png` | `C:\Users\me\.codex\generated_images\a.png`     |
| `saved to C:/Users/me/.codex/generated_images/a.png` | `C:/Users/me/.codex/generated_images/a.png`     |
| `saved to ~\.codex\generated_images\a.png`           | `join(home, ".codex\\generated_images\\a.png")` |
| `saved to ~/x/a.png` / `/tmp/a.png`                  | unchanged from today                            |

Tests build real files under `mkdtemp(join(tmpdir(), …))` and compose the printed text from that path, so they run on every OS; For the `C:\` and `C:/` shapes, which no macOS path has, add a third parameter `exists: (p: string) => boolean = existsSync` to `extractGeneratedPngPath(output, home = homedir(), exists = existsSync)` (or use it if the function already checks existence another way) and pass `() => true` in string-only tests that assert both drive-letter rows of the table above. Callers keep passing one or two arguments.

### 3. Codex image mode on stdin (`backends/codex.ts:~120`)

Today: `return { argv: [CODEX_BIN, "exec", "-o", opts.lastFile!, prompt] };`. npm installs `codex` as `codex.cmd`, and Bun refuses any `.cmd` argument holding `"`, `%`, `&`, `^`, `|`, `<`, `>` or a newline (`windows.md`). Delegate and review modes already pass `-` and `stdin: opts.promptText`. Make image mode match:

```ts
return {
  argv: [CODEX_BIN, "exec", "-o", opts.lastFile!, "-"],
  stdin: buildImagePrompt(opts.task || "an image"),
};
```

### 4. opencode prompt leaves argv (`backends/opencode.ts:~52`)

Today: `argv.push("--", opts.promptText)`. Follow the frozen decision "Prompts leave argv" in `shared.md`:

1. Probe on macOS first and paste the command and its output into your report:
   `printf 'Reply with the single word PONG.' | opencode run --format json`
2. Reply contains `PONG` → return `{ argv, stdin: opts.promptText }` with no `--` and no message positional.
3. No `PONG`, or `opencode` is not installed → file fallback: write the prompt to `prompt.md` inside the run directory (a `createTmpRunDir()` leaf under `TMP_ROOT`; when `invoke` cannot reach it, derive it from `dirname(opts.lastFile)` or add a field to `InvokeOpts`), push `-f <that file>` and the fixed message `Follow the instructions in the attached file.`, and delete the file after the child exits.

Record which path you took in the report. Either way, no element of the returned argv contains prompt text.

### Spawn-safety tests (items 3 and 4)

Use the prompt `say "hi" 100% & stop\nsecond line`. Assert, on the value `invoke()` returns:

- no argv element contains `hi`, `%`, `&`, `"` or `\n`;
- the prompt reaches the child intact: either `stdin` equals the full prompt, or (fallback) the `-f` file's content equals it.

Add one end-to-end case per backend that spawns a stub through the `.cmd`-shaped path on win32 (`@"<process.execPath>" "<fake>.ts" %*` + `\r\n`, shared rule 4) and through the existing stub elsewhere, and asserts the stub received the prompt byte-for-byte. Reuse the stub helpers the relay tests already have after the test-env fixes.

## Acceptance criteria

- [x] `tmpRoot("darwin")` and `tmpRoot("linux")` return `"/tmp/q-lab/relay/relay"`; `tmpRoot("win32")` returns `join(tmpdir(), "q-lab", "relay", "relay")`; a test asserts all three.
- [x] No relay test pins the string `/tmp/q-lab/relay/relay` except the `tmpRoot("darwin"|"linux")` assertions.
- [x] `extractGeneratedPngPath` returns the full drive-letter path for both `C:\…\a.png` and `C:/…/a.png` output, and expands `~\` as well as `~/`; tests cover each shape.
- [x] Codex image mode returns `-` as the last argv element and the image prompt on `stdin`.
- [x] opencode `invoke` puts no prompt text in argv; the report quotes the PONG probe output and names the path taken (stdin or `-f` file).
- [x] The spawn-safety prompt containing `"`, `%`, `&` and a newline reaches the stub intact for codex image mode and opencode.
- [x] Each new test fails against the pre-change code (the report names one observed failure per item 1–4).

## Verification

- [x] `bun test packages/relay` passes.
- [x] `bunx --bun tsc --noEmit` from the repo root prints nothing.
- [x] `grep -rn '"/tmp/q-lab/relay/relay' packages/relay` lists only `shared.ts` and the `tmpRoot` assertions in `shared.test.ts`.
- [x] `git status --short -- packages/relay/skills/relay/scripts/shared.ts packages/relay/skills/relay/scripts/backends/codex.ts packages/relay/skills/relay/scripts/backends/opencode.ts` shows all three modified.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                    | 2–3 (below bar)                                                                                         | 4–5 (pass)                                                                                            |
| ----------------------- | ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A prompt still travels in argv, or macOS's `TMP_ROOT` changed | Fixes land but `C:/` drops the drive, `~\` is unexpanded, or the fallback leaves the prompt file behind | All four fixes match the notes; macOS/Linux output is byte-identical                                  |
| Test coverage           | ×2     | No new tests, or win32 covered only by `skipIf`               | Happy paths only; no special-character prompt                                                           | Injected-platform root test, every path shape, special-character prompt through a stub on both shapes |
| Interface & readability | ×1     | New option or helper with no caller                           | Works but duplicates the codex delegate-mode stdin shape awkwardly                                      | `tmpRoot(platform)` plus small edits in place; image mode reads like delegate mode                    |
| Assumptions & docs      | ×1     | Probe skipped or unreported                                   | Probe run but the chosen path is not stated                                                             | Report quotes the probe output and the path taken; Windows facts traced to `windows.md`               |

## Out of scope

- `CONFIG_PATH` and other `homedir()` reads — they are correct on Windows; only tests needed `USERPROFILE`, which the test-env task fixed.
- Live (herdr pane) mode for codex and opencode — the TUI takes no prompt in argv.
- Bypassing the `.cmd` shim so a `-f` path with `&` or `%` works — Deferred. Reason: it applies only when the stdin probe fails and the user's temp path holds such a character; recorded as a known gap.
- The claude backend — `claude` is not a `.cmd` shim on npm installs measured so far and was not in the inventory.
