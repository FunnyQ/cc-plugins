# BACKENDS-01: Capability gate

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: core/01
> **Blocks**: backends/05
> **Status**: todo

## Goal

Provide the pure capability gate and a registry-lookup helper that the relay entry point uses to reject unsupported (backend, mode) pairs and resolve a backend by name — **without importing any concrete backend**, so the dependency graph stays acyclic.

## Files to create / modify

- `packages/relay/skills/relay/scripts/backends/gate.ts` (new) — `capabilityGate` + `getBackend` (both pure, operate on values passed in).
- `packages/relay/skills/relay/scripts/backends/gate.test.ts` (new) — gate + lookup tests using inline fake backends.

## Implementation notes

These helpers take the `Backend` type (from the foundation types module) and operate on values handed to them — they do **not** import `./codex`, `./opencode`, or `./claude`. The concrete `BACKENDS` map is assembled later at the entry point (which depends on all three backend files), so there is no cycle.

```ts
import type { Backend, Mode } from "../types";

// Look a backend up in a passed registry. undefined for unknown names.
export function getBackend(registry: Record<string, Backend>, name: string): Backend | undefined;

// Returns null if (backend, mode) is allowed; otherwise a human-readable error string.
export function capabilityGate(backend: Backend, mode: Mode): string | null;
// e.g. backend.supports.has(mode) ? null : `${mode} is not supported on ${backend.name}`
```

`capabilityGate` is the single source for the matrix decision — the entry point must call it, never re-check `supports` inline. `getBackend` returns `undefined` for an unknown name (caller turns that into a usage error listing valid names).

Tests construct small inline fake `Backend` objects (e.g. one with `supports = new Set(["delegate"])`) — they do not need the real backends, so this task is independently verifiable before any backend file exists.

## Acceptance criteria

- [ ] `gate.ts` exports `getBackend` and `capabilityGate`, both pure, neither importing a concrete backend file.
- [ ] `getBackend(map, "nope")` returns `undefined`; `getBackend(map, "x")` returns `map.x`.
- [ ] `capabilityGate` returns `null` when `backend.supports.has(mode)`, else a non-empty message naming the mode and backend.
- [ ] Tests pass using inline fake backends only (no dependency on the real three).

## Verification

- [ ] `bun test packages/relay/skills/relay/scripts/backends/gate.test.ts` passes.
- [ ] Tests assert: supported pair → `null`; unsupported pair → message; unknown name → `undefined`.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | gate wrong or imports a concrete backend (reintroduces cycle) | gate ok but lookup mishandles unknown | pure gate + lookup; no concrete imports; correct null/message/undefined |
| Test coverage | ×2 | no tests | one case | supported + unsupported + unknown-name, via fakes |
| Interface & readability | ×1 | gate logic duplicatable elsewhere | usable | single pure gate; registry passed in, not imported |
| Assumptions & docs | ×1 | acyclic rationale unstated | present | comment notes why concrete backends are not imported here |

## Out of scope

- Assembling the concrete `BACKENDS` registry — Deferred. Reason: it imports all three backend files and is built at the relay entry point to keep this module dependency-free and the graph acyclic.
- Defining `supports` per backend — Deferred. Reason: each backend declares its own `supports` set in its file; this task only consumes them.
