---
description: Toggle the scribe Stop-hook auto-log reminders at session / project / user scope.
---

Toggle the cockpit **scribe nudges**. These are the 💭 "spawn a fork to run /cockpit scribe" reminders. The Stop hook re-surfaces them at the end of each turn.

Run this exactly. Report the printed result back to me:

```bash
bun ~/.config/opencode/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS
```

**Actions** (default `status`): `on`, `off`, `toggle`, `clear` (drop this scope's opinion), `status`.

**Scopes** (`--scope`, default `session`):
- `session` — this session only (TTL-pruned file, one week idle).
- `project` — the whole project (keyed by git root) — persists in the global config.
- `user` — every project, every session (global default) — persists in the global config.

The most-specific **defined** scope wins: `session → project → user → (default: on)`. So a broad off can be re-enabled at a narrower scope. For example, run `nudge off --scope user` to mute everywhere. Then run `nudge on` (session scope) to hear them again in just this session. `status` prints the effective result plus the per-scope breakdown.
