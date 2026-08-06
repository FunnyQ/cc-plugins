# ADR-0026: Plugins never import each other; shared logic is ported, not imported

- Status: Accepted
- Date: 2026-08-05

## Context

A grep across `packages/chronicle/skills/*/scripts/*.ts` for imports of
`packages/monitor` returned zero — verified against the actual codebase, not
assumed. This is a hard constraint, not a coincidence: each plugin installs
and versions independently, and the plugin cache path encodes the version
(e.g. `~/.claude/plugins/cache/q-lab-marketplace/chronicle/0.9.6/` next to
`.../monitor/3.22.0/`). Versions do not stay in sync, so a relative import
like `../../monitor/...` cannot resolve on a user's machine, and the target
plugin may not even be installed. Running inside the monorepo hides this
failure entirely — relative paths resolve fine there — meaning the bug only
surfaces once a user has a single plugin installed, not during development.

## Considered alternatives

- Import across plugin boundaries directly when convenient (e.g. chronicle's
  ADR skill importing cockpit's `log-root.ts` walk-up logic). Rejected:
  structurally impossible for end users, since cache paths carry per-plugin
  version numbers that never align, and the target plugin may be absent
  entirely.

## Decision

Shared logic between plugins must be **ported**, never imported: copy the
needed logic into the consuming plugin's own `shared/scripts/`, with a
comment naming the original file as the spec. This is exactly how the ADR
skill copied cockpit's `logRoot` walk-up and `STALE_MS` into
`packages/chronicle/shared/scripts/cockpit-trail.ts`.

## Consequences

Every cross-package design document must check this constraint before
proposing a dependency on another plugin's code — the ADR skill's own
original `PLAN.md` did not, and specified "use cockpit's log-root.ts
walk-up," a sentence that was literally impossible to implement as written.
The accepted cost of porting is that the two copies must be kept in sync by
hand; nothing in the tooling detects drift between them.

## Evidence

- **Zero cross-plugin imports exist in the codebase today, and the reason is
  structural, not stylistic** — chronicle's scripts import from monitor zero
  times; plugin cache paths encode independent version numbers
  (`chronicle/0.9.6/` vs `monitor/3.22.0/`) that never align, and a target
  plugin may not be installed at all. Shared logic is ported instead, with a
  comment pointing back to the original — as chronicle's ADR skill did for
  cockpit's `logRoot` walk-up and `STALE_MS`. This exact mistake was found in
  the ADR skill's own original `PLAN.md`, which specified reusing cockpit's
  file directly.
  Session `5c662721-58f3-4623-8885-b90c9675d007`, entry `72562506-d75a-4147-ad08-06d504087e80`, 2026-08-05.
