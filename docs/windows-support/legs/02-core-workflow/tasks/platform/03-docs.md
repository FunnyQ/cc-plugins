# PLATFORM-03: Windows docs for the core plugins

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/windows.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: review/01
> **Status**: done

## Goal

A contributor reading `CLAUDE.md` knows where q-lab scratch goes on Windows, and a user reading `README.md`'s `## Windows` section knows which plugins work on native Windows after this leg and which do not yet.

## Files to create / modify

- `CLAUDE.md` (modify) — the scratch bullet under `## Code Conventions` gains its Windows clause.
- `README.md` (modify) — the `## Windows` section names what works now and what does not yet.

## Implementation notes

Docs only. Change no code, no test, no workflow file. Write in English, one instruction per sentence, condition before instruction, one term per thing.

### CLAUDE.md scratch bullet

The bullet today (under `## Code Conventions`, ~line 366) reads:

> Put scratch that outlives its process under `/tmp/q-lab/<plugin>/<skill>/`, or `/tmp/q-lab/<plugin>/` for a plugin with no skills. The `q-lab` segment keeps a third-party plugin of the same name out of our files. A path an agent writes with the Write tool must end in a `mktemp -d` leaf: Write refuses to overwrite a file it has not read, so a fixed path hands the next run the last run's file. Keep a `mkdtemp` scratch that the same process deletes in `os.tmpdir()`.

Insert one or two sentences right after the first sentence, carrying these facts and nothing more:

- On win32, root the same tree at `join(tmpdir(), "q-lab", <plugin>, …)`, because `/tmp/...` is drive-relative on Windows: two processes whose cwd sit on different drives resolve it to different directories.
- macOS and Linux keep `/tmp/q-lab` byte for byte.
- Each plugin keeps its own copy of the root function, with the platform as a parameter, because plugins import nothing from each other.

Suggested wording (adapt to fit, keep the facts):

> On win32, root that tree at `join(tmpdir(), "q-lab", <plugin>, …)` instead, because `/tmp/...` is drive-relative there; macOS and Linux keep `/tmp/q-lab`. Each plugin keeps its own copy of that root function, taking the platform as a parameter, since plugins import nothing from each other.

Leave the rest of the bullet unchanged. Do not touch any other `/tmp/q-lab` mention in `CLAUDE.md` (browsers, cockpit, …): those plugins belong to later legs.

### README `## Windows`

Read the whole section first (~line 138, before `## usage-dashboard`). Keep every sentence that is still true: the roadmap link, the supported runtimes, the WSL and Desktop-WSL notes, the `bun` on `PATH` requirement, the Git for Windows recommendation. Rewrite only what this leg makes false or incomplete.

The section after this leg must state:

1. **Works on native Windows**: chronicle, dispatch, guard and relay. Their test suites, and the OpenCode layer's (`opencode/`), pass in CI's blocking `required` job on windows-latest, and a `smoke` CI job runs commit, release (local mode), flightplan scaffold and lint, worktree create and land, and the comment sweep on all three OS.
2. **Not yet supported**: monitor (cockpit and the usage dashboard), herdr, browsers and runes. Name them as later roadmap legs.
3. **Git for Windows' `bash`** is needed for the OpenCode flightplan lint hook, which spawns `flightplan-lint.sh` through `bash`.
4. **WSL**: URL openers use `wslview` when it is installed, and fall back to `cmd.exe /c start "" <url>`.
5. **Scratch files** go under `%TEMP%\q-lab\<plugin>\` on native Windows (the `join(tmpdir(), "q-lab", …)` root), not `/tmp/q-lab`.

The current sentence "Codex and OpenCode on Windows are not supported." becomes partly false: the OpenCode layer's tests now pass on Windows, and relay's opencode backend no longer passes prompts in argv. Rewrite it to say exactly that, and keep the parts still unverified:

- The OpenCode layer's flightplan lint and comment guard hooks run on Windows. Its cockpit hooks do not, because no Windows cockpit binary ships.
- Codex and OpenCode on Windows are otherwise not verified on a real Windows machine.

Also rewrite "Other features are not yet verified on Windows." so it agrees with points 1 and 2.

Do not claim anything a real Windows PC run would be needed to prove (the agent-driven flows such as `/chronicle:commit`, `/autopilot`, the guard reviewer). Those are owed human checks; say "verified in CI" only for what CI runs.

## Acceptance criteria

- [x] `grep -n 'join(tmpdir(), "q-lab"' CLAUDE.md` prints one line, inside the `## Code Conventions` scratch bullet.
- [x] `grep -n "drive-relative" CLAUDE.md` prints a line in that same bullet.
- [x] The README `## Windows` section names chronicle, dispatch, guard and relay as working, and monitor, herdr, browsers and runes as not yet supported: `awk '/^## Windows/,/^## usage-dashboard/' README.md | grep -c -E "chronicle|dispatch|guard|relay|monitor|herdr|browsers|runes"` prints a number ≥ 1, and each of the eight names appears in that range (check each with `grep -q`).
- [x] The README `## Windows` section mentions `wslview`, `bash` for the OpenCode lint hook, and the `q-lab` scratch location on Windows.
- [x] The README `## Windows` section still links `docs/windows-support/WAYPOINTS.md` and still lists both supported runtimes.
- [x] No claim in either file says a flow is verified on a real Windows machine.

## Verification

- [x] `grep -n 'join(tmpdir(), "q-lab"' CLAUDE.md` hits the scratch bullet.
- [x] `for p in chronicle dispatch guard relay monitor herdr browsers runes wslview WAYPOINTS.md; do awk '/^## Windows/,/^## usage-dashboard/' README.md | grep -q "$p" || echo "missing $p"; done` prints nothing.
- [x] `git diff --name-only -- CLAUDE.md README.md` lists both `CLAUDE.md` and `README.md`.
- [x] `git diff --stat -- CLAUDE.md README.md` shows only small edits (the scratch bullet and the `## Windows` section), not a whole-file reformat.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                                                                                                              | 2–3 (below bar)                                                                                                                  | 4–5 (pass)                                                                                                                       |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A claim contradicts the code or CI after this leg (e.g. says monitor works, or keeps "Codex and OpenCode … not supported" unqualified, or gives a Windows root other than `join(tmpdir(), "q-lab", …)`) | Claims are true but one required point (works / not yet / bash / WSL / scratch) is missing, or a still-true sentence was deleted | Every claim matches the code and CI after the leg; all five README points and the CLAUDE.md clause present; still-true text kept |
| Verifiability           | ×2     | Claims are vague ("mostly works") and no reader could check them                                                                                                                                        | Claims are checkable but "verified" is used for flows only a real PC could prove                                                 | Each claim names what proves it (CI `required`, `smoke` job) or is marked unverified; nothing overclaims                         |
| Interface & readability | ×1     | Rewrites unrelated paragraphs or reformats the whole file                                                                                                                                               | Correct but wordy, or breaks house style (several instructions per sentence)                                                     | Minimal diff; one instruction per sentence, condition first, one term per thing                                                  |
| Assumptions & docs      | ×1     | States Windows facts not in `windows.md` or the code                                                                                                                                                    | Facts right but the drive-relative reason is missing                                                                             | The drive-relative reason and the no-cross-plugin-import reason are both given in one line each                                  |

## Out of scope

- Other `/tmp/q-lab` mentions in `CLAUDE.md` (browsers, cockpit, monitor) — Deferred. Reason: those plugins are Windows work for later legs.
- Agent prompts that name `/tmp/q-lab` (lawspeaker, annalist) — Deferred. Reason: where Claude Code's Write tool puts that path on native Windows is unknown until a human check on a Windows PC.
- `CHANGELOG.md` entries and version bumps — Deferred. Reason: this leg releases nothing.
