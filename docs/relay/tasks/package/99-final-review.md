# PACKAGE-99: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/cli-reference.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01, core/02, core/03, backends/01, backends/02, backends/03, backends/04, backends/05, package/01, package/02, package/03, package/04
> **Status**: todo
> **Final review**: true

## Goal

Holistic gate over the whole `relay` package: the layers compose, the capability matrix is honored end-to-end, relay is a true superset of odin-codex, packaging/versions are consistent, and the PLAN goal is met.

## Files to create / modify

- None by default. This task reviews; it only edits to fix integration defects it finds (and re-runs the relevant task's verification after).

## Implementation notes

Check the seams, not individual task internals (those passed their own rubrics):

### Integration / does it compose
- `relay.ts` dispatches purely through `getBackend` + `capabilityGate` + `b.strategy`/`b.invoke` — no `if (backend === ...)` branching anywhere.
- The prompt-text seam settled in the opencode/claude backend tasks is actually consistent in `InvokeOpts` and consumed correctly in `relay.ts`.
- The output contract (full stdout + `/tmp/relay/<ts>/last.md`) holds for every backend path, including codex `-o lastfile` and image (saved path printed).
- `bun test packages/relay/skills/relay/scripts/` passes as a whole suite (not just per-file).

### Capability matrix end-to-end
- Every hole fails fast before spawn: `/relay opencode image` and `/relay claude image` exit non-zero with the gate message.
- Every supported cell routes to the right strategy (codex/claude review = native; opencode review + all delegate = prompt; codex custom-file review = prompt).

### Superset-of-odin-codex
- delegate, review (incl. native flags), and image all reproduce odin-codex behaviour through the codex backend — nothing from odin-codex's three subcommands is lost (so odin-codex can be retired later).

### Packaging & consistency
- The three version surfaces agree at `0.1.0`: Claude `plugin.json`, Codex `plugin.json`, and `SKILL.md` frontmatter (relay's marketplace entries are not per-plugin versioned).
- `relay` is in both marketplace registries; descriptions consistent across manifests, registries, SKILL.md, CHANGELOG, CLAUDE.md.
- SKILL.md frontmatter is portable (the same file works under Claude/Codex/OpenCode); the opencode symlink path matches the real skill location.

### Meets the PLAN goal
- A reader of the shipped package can run `/relay <backend> <mode>` for every supported cell and get the documented behaviour.
- The three alias commands (`/codex`, `/opencode`, `/claude`) exist, route to the relay skill with their backend fixed, and add no behaviour beyond `/relay <backend>` (no duplicated gate/strategy/report logic).

## Acceptance criteria

- [ ] Full test suite passes: `bun test packages/relay/skills/relay/scripts/`.
- [ ] No backend-name branching in `relay.ts`; gate runs before any spawn.
- [ ] All matrix holes fail fast; all supported cells route to the correct strategy.
- [ ] codex backend covers delegate + review (native + custom-file fallback) + image (odin-codex superset).
- [ ] Alias commands `/codex`, `/opencode`, `/claude` exist and defer to the relay skill with their backend fixed.
- [ ] The three version surfaces (Claude `plugin.json`, Codex `plugin.json`, `SKILL.md` frontmatter) all read `0.1.0`; relay present in both registries; descriptions consistent across all docs/manifests.
- [ ] Any integration defect found is fixed and the affected task's verification re-run.

## Verification

- [ ] `bun test packages/relay/skills/relay/scripts/` exits 0.
- [ ] `grep -rn 'backend === ' packages/relay/skills/relay/scripts/relay.ts` returns nothing.
- [ ] Manual smoke (local, optional): `RELAY_INTEGRATION=1 bun test …` and a real `/relay codex review` / `/relay opencode delegate` / `/relay codex image`.
- [ ] JSON validity + registry-presence checks from the packaging task re-pass.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. This rubric scores **integration**, not individual tasks.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration / composes | ×3 | layers don't wire; suite fails | composes but a seam (prompt-text/output) leaks | clean two-layer composition; suite green; no name branching |
| Meets the PLAN goal | ×2 | core modes unusable end-to-end | works but a cell/mode missing | every supported cell runnable as documented; odin-codex superset intact |
| Consistency | ×1 | versions/registries/docs disagree | minor drift | versions, registries, descriptions all aligned |
| No regressions | ×1 | breaks repo conventions/other plugins | minor | additive only; monitor/dispatch untouched; repo conventions held |

## Out of scope

- Implementing deferred "Later" items (config schema, read-only opencode agent, gemini backend) — Deferred. Reason: out of v1 scope per PLAN Non-goals.
- Retiring odin-codex — Deferred. Reason: Q does this manually after relay stabilizes in real use.
