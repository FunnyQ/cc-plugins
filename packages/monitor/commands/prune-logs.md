---
description: Prune old cockpit decision logs — trash stale .cockpit/logs jsonl + drop dead registry entries.
argument-hint: "[--days N] [--dry-run]"
---

Prune accumulated cockpit **decision logs**. The registry self-reaps stale *entries* on write, but the on-disk `.cockpit/logs/*.jsonl` *files* (and orphans whose entry was already reaped) never age out on their own — this reclaims them.

**Always preview first.** Run the dry-run with whatever `$ARGUMENTS` I passed:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts prune --dry-run $ARGUMENTS
```

Report the summary (how many logs would be trashed, how many kept, registry entries dropped). Then, **only after I confirm**, run it for real (drop `--dry-run`, keep the rest of my arguments):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts prune $ARGUMENTS
```

**Flags:**
- `--days N` — cutoff in days (default `14`, matching the registry TTL). A log is prunable when its last activity — `max(registry heartbeat, file mtime)` — is at least N days old, so a still-being-written session is never touched.
- `--dry-run` — print the plan only; change nothing.

Files go to the OS trash (via `trash`), not a hard `rm`. Pruning is scoped to the project roots the registry knows about; a project whose last entry was already reaped is invisible to the scan.
