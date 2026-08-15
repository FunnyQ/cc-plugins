# RUNTIME-02: OpenCode installer

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: runtime/01, assets/01, assets/02
> **Blocks**: skills/01, skills/02, skills/03, skills/04, skills/05, skills/06
> **Status**: done

## Goal

A user with this repo checked out runs one command and OpenCode discovers every skill, the plugin module, the 13 chronicle agents, and the 2 monitor commands — with `subagent_depth` raised so the orchestrators can spawn their children.

## Files to create / modify

- `opencode/install.ts` (new) — the installer: target table, link classification, the four CLI modes.
- `opencode/install.test.ts` (new) — unit tests over the pure layer.

Nothing else. No file under `packages/` is touched by this task.

## Implementation notes

Plain Bun script. Entry guarded by `if (import.meta.main)`. No harness dependency — it runs from any shell, in any harness, or none. No external dependencies.

### Blocking runtime facts

Four facts in `../_context/runtime-facts.md` gate this task. **S7 is the hard blocker**: if the runtime does not resolve an entry symlink to its realpath, every skill that imports out of its own directory breaks and the whole symlink model has to be replaced with copies or per-skill re-export shims — which is a different task, not an adjustment to this one.

| Fact | What it decides here |
|---|---|
| **S7** | Whether symlinked skills work at all. `UNRESOLVED` → set `> **Status**: blocked` and stop. |
| **S6** | Whether OpenCode discovers a symlinked skill directory. `UNRESOLVED` → blocked. |
| **S8** | The plugin target's shape. Realpath → a plain symlink. Link path → the installer must instead **generate** a one-line file `export * from "<abs repo>/opencode/plugin.ts"` at the plugin target, and the target's `kind` becomes a generated file rather than a symlink. `UNRESOLVED` → blocked. |
| **S14** | The `subagent_depth` default and whether the value is read live or at startup. Affects only the wording of the report (whether to tell the user to restart), not the write itself. `UNRESOLVED` → still implement the write; report the restart advice as unknown rather than guessing. |

Do not infer any of these from documentation. Blocking is the correct outcome.

### The target table — pure

```ts
export type TargetKind = "symlink" | "config";

export type Target = {
  kind: TargetKind;
  label: string;      // human-readable, e.g. "skill: cockpit"
  source: string;     // absolute path inside this repo
  installed: string;  // absolute path under ~/.config/opencode/
};

export function buildTargets(repoRoot: string, home: string): Target[];
```

`buildTargets` takes `home` as a parameter rather than reading `homedir()` internally — that is what makes the tests runnable against a temp directory without touching the real one.

It produces exactly 32 entries — 31 symlinks plus 1 config edit:

| Count | Source | Installed | Kind |
|---|---|---|---|
| 15 | `packages/*/skills/<name>` | `<home>/.config/opencode/skills/<name>` | symlink (directory) |
| 1 | `opencode/plugin.ts` | `<home>/.config/opencode/plugin/q-lab.ts` | symlink |
| 13 | `opencode/agents/<name>.md` | `<home>/.config/opencode/agents/<name>.md` | symlink |
| 2 | `opencode/commands/<name>.md` | `<home>/.config/opencode/commands/<name>.md` | symlink |
| 1 | — | `<home>/.config/opencode/opencode.json` | config |

**Skill enumeration is by `SKILL.md` presence.** Walk `packages/*/skills/*` and keep only directories containing a `SKILL.md`. A bare glob returns 16 because `packages/monitor/skills/shared/` has no `SKILL.md` — it holds scripts the other monitor skills import, and symlinking it as a skill would surface a phantom skill in OpenCode. Excluding it is an explicit acceptance criterion, not an incidental detail. The expected 15 names are listed in `../_context/repo-state.md`.

The agent and command counts come from what is on disk under `opencode/agents/` and `opencode/commands/`, not from a hardcoded list — but the tests assert 13 and 2, so a miscount fails loudly instead of silently installing nine agents.

### Classifying what is already at a target — pure

```ts
export type LinkState =
  | "ok"        // symlink resolving to the expected source
  | "missing"   // nothing there
  | "stale"     // symlink into this repo, wrong source
  | "broken"    // symlink whose target does not exist
  | "foreign";  // a real file/dir, or a symlink pointing outside this repo

export function classifyLink(
  probe: { exists: boolean; isSymlink: boolean; resolved: string | null },
  expectedSource: string,
  repoRoot: string,
): LinkState;
```

Keep the `lstat`/`readlink` calls in a thin impure probe and pass the result in. That is what makes every state testable without constructing broken symlinks on disk.

`foreign` is the safety state. `--apply` must **never** overwrite it.

### The `subagent_depth` decision — pure

Mirror the shape of chronicle's existing raise-only decision (`packages/chronicle/skills/install/scripts/spawn-depth-decision.ts` — read it, do not import from it; this build adds no dependency on `packages/`):

```ts
export const REQUIRED_SUBAGENT_DEPTH = 2;

export type DepthDecision = {
  action: "ok" | "write" | "unparsable";
  value: number;
  reason: string;
};

export function decideSubagentDepth(config: unknown): DepthDecision;
```

Behavior, cell by cell:

| `subagent_depth` in the config | `action` | `value` |
|---|---|---|
| key absent | `write` | 2 |
| `1` (or any number below 2) | `write` | 2 |
| `2` | `ok` | 2 |
| `5` (any number above 2) | `ok` | 5 — **leave it alone** |
| not a number | `write` | 2 |
| the file is not a JSON object | `unparsable` | 2 |

**Only ever raise.** A larger value belongs to the user or to another tool. On `unparsable`, refuse to write and print the manual edit instead:

```
Add this to ~/.config/opencode/opencode.json by hand:
  "subagent_depth": 2
```

Why 2: chronicle's deepest chain is skill → orchestrator → child (the commit flow spawns an orchestrator, which spawns a changeset reader and a commit runner). Below 2 the orchestrator simply stops, with no error naming the config — it reads as a plugin bug.

When writing, preserve every other key in the file. Round-trip through `JSON.parse` / `JSON.stringify(obj, null, 2)` and write a trailing newline; do not attempt to preserve comments or exotic formatting, but never drop a key.

### CLI modes

```
bun opencode/install.ts --check      # default when no flag is given
bun opencode/install.ts --dry-run
bun opencode/install.ts --apply
bun opencode/install.ts --unlink
```

- **`--check`** — one line per target with `✓` (correct), `✗` (missing, stale, broken, or a config value below 2), or `○` (present but foreign — needs a human). Exit `0` only when every target is `✓`. Otherwise exit non-zero.

  `--check` must also **warn about the legacy relay symlink**: if `<home>/.claude/skills/relay` exists, print a warning. OpenCode scans `~/.claude/skills/` as well as `~/.config/opencode/skills/`, so leaving that link in place means two skills named `relay` after installing. The warning names the path and says to remove it. It is a warning, not a failure — it does not by itself change the exit code.

- **`--dry-run`** — print exactly what `--apply` would do, touch nothing. A user must be able to diff `--dry-run` output against what `--apply` reports.

- **`--apply`** — `mkdir -p` each parent directory, then per target:
  - `missing` → create the symlink.
  - `stale` or `broken` → replace it.
  - `ok` → leave it, report it.
  - `foreign` → **report, skip, and exit non-zero at the end.** Never unlink, never overwrite, never back up and replace. A real file at a target path is a human's decision.

  Then apply the depth decision. Idempotent: a second `--apply` on a clean install performs no writes and exits 0.

- **`--unlink`** — remove only symlinks whose resolved target points into this repo. Leave `foreign` entries alone. **Leave `subagent_depth` alone**: the value may predate this install, another tool may rely on it, and lowering it would break a working setup. Say so in the output so the user is not surprised by the leftover.

### Scope — the one rule that outranks the others

The installer writes **only** inside `<home>/.config/opencode/`. Never `~/.claude/settings.json`, never anything under `~/.codex/`. Claude Code and Codex must behave identically after this build. Writing outside that directory is a Correctness-0 failure regardless of how well the rest works.

### Tests

`opencode/install.test.ts`, pure layer only — no real OpenCode process, no writes to the real `$HOME`. Build a temp directory and pass it as `home`.

- `buildTargets` returns exactly 15 skill symlinks, 1 plugin, 13 agents, 2 commands, 1 config entry.
- `buildTargets` excludes `packages/monitor/skills/shared` — assert the absence explicitly by name, not just by count.
- Every `installed` path lands under `<home>/.config/opencode/`; assert no path escapes it.
- `classifyLink` across all five states.
- `decideSubagentDepth` across all six cells in the table above.
- Plan building: `--apply` on a clean home creates everything; on an already-correct home creates nothing; a `foreign` entry produces a skip and a non-zero result.

## Acceptance criteria

- [x] `opencode/install.ts` exists, runs under `bun`, and supports `--check`, `--dry-run`, `--apply`, `--unlink`.
- [x] `buildTargets` is pure, takes `(repoRoot, home)`, and returns exactly 32 targets — 31 symlinks (15 skills + 1 plugin + 13 agents + 2 commands) plus 1 config edit.
- [x] Skill enumeration filters on `SKILL.md`; `packages/monitor/skills/shared` is not installed.
- [x] `--apply` never overwrites a foreign file or a symlink pointing outside this repo — it reports, skips, and exits non-zero.
- [x] `subagent_depth` is raised to 2 only when below it, every other key in the config survives, and an unparseable config prints the manual edit instead of writing.
- [x] `--unlink` removes only repo-owned symlinks and explicitly leaves `subagent_depth` in place.
- [x] `--check` warns when a legacy `~/.claude/skills/relay` symlink is present.
- [x] No path outside `~/.config/opencode/` is written, and no file under `packages/` is modified.

## Verification

- [x] `bun test opencode/install.test.ts` passes.
- [x] `bun opencode/install.ts --check` runs against a sandbox home and prints a per-target report.
- [x] Sandboxed full cycle: `HOME=/tmp/install-home bun opencode/install.ts --check` (expect non-zero, all missing) → `--apply` (expect exit 0) → `--check` (expect exit 0) → `--apply` again (expect exit 0, no writes) → `--unlink` → `--check` (expect non-zero again).
- [x] Foreign-file run: create a real file at `/tmp/install-home/.config/opencode/agents/watcher.md`, run `--apply`, confirm the file is byte-identical afterwards and the command exited non-zero.
- [x] Legacy-symlink run: create `/tmp/install-home/.claude/skills/relay`, run `--check`, confirm the warning names that path.
- [x] Depth runs: with `{"subagent_depth": 5, "permission": "allow"}` confirm `--apply` leaves the file byte-identical; with `{"theme": "x"}` confirm `subagent_depth: 2` is added and `theme` survives; with `not json` confirm nothing is written and the manual-edit hint prints.
- [x] `bun test packages/` still passes — the existing Claude Code and Codex suites are unaffected.
- [x] Run `git status --short -- opencode/install.ts opencode/install.test.ts docs/opencode-compat/tasks/runtime/02-installer.md` and confirm those paths are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Wrong target count, `shared` installed as a skill, or anything written outside `~/.config/opencode/` | The four modes work on a clean home, but a foreign file gets overwritten or the depth write drops a key | All 32 targets correct, foreign entries skipped with a non-zero exit, depth raised only when below 2 with every other key intact |
| Test coverage | ×2 | No tests, or tests that touch the real `$HOME` | Happy-path enumeration only | Target counts and the `shared` exclusion, all five link states, all six depth cells, and the foreign-skip path |
| Interface & readability | ×1 | `lstat` calls buried inside the "pure" functions; home read from the environment internally | Pure/impure split exists but `home` is not injectable, so tests need the real filesystem | `buildTargets`/`classifyLink`/`decideSubagentDepth` pure with injected inputs, `type` over `interface`, thin impure probe and runner |
| Assumptions & docs | ×1 | Guesses a blocking runtime fact instead of blocking | Blocks correctly but does not say which fact stopped it | Blocking facts cited by name; the `--unlink` leaves-depth-alone decision and the never-overwrite-foreign rule stated where a reader hits them |

## Out of scope

- Any change to the shell hooks, `plugin.json` manifests, agent definitions under `packages/`, or any `.ts` under `packages/`. Deferred permanently. Reason: Claude Code and Codex must behave identically after this build; the installer only creates links and one config key.
- Writing `~/.claude/settings.json` or anything under `~/.codex/`. Deferred permanently. Reason: same — those are other harnesses' configuration.
- npm packaging of the installer. Deferred. Reason: v1 installs locally from a checkout; packaging needs a versioning decision that has not been made.
- Auto-starting or auto-discovering the OpenCode TUI server. Deferred. Reason: unrelated to installation; it belongs to the cockpit send path.
