# SHIP-04: Delete TS, update docs, measure RSS

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/contracts.md`
> - `../_context/rubric.md`
>
> **Depends on**: ship/02, ship/03
> **Blocks**: review/01
> **Status**: todo

## Goal

The repo stops carrying the Bun cockpit implementation. Every doc tells humans and agents to run the Rust binary through the shim. The memory win that motivated the rewrite is measured and recorded.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/*.ts` (delete — every ported module except the keep-set below)
- `packages/monitor/skills/cockpit/scripts/*.test.ts` (delete — the unit tests of every deleted module)
- `packages/monitor/skills/cockpit/contract/launcher.ts` (modify) — with no TS left to launch, the default target becomes the locally built binary.
- `packages/monitor/skills/cockpit/contract/launcher.test.ts` (modify) — drop every case that runs a deleted TS script; find-session cases go through `command("cli", ["find-session", ...])`; assertions match the post-deletion mapping.
- `packages/monitor/skills/cockpit/SKILL.md` (modify) — CLI invocations go through the shim.
- `packages/monitor/skills/cockpit/references/{pilot,scribe,restart,opencode}.md` (modify) — the same sweep.
- `packages/monitor/commands/nudge.md` (modify) — `bun …/cockpit.ts nudge` → shim.
- `opencode/commands/nudge.md` (modify) — `bun ~/.config/opencode/skills/cockpit/scripts/cockpit.ts nudge` → `~/.config/opencode/skills/cockpit/bin/cockpit nudge`.
- `CLAUDE.md` (modify) — architecture tree, commands, cockpit constraints.
- `docs/cockpit-rust/rss.md` (new) — the measured RSS numbers.

## Implementation notes

### Deletion: the keep-set and the rule

Keep these files in `packages/monitor/skills/cockpit/scripts/`, plus every module they import, transitively:

- `cockpit-home.ts` — usage-dashboard's `atlas-server.ts` and `live.ts` import it.
- `http.ts` — `atlas-server.ts` imports it.
- `diagram-lint.ts` — the Rust CLI spawns `bun <plugin root>/skills/cockpit/scripts/diagram-lint.ts` with Mermaid source on stdin. It imports `../dashboard/dist/modules/diagram.js`, which is SPA code and is not touched here.
- Tests of kept modules, if any exist, stay.

For every other `.ts` in that dir, before deleting it, check that nothing outside the deletion set still imports it:

```sh
rg -n "cockpit/scripts/<name>|from \"\./<name>\"|from '\./<name>'" --glob '*.ts' --glob '!packages/monitor/skills/cockpit/scripts/**' .
```

Also run the same check inside the scripts dir restricted to kept files. A hit from a surviving file (usage-dashboard, install, opencode, chronicle, a kept module) means the module stays. Record it in the `## Known gaps` note of `docs/cockpit-rust/rss.md` under "kept TS", with the importer's name. `packages/monitor/skills/shared/scripts/` is shared with usage-dashboard: delete nothing there.

Expect roughly 8,000 lines of TS and about 9,000 lines of unit tests to go. The contract suite in `skills/cockpit/contract/` and the shim test in `skills/cockpit/bin/` stay permanently.

### Contract launcher after deletion

The launcher's TS branch has nothing left to launch. The new rule:

- `COCKPIT_BIN` set → unchanged.
- Unset → default to `<repo>/packages/monitor/cockpit-rs/target/release/cockpit`. If that file is missing, throw at import time with exactly: `contract suite: no binary — run cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml or set COCKPIT_BIN`.

  A silent skip is not allowed: a green suite that tested nothing is the failure mode this suite exists to prevent.
- Remove the TS script mapping entirely. Keep the exported `command()` / `underTest` signatures. `underTest` is always `"rust"` now; keep the export, because tests may branch on it.

`_context/contracts.md` §8 already describes this post-deletion default; the one-line comment in `launcher.ts` should say why there is no TS fallback.

### Launcher self-test after deletion

`launcher.test.ts` (group `harness: launcher`) currently runs `bun find-session.ts` for the three providers and asserts the TS mapping. After deletion:

- Every find-session case builds its argv with `command("cli", ["find-session", "--provider", <p>, <fixture project>])` and asserts the same stdout it asserted before.
- Mapping assertions: with `COCKPIT_BIN` set, `command("server", ["--port", "1"])` is `[COCKPIT_BIN, "server", "--port", "1"]`; with it unset, the first element is the absolute `<repo>/packages/monitor/cockpit-rs/target/release/cockpit`.
- The missing-binary error is asserted in a child `bun` process that imports `launcher.ts` with `COCKPIT_BIN` unset and a cwd/repo path where the binary is absent (or by pointing the resolved default at a temp dir via the same seam the launcher uses to find the repo root); it must exit non-zero with the exact message above.
- No assertion names a `.ts` script under `scripts/`.

### Doc sweep

Replace every runtime invocation, not the history:

| Old | New |
|---|---|
| `bun <plugin-root>/skills/cockpit/scripts/cockpit.ts <sub> …` | `<plugin-root>/skills/cockpit/bin/cockpit <sub> …` |
| `bun <plugin-root>/skills/cockpit/scripts/find-session.ts --provider …` | `<plugin-root>/skills/cockpit/bin/cockpit find-session --provider …` |
| `bun ${CACHE}/${v}/skills/cockpit/scripts/cockpit-server.ts --no-open` | `${CACHE}/${v}/skills/cockpit/bin/cockpit server --no-open` |
| `bun ~/.config/opencode/skills/cockpit/scripts/…ts` | `~/.config/opencode/skills/cockpit/bin/cockpit …` |

- Change nothing under `docs/` (past plans, ADRs) and nothing in `CHANGELOG.md` history. Those record what was true then.
- `restart.md` keeps its rule that you run the restart from the updated cache. Only the command changes.

### CLAUDE.md

- **Architecture tree** under `packages/monitor/skills/cockpit/`:
  - Replace the scripts listing with `bin/cockpit` (sh shim), the `contract/` suite, and `scripts/` showing only the kept TS files.
  - Add `packages/monitor/cockpit-rs/` (Rust crate: `server`, `channel`, CLI, and `hook` subcommands).
- **Commands**:
  - Replace `bun …/cockpit-server.ts` and `bun …/cockpit.ts …` with shim or binary forms.
  - Add `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`.
  - Add the contract-suite commands, with and without `COCKPIT_BIN`.
  - Keep `COCKPIT_HOME=/tmp/cockpit-dev … server --port 5999` as the dev-isolation example.
- **Cockpit constraints**: add a short block covering these facts:
  - The Rust binary is fetched by the shim from the `monitor-v<version>` GitHub release, as `cockpit-<triple>` plus `SHA256SUMS`, into `$XDG_DATA_HOME/q-lab/cockpit/bin/<version>/`.
  - `COCKPIT_BIN` overrides the fetch.
  - Hooks fail soft while the binary downloads.
  - `daemon.json.root` stays `<plugin root>/skills/cockpit/scripts`, so version-aware supersede works across a mixed fleet.
  - `cockpit-rs/Cargo.toml` is a monitor version file.
  - The release workflow must finish before users update, or the first session runs without hooks.
- **Hook parity table**: the monitor rows now name the shim `hook` subcommands.

Keep CLAUDE.md's existing style: dense, why-focused, no marketing.

### CHANGELOG

CLAUDE.md's release rules put CHANGELOG entries in the release step (`/chronicle:release` writes a per-plugin heading), so do **not** add an entry here.

### RSS measurement (`docs/cockpit-rust/rss.md`)

Measure on the executor's machine with the release build. Use a temp `COCKPIT_HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME`, a free port, and `COCKPIT_PLUGIN_ROOT=$PWD/packages/monitor`.

Use one fixed session id everywhere: `00000000-0000-4000-8000-000000000001`. It passes the channel's UUID check and the server's inbox session validation. Write the fixture Claude session/transcript for it (contract fixtures), and give the same id to the channel.

Drive steps 2–3 from one bun script (e.g. a temp `rss-probe.ts` outside the repo), never a shell pipeline: `$!` of a backgrounded pipeline is the subshell's pid, so `ps` would read the shell's RSS and `kill` would orphan the channel.

1. Start `cockpit server --port <p> --no-open`.
2. `const ch = Bun.spawn([bin, "channel"], { stdin: "pipe", stdout: "pipe", env: { ...env, CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000001" } })`. Send the MCP `initialize` request and `notifications/initialized` on `ch.stdin` and keep the pipe open. Poll the server until it reports a parked `/api/inbox` poll for that id (the contract suite's inbox-presence helper, i.e. the channel shows as live for that session in `/api/sessions`), with a 10 s timeout that fails the measurement loudly.
3. Read the channel RSS: `ps -o rss= -p ${ch.pid}`, in KB — `ch.pid` is the channel process itself. Take the max of 5 readings, 1 s apart. Then `ch.kill()`.
4. Load the dashboard: `curl` `/`, then every asset URL referenced by `index.html`. Open one `/api/transcript/stream` SSE against a fixture Claude transcript (use the contract fixtures), and keep it open.
5. Read the server RSS the same way. Take the max of 5 readings, 1 s apart.

Write `docs/cockpit-rust/rss.md`:
- A table of process, target, measured value, and pass/miss.
- The machine (`uname -sm`) and the date.
- The exact commands.
- A `## Known gaps` section, holding any kept-TS notes from the deletion step.

A miss is written down with its number and is not blocked on. The task still passes on Correctness when the measurement is honest. Reference numbers: the Bun channel measured about 55 MB and the Bun server 86 MB on 2026-09-30.

## Acceptance criteria

- [ ] Only the keep-set (`cockpit-home.ts`, `http.ts`, `diagram-lint.ts`, their transitive imports, and any module a surviving importer names in `docs/cockpit-rust/rss.md`) remains among `packages/monitor/skills/cockpit/scripts/*.ts`. Every deleted module's unit test is deleted with it.
- [ ] Nothing outside the deleted set imports a deleted module, so a whole-repo typecheck shows no new unresolved-import error.
- [ ] With `COCKPIT_BIN` unset, the contract suite runs against `target/release/cockpit`. With the binary absent, it fails loudly with the exact message above.
- [ ] No runtime `bun …/cockpit/scripts/*.ts` invocation remains in the cockpit skill docs, both `nudge.md` commands, or CLAUDE.md, except `diagram-lint.ts`, which the binary spawns.
- [ ] CLAUDE.md describes the crate, the shim, `COCKPIT_BIN`, the release assets, and the unchanged `daemon.json.root` rule.
- [ ] `docs/cockpit-rust/rss.md` records measured channel and server RSS against the 10 MB and 30 MB targets, with commands and machine.
- [ ] The full contract suite against the release binary is green, and so are the monitor and opencode test dirs.

## Verification

- [ ] `cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `COCKPIT_BIN=$PWD/packages/monitor/cockpit-rs/target/release/cockpit bun test packages/monitor/skills/cockpit/contract/`
- [ ] `bun test packages/monitor/skills/cockpit/contract/` passes (defaults to the built binary).
- [ ] `bun test packages/monitor/ opencode/`
- [ ] `cargo test --manifest-path packages/monitor/cockpit-rs/Cargo.toml`
- [ ] `bunx --bun tsc --noEmit | grep -E 'packages/monitor|opencode/'` prints nothing new versus the pre-change run. The executor saves the pre-change output to a temp file first and diffs against it.
- [ ] `! rg -n 'bun [^ ]*cockpit/scripts/(cockpit|cockpit-server|cockpit-channel|decision-log-start|scribe-nudge|find-session)\.ts' packages/monitor/skills/cockpit packages/monitor/commands opencode/commands CLAUDE.md`
- [ ] `test -f docs/cockpit-rust/rss.md && rg -q 'channel' docs/cockpit-rust/rss.md && rg -q 'server' docs/cockpit-rust/rss.md`

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Scale 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A module usage-dashboard, install, or opencode imports gets deleted, or the contract suite silently tests nothing | Deletion right but a doc still points at a deleted script, or the RSS numbers are missing | Keep-set exact, importer check done per module, docs swept, suite green against the binary, RSS honestly recorded |
| Test coverage | ×2 | Suites not run after deletion | Contract suite run, monitor/opencode dirs not | Contract, cargo, monitor, and opencode suites all green, plus a before/after typecheck diff |
| Interface & readability | ×1 | Launcher keeps a dead TS branch | Launcher changed but the error is vague | Launcher defaults cleanly, exact loud error, exports kept |
| Assumptions & docs | ×1 | CLAUDE.md untouched or describes Bun | Partially updated | CLAUDE.md tree, commands, constraints, and hook table all current; rss.md lists machine, commands, and gaps |

## Out of scope

- Cutting the monitor release or writing its CHANGELOG entry. Deferred: the owner runs `/chronicle:release` after the final review.
- Porting usage-dashboard or `diagram-lint.ts` to Rust. Deferred: both stay Bun by decision.
- Editing past plans under `docs/` or ADRs. They are historical records.
