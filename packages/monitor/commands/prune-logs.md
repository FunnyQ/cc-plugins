---
description: Prune old cockpit decision logs — trash stale .cockpit/logs jsonl + drop dead registry entries.
argument-hint: "[--days N] [--dry-run]"
---

Prune accumulated cockpit **decision logs**. The registry self-reaps stale *entries* on write. But the on-disk `.cockpit/logs/*.jsonl` *files* never age out on their own. Neither do orphans whose entry was already reaped. This command reclaims both.

**Always preview first.** Run the dry-run with whatever `$ARGUMENTS` I passed:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts prune --dry-run $ARGUMENTS
```

Report the summary (how many logs would be trashed, how many kept, registry entries dropped). Then, **only after I confirm**, run it for real (drop `--dry-run`, keep the rest of my arguments):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts prune $ARGUMENTS
```

**Flags:**
- `--days N` — cutoff in days (default `14`, matching the registry TTL). A log is prunable when its last activity is at least N days old. Last activity is `max(registry heartbeat, file mtime)`. This never touches a still-being-written session.
- `--dry-run` — print the plan only; change nothing.

Files go to the OS trash (via `trash`), not a hard `rm`. Pruning is scoped to the project roots the registry knows about. If a project's last entry was already reaped, the scan cannot see that project.
