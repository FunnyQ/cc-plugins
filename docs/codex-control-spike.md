# Codex Control Spike

> Status: spike
> Last updated: 2026-05-27

## Goal

Validate whether cockpit can eventually send messages into Codex sessions through
Codex app-server remote control. This is intentionally separate from the Claude
channel path: Claude uses `notifications/claude/channel`; Codex is probed through
app-server JSON-RPC.

## Current artifact

`packages/monitor/skills/cockpit/scripts/codex-control-probe.ts` is a dry-run by
default probe:

```bash
bun packages/monitor/skills/cockpit/scripts/codex-control-probe.ts --json
bun packages/monitor/skills/cockpit/scripts/codex-control-probe.ts --thread <id> --json
bun packages/monitor/skills/cockpit/scripts/codex-control-probe.ts --thread <id> --send "hello" --json
```

- `codex remote-control start --json` checks/starts Codex remote control when
  the standalone managed Codex install is present.
- If remote-control cannot start, the probe falls back to direct
  `codex app-server --listen stdio://` and reports `controlMode:
  "direct-app-server"`.
- `codex app-server proxy` carries JSON-RPC over stdio for remote-control mode.
- If the managed daemon starts but the proxy does not answer `initialize`, the
  probe also falls back to direct app-server and records the proxy failure as a
  warning.
- `initialize` verifies protocol readiness.
- `thread/loaded/list` verifies basic read access when no thread is selected.
- `thread/resume` verifies a selected Codex thread can be attached.
- `turn/start` runs only with explicit `--send`, so normal probes do not add
  user turns to a working thread.

## Integration direction

If the probe is stable, the next implementation should add a provider-specific
Codex control adapter behind cockpit rather than reuse the Claude inbox channel.
The UI should only enable the Codex send box when the Codex control path is live
and the selected thread can be resumed.
