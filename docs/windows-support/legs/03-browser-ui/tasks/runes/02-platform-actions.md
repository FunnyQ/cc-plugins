# RUNES-02: Open and retain runes artifacts across platforms.

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/windows.md`
> - `../_context/runes.md`
>
> **Depends on**: runes/01
> **Blocks**: runes/03
> **Status**: todo

## Goal

Initialize runes and create, preview, reopen and recoverably delete its artifacts on Windows, Linux and WSL while preserving macOS behavior and retained explanations.

## Files to create / modify

- `packages/runes/hooks/platform.ts` (new) — define mod-safe platform data and operation contracts.
- `packages/runes/hooks/platform-cli.ts` (new) — execute the closed platform operation set in a Bun child.
- `packages/runes/hooks/platform.spec.ts` (modify) — cover pure planning, child input parsing and portable operation failures.
- `packages/runes/hooks/register.tsx` (modify) — initialize the runtime snapshot and resolved home without assuming Bun inside the mod.
- `packages/runes/hooks/transcript/quicklook.ts` (modify) — preserve macOS Quick Look and select file openers elsewhere.
- `packages/runes/hooks/transcript/open-raw.ts` (modify) — use the correct scratch root and portable preview operation.
- `packages/runes/hooks/transcript/open-image.ts` (modify) — resolve transcript home, native paths and preview output.
- `packages/runes/hooks/transcript/glow.ts` (modify) — supply the portable scratch home and platform-appropriate missing-tool hint.
- `packages/runes/hooks/minimap/index.ts` (modify) — build the transcript root from the resolved home instead of `process.env.HOME` at module load.
- `packages/runes/hooks/teacher/lessons-cli.ts` (modify) — fall back from HOME to USERPROFILE in this Bun child.
- `packages/runes/hooks/explain/explain.ts` (modify) — create directories, reopen pages and request recoverable deletion through the shared contract.
- `packages/runes/hooks/runes.test.tsx` (modify) — cover initialization and configuration integration with the fake host.
- `packages/runes/hooks/explain/{explain.test.ts,pane.test.tsx}` (modify, bounded mod regression family) — cover first-run generation, history actions and preservation after failed platform operations.

## Implementation notes

### Keep the mod and runtime boundary explicit

Read platform inputs through a Bun child and cache the result for the session. Do not access `Bun`, `process.platform` or unsupported Node imports from a module loaded by the mod. Keep the hook engine object inside its hook module; share plain values and callbacks instead.

Use this runtime snapshot contract:

```ts
type RuntimeInfo = {
  platform: "darwin" | "linux" | "win32";
  wsl: boolean;
  home: string;
  tmp: string;
  chrome: string | null;
};
```

Keep the child operation set closed to `info`, `mkdir`, `open`, `trash` and `cleanup-check`. Pass path-bearing values as structured JSON on stdin rather than interpolating them into a shell command. Give each operation a specific payload: no path for `info`, a directory for `mkdir`, one artifact path for `open`, explicit page paths for `trash`, and one explanation page for `cleanup-check`. Reject unknown operations, malformed input and invalid payloads before side effects. Return the snapshot as JSON for `info`, leaving `chrome` as `null` until the checker task fills its discovery; make operation failures observable through a nonzero child result and a useful diagnostic.

Use an explicit command array for the Bun child. Never turn this helper into an arbitrary executable or shell runner. Test child input parsing by running the actual child entrypoint; injected process callbacks alone do not prove the JSON boundary works.

### Resolve home and scratch locations

When `HOME` is nonempty, preserve its existing meaning. On native Windows with missing or empty `HOME`, use `USERPROFILE`. Preserve configuration under `.config/q-lab/cc-plugins/runes/config.yaml` and explanations under `.local/share/q-lab/runes/explain` within that home. Do not migrate or rename persisted artifacts.

Populate `where.home` and config operations from the resolved value. Route the three direct `process.env.HOME` readers through it too: `transcript/open-image.ts:9` and `minimap/index.ts:7` build `<home>/.claude/projects` at module load, so move each behind a function of the resolved home; `teacher/lessons-cli.ts:20` is a Bun child, so give it the same HOME-then-USERPROFILE fallback. Supply consistent `HOME` and `USERPROFILE` to Windows children that need a home. If runtime probing fails, surface a diagnostic rather than silently choosing macOS defaults.

Use `/tmp/q-lab/runes` for existing macOS/Linux scratch roots. On native Windows, use the system temp directory's `q-lab/runes` subtree. Apply the root to raw Markdown previews, extracted pasted images and glow's isolated home. Resolve the system temp directory only in Bun runtime code. Preserve missing-glow fallback and avoid creating a literal `~` directory in the session cwd. Give an installation hint appropriate to the platform without installing anything.

### Create and open artifacts

Replace explain's `mkdir -p` subprocess with the structured `mkdir` operation implemented through recursive filesystem creation in the Bun child. Prove first-run HTML generation works with no Unix `mkdir` on PATH. Keep HTML generation, history entry semantics and existing themes unchanged.

Keep `qlmanage` and `osascript` exclusively on macOS, with their existing preview behavior. Use the platform file opener for raw Markdown and pasted images elsewhere. Resolve pasted-image transcripts from the resolved home and accept native Glob separators. Keep the current missing-image diagnostic.

Use the same opening contract for explanation history and the checker completion integration. This task supplies that contract; do not rewrite checker permissions, Chrome discovery or geometry logic here. When an opener fails, retain the HTML file and completed history entry and surface the failed operation.

Use macOS `open`, native Windows `cmd.exe /c start` with an empty title, and Linux `xdg-open`. On WSL, try `wslview` before a Windows opener with a converted local path or file URL. Distinguish missing commands from nonzero command exits. Preserve spaces, CJK, `&`, `%`, `#` and apostrophes as data. When cmd parsing cannot preserve an input, use fixed-source PowerShell with structured stdin data. Test the child invocation and its received values; do not treat a planned argv array as proof of correct shell parsing. Encode file URLs through URL-aware conversion.

### Separate recoverable deletion from generated-file cleanup

Keep explicit explanation deletion recoverable. Preserve macOS `trash`; use a Windows recycle operation through fixed-source PowerShell with structured path data; use an available Linux trash facility. If no suitable facility exists or recycling fails, preserve the page and its history entry and report the error. Never fall back to permanent deletion.

Implement `cleanup-check` for the exact `.check.png` and `.check-narrow.png` names derived from the supplied explanation page. Tolerate absent generated files. Never delete the HTML, accept caller-selected output paths or expand a wildcard. Leave checker settlement wiring and permission changes to the dedicated checker work.

## Acceptance criteria

- [ ] Initialization tests cover native Windows with absent and empty `HOME`, valid `USERPROFILE`, the cached runtime snapshot and a failed probe; config and explanation paths retain their established home-relative locations, and the minimap, pasted-image and teacher roots derive from the resolved home.
- [ ] The actual Bun child rejects malformed JSON, unknown operations and invalid operation payloads, and receives path data intact without constructing shell source; mod-loaded helpers remain free of Bun globals and unsupported runtime imports.
- [ ] First-run explain generation recursively creates its destination without invoking Unix `mkdir`; tests assert the HTML and history entry are produced when Unix utilities are unavailable.
- [ ] Scratch-root and child-environment tests cover Windows raw/image/glow paths and unchanged macOS/Linux roots; image lookup accepts native path separators and missing glow or images retain their existing graceful behavior.
- [ ] Preview and reopen tests preserve macOS Quick Look, select native/WSL openers correctly, and verify received paths containing spaces, CJK and shell metacharacters; an opener failure retains the explanation and reports the error.
- [ ] Recoverable deletion tests prove failed or unavailable recycling preserves both the persisted page and its history entry, while successful recycling removes the intended entry without a permanent-delete fallback.
- [ ] Generated-file cleanup tests remove only the two page-derived PNGs, tolerate missing screenshots and leave HTML and unrelated files intact; mocked mod calls and actual child parsing both exercise the shared operation contract.

## Verification

- [ ] Run `claude plugin test packages/runes` from the repository root and require exit 0; retain existing mod coverage and add the platform integration regressions.
- [ ] Run `claude plugin validate packages/runes` from the repository root and require exit 0.
- [ ] Run `(cd packages/runes && bun test ./hooks/platform.spec.ts ./hooks/explain/themes.spec.ts)` and require exit 0; keep these Bun contracts free of `claude-code` and `claude-code/testing` imports.
- [ ] Inspect `git diff -- packages/runes` and confirm root Bun/TypeScript exclusions, themes, checker permissions and unrelated rune behavior remain unchanged.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Native Windows cannot initialize or create HTML, or a failed action destroys an explanation. | Common paths work but home resolution, WSL opening, recycling or cleanup ownership drifts. | All specified platform actions preserve persisted paths and artifacts, with closed operations and explicit failure behavior. |
| Test coverage | ×2 | Only mocked happy-path argv is checked. | Pure helpers pass but child parsing, first-run creation or preservation failures lack coverage. | Actual child contracts and mod integration tests cover platform selection, hostile path data, missing tools and failure preservation. |
| Interface & readability | ×1 | Bun leaks into the mod or a generic shell service obscures ownership. | Operations work but runtime data, hooks and subprocess responsibilities overlap. | Small plugin-local contracts separate mod-safe data from runtime actions and keep engine objects local. |
| Assumptions & docs | ×1 | Local contract results are claimed as real Windows/WSL UI proof. | Supported paths are listed but runtime prerequisites or failed actions are ambiguous. | Execution evidence separates isolated Bun contracts, complete mod tests and owed native Windows/WSL interaction checks. |

## Out of scope

- Checker discovery, screenshot permission changes and geometry execution — preserve the supplied platform contract for their integration without changing those behaviors here.
- Windows-browser fallback for the runes checker on WSL — use Linux Chrome or the existing no-Chrome skip behavior.
- Theme redesign, new rune features, dependency installation and persisted-data migration — keep this task limited to platform actions.
