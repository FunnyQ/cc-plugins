---
description: Switch the cockpit scribe (automatic decision logging) on or off at session / project / user scope.
argument-hint: "[on|off|toggle|clear|status] [--scope session|project|user]"
---

Switch the cockpit **scribe** on or off. When it is on, the agent distills each logical chunk of work into the cockpit decision log after a turn: on Claude Code a headless `claude -p` scribe runs at Stop, and on Codex and OpenCode the session gets scribe guidance and a Stop reminder. When it is off, nothing is logged automatically, a scribe fork already spawned stops at its prep step, and the cockpit daemon keeps running. A manual `/cockpit scribe` always runs.

Run this exactly. Report the printed result back to me:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/cockpit nudge $ARGUMENTS
```

**Actions** (default `status`): `on`, `off`, `toggle`, `clear` (drop this scope's opinion), `status`.

**Scopes** (`--scope`, default `session`):

- `session` — this session only (TTL-pruned file, one week idle).
- `project` — the whole project (keyed by git root) — persists in the global config.
- `user` — every project, every session — persists in the global config. The cockpit dashboard's **Scribe on/off** switch writes this scope.

The most-specific **defined** scope wins: `session → project → user → (default: off)`. For example, run `scribe on --scope project` to log one repo everywhere, or `scribe off` to silence just this session while the dashboard switch is on. `status` prints the effective result plus the per-scope breakdown. A change takes effect at the next turn's end; a Codex or OpenCode session switched on mid-session gets its Stop reminders but not the start-of-session guidance.
