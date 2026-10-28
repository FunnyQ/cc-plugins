# PLATFORM-01: Line endings

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: platform/02
> **Status**: done

## Goal

A checkout made by Git for Windows (`core.autocrlf=true`) keeps every text file LF, so the POSIX shim `packages/monitor/skills/cockpit/bin/cockpit` no longer breaks on `set -eu\r`.

## Files to create / modify

- `.gitattributes` (new, repo root) — the line-ending policy, exactly one line.

## Implementation notes

### File content

Write exactly this one line, followed by a trailing newline, and nothing else:

```
* text=auto eol=lf
```

### Why this is safe on macOS and Linux

- Every text file in the index is already LF: 1056 `i/lf`, 15 `i/-text`, 4 `i/none`. Renormalizing therefore changes no file content.
- `text=auto` keeps Git's binary detection, so the 15 `-text` (binary) files stay untouched.
- `eol=lf` overrides `core.autocrlf` on checkout, which is the whole point: Git for Windows defaults to `core.autocrlf=true` and would otherwise write CRLF into the working tree.

### Constraints

- Do not edit, renormalize, or re-save any other file. If the index check below lists a path, stop and report it; do not "fix" that file.
- Do not run `git add`, `git reset`, or any command that changes the index. Other tasks run beside this one in the same repository, and the index is shared. Every check below reads the index or writes only into a `mktemp -d` directory.
- Do not touch the shim itself.
- Run every check in bash or zsh: `$'\r'` is bash syntax, and plain `sh` greps for a literal `$\r` and passes vacuously.

## Acceptance criteria

- [x] `.gitattributes` exists at the repo root and its whole content is the single line `* text=auto eol=lf` plus a trailing newline.
- [x] Every path in the index is already LF, binary, or empty, so the rule renormalizes nothing: `git ls-files --eol` lists no entry whose first column is other than `i/lf`, `i/-text`, or `i/none`.
- [x] `git check-attr text eol -- packages/monitor/skills/cockpit/bin/cockpit` reports `text: auto` and `eol: lf`.
- [x] A checkout simulated with `core.autocrlf=true` writes the shim with no carriage return (command under Verification).

## Verification

- [x] `test "$(cat .gitattributes)" = '* text=auto eol=lf' && test "$(wc -l < .gitattributes | tr -d ' ')" = 1`
- [x] `test -z "$(git ls-files --eol | awk '$1!="i/lf" && $1!="i/-text" && $1!="i/none"')"`
- [x] `git check-attr text eol -- packages/monitor/skills/cockpit/bin/cockpit | grep -c -E ': (text: auto|eol: lf)$'` prints `2`.
- [x] `bash -c 't=$(mktemp -d) && git -c core.autocrlf=true checkout-index --prefix="$t/" packages/monitor/skills/cockpit/bin/cockpit && ! grep -q $'"'"'\r'"'"' "$t/packages/monitor/skills/cockpit/bin/cockpit"'` succeeds. `checkout-index` reads `.gitattributes` from the working tree. Measured in a throwaway clone: without the file the shim is written with 119 carriage returns, with it 0.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                  | 2–3 (below bar)                                                              | 4–5 (pass)                                                                                             |
| ----------------------- | ------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Correctness             | ×3     | File missing, wrong rule, or another file's content changed | Rule present but extra lines/rules, or a check stages or resets the index  | Exactly `* text=auto eol=lf`; index check lists nothing; shim reports `text: auto` and `eol: lf`; the index is never touched |
| Test coverage           | ×2     | No check run                                                | Content checked, but the `autocrlf=true` checkout simulation not run         | All four Verification commands run and pass              |
| Interface & readability | ×1     | Extra rules, comments, or per-path overrides with no caller | One redundant rule                                                           | One line, nothing else                                                                                 |
| Assumptions & docs      | ×1     | Claims about Windows checkout unverified                    | Simulation run but its result not reported | Simulation evidence reported; any unexpected renormalized path reported, not fixed                     |

## Out of scope

- The CI step that asserts no `\r` in the shim on a Windows runner — Deferred. Reason: it belongs to the CI workflow, written separately.
- Renormalizing or editing any existing file — Deferred. Reason: the index is already all LF, so no edit is needed; an unexpected change is a finding to report.
- Changing the shim `packages/monitor/skills/cockpit/bin/cockpit` — Deferred. Reason: the shim is unchanged in this leg.
