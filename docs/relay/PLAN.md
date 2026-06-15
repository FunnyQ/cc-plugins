# relay — cross-harness task delegation plugin

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-06-15

## Overview

A third plugin for the `cc-plugins` (q-lab-marketplace) repo: **`relay`**, a single portable skill that lets an agent in any harness (Claude Code, Codex, OpenCode) delegate a task **out** to another harness's CLI — then capture the output, smart-apply when safe, and report back.

## Goals

- One skill, `/relay <backend> <mode> <task>`, that delegates to `codex`, `opencode`, or `claude` CLIs.
- Three modes — `delegate` (free task), `review` (code review, report-only), `image` (codex-only) — gated by a per-backend capability table.
- A clean two-layer adapter (backend-agnostic mode layer + per-harness backend layer) so adding a fourth harness is one new backend file plus a one-line entry in the `BACKENDS` registry — no changes to core types or the entry-point dispatch.
- A full functional **superset** of the existing `odin-codex` skill, so `odin-codex` can be retired once `relay` is stable.

## Non-goals

- **No image on opencode/claude** — their CLIs have no image generation; `/relay <non-codex> image` fails fast.
- **No install automation** — Claude/Codex install via the marketplace; OpenCode reads `~/.claude/skills/`, documented as a one-line symlink. No install script/skill.
- **No CI integration tests** — the integration smoke spawns real CLIs (needs auth, non-deterministic); it runs locally only, behind an env flag.
- **No `opencode serve` + SDK path** — first cut scrapes CLI stdout; the server/SDK route is a later fallback only if stdout proves unreliable.
- **No migration of `odin-codex`** — `relay` ships net-new and coexists; Q retires `odin-codex` manually later.
- **No config UI** — model defaults are code constants; the only runtime override is a `--model` flag and an optional JSON config file.

## Context

`cc-plugins` already ships `monitor` and `dispatch`. The `odin-codex` skill (in a different repo, `odin-cc-plugin`) wraps the `codex` CLI with `review`/`delegate`/`image` subcommands, context collection, smart-apply, and report formats — but it is codex-only and hardcodes the backend. `relay` generalizes that proven shape into a multi-backend adapter living in this repo.

Ground truth verified on Q's machine: `codex`, `opencode` (1.17.6), and `claude` CLIs are all installed; OpenCode natively reads `~/.claude/skills/` and uses the identical `SKILL.md` frontmatter contract, so the skill body is portable across all three harnesses. The differences are in distribution (marketplace vs symlink) and per-CLI invocation, both captured in `_context/cli-reference.md`.

## Requirements

### MVP

1. **Capability-gated dispatch** — `relay <backend> <mode>` rejects unsupported (backend, mode) pairs (e.g. `opencode image`) with a clear non-zero error before any CLI runs.
   - Acceptance: gate is a pure function over the backend registry; unit-tested for every cell of the matrix.
2. **Two-layer adapter** — backend-agnostic mode layer (`relay-prompt.ts`, `context-collector.ts`) + per-harness `Backend` implementations (`invoke`/`parseOutput`/`supports`/`strategy`).
   - Acceptance: `relay.ts` never references a CLI name; backends never build cross-backend prompts.
3. **delegate (all three)** — build a canonical prompt, run the backend in a write-capable mode, return result.
   - Acceptance: `/relay codex|opencode|claude delegate "<task>"` returns the backend's result; codex path reproduces odin-codex behaviour.
4. **review (native + emulated)** — codex/claude use native review; opencode emulates via a read-only review prompt; codex custom-file scope degrades to a prompt.
   - Acceptance: codex review uses `codex review --uncommitted/--base/--commit`; claude uses `claude -p "/code-review …"`; opencode uses a review prompt; all return report text without mutating source by default.
5. **image (codex-only)** — port odin-codex image: generate via gpt-image-2, locate the PNG, copy to `--out` with timestamp suffix.
   - Acceptance: `/relay codex image "<prompt>" --out <path>` saves the file; other backends fail fast.
6. **Output contract** — every run writes full backend output to `/tmp/relay/<ts>/last.md` and prints it to stdout.
   - Acceptance: temp file exists and equals stdout for a successful run.
7. **Model resolution** — precedence `--model` flag > config file > built-in constants; codex/claude unset; opencode delegate `opencode-go/kimi-k2.7-code`, review `opencode-go/qwen3.7-max`.
   - Acceptance: unit-tested precedence; opencode invocation carries the resolved `-m provider/model`.
8. **Packaging + distribution** — `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` at `0.1.0`; `relay` registered in both marketplace registries; SKILL.md documents the opencode symlink; CHANGELOG + CLAUDE.md updated.
   - Acceptance: the three version surfaces agree at `0.1.0` (Claude `plugin.json`, Codex `plugin.json`, `SKILL.md` frontmatter — relay's marketplace entries are not per-plugin versioned); both registries list `relay`. (Cross-surface agreement is verified at final review, which depends on both the packaging and SKILL tasks.)
9. **Per-backend alias commands** — `/codex`, `/opencode`, `/claude` slash commands that fix the backend and defer to the relay skill (Claude-side convenience; namespaced `/relay:codex` etc., bare names resolve per Claude Code's collision rules).
   - Acceptance: three thin command files exist, each routes to the skill with its backend fixed and duplicates no orchestration logic.

### Later

- **Richer config schema** — the v1 config read is a flat `{ models: { <backend>: { <mode>: "provider/model" } } }`; per-project overrides, model aliases, and a config-write helper are deferred (saving `--model` is agent-driven in v1).
- **opencode read-only review agent** — a shipped `--agent` with `edit/bash: deny` for a hard read-only guarantee; v1 relies on the review prompt.
- **gemini / fourth backend** — the registry is built to accept it, but not implemented now.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile step, no external npm deps (matches the repo).
- **Storage**: temp run dirs under `/tmp/relay/`; optional config at `~/.config/q-lab/cc-plugins/relay/config.json`.
- **Deployment**: local plugin; Claude/Codex via marketplace, OpenCode via `~/.claude/skills/` symlink.
- **Conventions**: `type` over `interface`; pure exported functions for unit testing; see `_context/shared.md`.

## Architecture

Two layers + a strategy axis.

- **Mode layer (backend-agnostic)**: context collection + canonical intent/prompt building + smart-apply policy + report format. `relay-prompt.ts`, `context-collector.ts`.
- **Backend layer (per-harness)**: `invoke()` + `parseOutput()` + `supports` table + `strategy()`. `backends/{codex,opencode,claude}.ts`, registered in `backends/index.ts`.
- **strategy ∈ {native, prompt}**: a backend either runs its own native command (gathers its own git context, ignores the built prompt) or consumes the built prompt file. `relay-prompt.ts` runs only when strategy = prompt.

```
relay <backend> <mode> [args]
        │
   relay.ts ── capabilityGate(backend, mode) ── backend.strategy(mode)
        │                                          │
        │                          ┌── native ─────┴── backend.invoke(native args)
        │                          └── prompt ── relay-prompt.ts → promptFile → backend.invoke(--prompt-file)
        │                                          (context-collector.ts feeds the prompt)
        └── capture stdout → /tmp/relay/<ts>/last.md  +  print to stdout
```

### Capability matrix

| Mode | codex | opencode | claude |
|---|---|---|---|
| delegate | ✓ prompt | ✓ prompt | ✓ prompt |
| review | ✓ native (custom-file scope → prompt) | ⚠ emulated → prompt | ✓ native |
| image | ✓ | ✗ | ✗ |

## Bucketing

- **Strategy**: by layer.
- **Why**: the backend-agnostic core has no harness dependency and can be built + tested first; backends depend only on core types; packaging depends on a working entry point. Clean dependency staircase, each layer independently testable.

### Buckets

- **`core/`** — backend-agnostic layer (types, shared utils, context collector, prompt builder). Starts first; ends when the mode layer is unit-tested.
- **`backends/`** — per-harness adapters + the relay entry point. Starts after `core/01` (types). Ends when `relay.ts` dispatches through all three backends.
- **`package/`** — skill packaging, manifests, marketplace registration, repo docs. Starts after the entry point exists. Ends with the final review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| core | 01 | types-and-shared | todo | > 4.0 | — |
| core | 02 | context-collector | todo | > 4.0 | — |
| core | 03 | relay-prompt-builder | todo | > 4.0 | core/01, core/02 |
| backends | 01 | capability-gate | todo | > 4.0 | core/01 |
| backends | 02 | codex-backend | todo | > 4.0 | core/01 |
| backends | 03 | opencode-backend | todo | > 4.0 | core/01 |
| backends | 04 | claude-backend | todo | > 4.0 | core/01 |
| backends | 05 | relay-entry | todo | > 4.0 | backends/01, backends/02, backends/03, backends/04, core/03 |
| package | 01 | skill-md-and-references | todo | > 4.0 | backends/05 |
| package | 02 | manifests-and-marketplace | todo | > 4.0 | backends/05 |
| package | 03 | changelog-and-repo-docs | todo | > 4.0 | package/02 |
| package | 04 | backend-alias-commands | todo | > 4.0 | package/01 |
| package | 99 | final-review | todo | > 4.0 | core/01, core/02, core/03, backends/01, backends/02, backends/03, backends/04, backends/05, package/01, package/02, package/03, package/04 |

## Cross-bucket dependencies

```
core/01 ─┬─→ core/03 ──────────────────────────────┐
core/02 ─┘                                          │
core/01 ─┬→ backends/01 ─┐                          │
         ├→ backends/02 ─┤                          │
         ├→ backends/03 ─┼→ backends/05 ─┬→ package/01 → package/04 ─┐
         └→ backends/04 ─┘               └→ package/02 → package/03 ──┤
                                                                      └→ package/99 (final review, depends on all)
```

backends/01 (capability gate) imports no concrete backend, so it is independent of 02–04; the concrete `BACKENDS` registry is assembled at backends/05. The graph is acyclic.

## Open questions

None blocking. All interview dimensions resolved.

## Known gaps

- opencode review read-only guarantee is prompt-based, not enforced (hard read-only agent deferred — see Later).
- opencode `--format json` may exit before the final event (upstream bug #26855); mitigated by a formatted-stdout fallback in the opencode backend, but not a guaranteed fix.

## References

- `odin-codex` skill (port source): `/Users/funnyq/Projects/odin/odin-cc-plugin/packages/odin-codex`
- OpenCode docs: https://opencode.ai/docs/skills/ , /plugins/ , /cli/
- opencode JSON-mode bug: https://github.com/sst/opencode/issues/26855
