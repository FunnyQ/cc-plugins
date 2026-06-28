---
description: Toggle the scribe Stop-hook auto-log reminders at session / project / user scope.
argument-hint: "[on|off|toggle|clear|status] [--scope session|project|user]"
---

Toggle the cockpit **scribe nudges** — the 💭 "spawn a fork to run /cockpit scribe" reminders the Stop hook re-surfaces at the end of each turn.

Run this exactly and report the printed result back to me:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS
```

**Actions** (default `status`): `on`, `off`, `toggle`, `clear` (drop this scope's opinion), `status`.

**Scopes** (`--scope`, default `session`):
- `session` — this session only (TTL-pruned file, one week idle).
- `project` — the whole project (keyed by git root) — persists in the global config.
- `user` — every project, every session (global default) — persists in the global config.

The most-specific **defined** scope wins: `session → project → user → (default: on)`. So a broad off can be re-enabled at a narrower scope — e.g. `nudge off --scope user` to mute everywhere, then `nudge on` (session) to hear them in just this session. `status` prints the effective result plus the per-scope breakdown.
