# MONITOR-01: Hook entry

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: platform/02
> **Status**: done
> **Models**: dev=opus/high

## Goal

monitor's cockpit SessionStart and Stop hooks run as `bun hook.ts <event>` in exec form: on win32 they drain stdin and exit 0 with no output, and on every other platform they behave exactly like today's direct shim call.

## Files to create / modify

- `packages/monitor/skills/cockpit/bin/hook.test.ts` (new) — written first; pins the manifest shape, the skip rule, POSIX passthrough and win32 silence.
- `packages/monitor/skills/cockpit/bin/hook.ts` (new) — the platform-aware hook entry.
- `packages/monitor/.claude-plugin/plugin.json` (modify) — the two cockpit hooks switch to exec form; nothing else changes.

## Implementation notes

### Write the test first

Write `hook.test.ts` and watch it fail (no `hook.ts`, old manifest) before writing `hook.ts` or editing the manifest. Follow the style of the neighbouring `cockpit.test.ts`: `import { expect, test } from "bun:test"`, `node:fs` helpers (`mkdtempSync`, `writeFileSync`, `chmodSync`, `rmSync`), `tmpdir()` from `node:os`, `join` from `node:path`, paths built from `import.meta.dir`.

### `hook.ts` (inline exactly; no comments, no extra options)

```ts
import { join } from "node:path";

export function shouldSkip(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

if (import.meta.main) {
  if (shouldSkip(process.platform)) {
    await Bun.stdin.text();
    process.exit(0);
  }
  const proc = Bun.spawn(
    [join(import.meta.dir, "cockpit"), "hook", ...process.argv.slice(2)],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(await proc.exited);
}
```

- Draining stdin on win32 matters: Claude Code writes the hook payload to stdin, and exiting before reading it can surface a broken-pipe error.
- On POSIX the shim (`packages/monitor/skills/cockpit/bin/cockpit`, POSIX `sh`, mode 755) runs unchanged; it honours `COCKPIT_BIN` with `exec "$COCKPIT_BIN" "$@"` before anything else, which is what the passthrough test uses.
- `process.argv.slice(2)` is the event name (`session-start` or `stop`) and anything after it, forwarded verbatim.

### `plugin.json` — before and after

Current SessionStart cockpit entry and Stop entry:

```json
{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit\" hook session-start", "timeout": 5 }
{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit\" hook stop", "timeout": 10 }
```

Replace them with (keep the file's existing 2-space multi-line JSON formatting):

```json
{ "type": "command", "command": "bun", "args": ["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts", "session-start"], "timeout": 5 }
{ "type": "command", "command": "bun", "args": ["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts", "stop"], "timeout": 10 }
```

Keep byte-identical: the `startup|resume|clear|compact` matchers, the order of hook groups, the `version` field, and the setup.ts entry `{"type":"command","command":"bun \"${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts\" --session-check","timeout":20}`. Do not touch `packages/monitor/.codex-plugin/hooks.json`.

### `hook.test.ts` cases

1. **Manifest shape** — parse `../../../.claude-plugin/plugin.json` (relative to `import.meta.dir`). Assert `hooks.SessionStart[0].hooks[0]` equals `{ type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --session-check', timeout: 20 }`, `hooks.SessionStart[1].hooks[0]` equals the exec-form `session-start` entry above, and `hooks.Stop[0].hooks[0]` equals the exec-form `stop` entry above (`toEqual`, so no extra keys slip in). Assert both SessionStart groups keep `matcher: "startup|resume|clear|compact"`.
2. **Skip rule** — `shouldSkip("win32")` is `true`; `shouldSkip("darwin")` and `shouldSkip("linux")` are `false`.
3. **POSIX passthrough** — `test.skipIf(process.platform === "win32")`. Make a `mkdtempSync(join(tmpdir(), "hook-test-"))` dir, write a fake executable there and `chmodSync(path, 0o755)`:
   ```sh
   #!/bin/sh
   echo "ARGS $*"
   cat
   echo "MARKER-STDERR" >&2
   exit 3
   ```
   Run `Bun.spawnSync(["bun", join(import.meta.dir, "hook.ts"), "session-start"], { stdin: Buffer.from("payload"), env: { ...process.env, COCKPIT_BIN: fake } })`. Expect stdout contains `hook session-start` and `payload`, stderr contains `MARKER-STDERR`, and `exitCode` is `3`. `rmSync(dir, { recursive: true, force: true })` in a `finally` inside the same test.
4. **win32 silence** — `test.skipIf(process.platform !== "win32")`. Spawn `bun hook.ts stop` with `Bun.spawn` and `stdin: "pipe"`. Write `{"hook_event_name":` to stdin and flush, wait 300 ms, and assert `proc.exitCode` is still `null` (the entry is waiting for EOF, so it really drains). Then write `"Stop"}`, end stdin, and expect `await proc.exited` to be `0` with empty stdout and stderr.

## Acceptance criteria

- [x] `packages/monitor/skills/cockpit/bin/hook.ts` exports `shouldSkip(platform: NodeJS.Platform): boolean` and runs its main body only under `import.meta.main`.
- [x] On win32, `bun hook.ts <event>` reads all of stdin and exits 0 with empty stdout and stderr.
- [x] On macOS/Linux, `bun hook.ts <event>` runs `<bin dir>/cockpit hook <event>` with stdin, stdout, stderr and exit code passed through unchanged.
- [x] `packages/monitor/.claude-plugin/plugin.json`'s two cockpit hooks are the exec-form entries above with timeouts 5 and 10; the setup.ts hook, matchers and version are unchanged.
- [x] `packages/monitor/.codex-plugin/hooks.json` and `packages/monitor/skills/cockpit/bin/cockpit` are unchanged.
- [x] (human) On macOS, make a recording stub: `d=$(mktemp -d) && printf '#!/bin/sh\necho "$*" >> %s/calls.log\ncat >/dev/null\n' "$d" > "$d/stub" && chmod 755 "$d/stub"`. Run `COCKPIT_BIN="$d/stub" claude --plugin-dir packages/monitor` in this checkout, send the prompt `say hi`, let the turn end, and quit. No hook error appears, and `"$d/calls.log"` holds a line `hook session-start` and a line `hook stop`.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/bin/hook.test.ts` passes (cases 1–3 run on macOS/Linux, case 4 skipped).
- [x] `bun test packages/monitor/skills/cockpit/bin/cockpit.test.ts` still passes.
- [x] `bunx --bun tsc --noEmit` prints nothing.
- [x] `git diff -- packages/monitor/.codex-plugin/hooks.json packages/monitor/skills/cockpit/bin/cockpit` prints nothing.
- [x] `git diff -U0 -- packages/monitor/.claude-plugin/plugin.json | grep -E '^[-+].*("version"|setup\.ts|"matcher")'` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                            | 2–3 (below bar)                                                                                    | 4–5 (pass)                                                                                                                                  |
| ----------------------- | ------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | Exit code or a stdio stream is lost on POSIX, or win32 prints output / exits non-zero | Passthrough works but stdin is not drained on win32, or the manifest drifts beyond the two entries | Exit code, stdin, stdout and stderr pass through unchanged on POSIX; win32 drains stdin and is silent; only the two manifest entries change |
| Test coverage           | ×2     | No test, or tests written after the code                                              | Manifest and skip rule only; passthrough not exercised                                             | Manifest, skip rule, POSIX passthrough (nonzero exit, stderr, stdin) and the win32 branch each have a test                                  |
| Interface & readability | ×1     | Extra options, wrappers, or comments around a one-screen script                       | Works but adds a layer or flag no caller needs                                                     | Matches the inlined `hook.ts` — one exported pure function plus a guarded main                                                              |
| Assumptions & docs      | ×1     | Relies on an untested shell or env behaviour                                          | Exec-form `${CLAUDE_PLUGIN_ROOT}` substitution assumed without the manifest test                   | Every assumption (exec form, `COCKPIT_BIN` override, stdin drain) is pinned by a test or stated here                                        |

## Out of scope

- Changing the shim `packages/monitor/skills/cockpit/bin/cockpit` — Deferred. Reason: this leg skips cockpit on Windows rather than porting it.
- Porting cockpit to Windows — Deferred. Reason: needs a Windows binary and a `libc::kill` port, planned for later legs.
- `packages/monitor/.codex-plugin/hooks.json` — Deferred. Reason: Codex on Windows is not supported.
- Bumping monitor's version or releasing — Deferred. Reason: release runs later through `/chronicle:release`.
