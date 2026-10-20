#!/usr/bin/env bun
// The cockpit channel MCP server is gone: a mod in hooks/register.ts delivers
// dashboard sends and the permission relay now. This engine only CLEANS UP the
// leftover hand-wired cockpit-channel entry older versions wrote to
// ~/.claude.json — it would launch a command that no longer exists.
//
// Modes:
//   (default) / --check   read-only status report, exit 1 if a required check fails
//   --dry-run             print exactly what --apply would change, write nothing
//   --apply               pre-approve scripts + remove any leftover channel entry
//   --migrate             unwrap the retired collector + remove a leftover channel entry
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Check,
  dashboardChecks,
  pluginVersion,
  printReport,
  SETTINGS_JSON,
} from "./install";
import {
  compareMonitorVersions,
  reapStaleMonitorProcesses,
} from "./reap-stale";
import { unwrapCollectorCommand } from "./statusline-decision";

const HOME = homedir();
// Absolute path a user can paste into ~/.claude.json (no $CLAUDE_PLUGIN_ROOT there).
const COCKPIT_SHIM = resolve(
  import.meta.dir,
  "..",
  "..",
  "cockpit",
  "bin",
  "cockpit",
);
const CLAUDE_JSON = join(HOME, ".claude.json");

// Without this, an un-allowlisted bun call hits a permission prompt — and a
// deeply-nested sub-agent (e.g. chronicle:editor → chronicle:drafter, or
// chronicle:manager → chronicle:analyst) can't surface that prompt to be answered,
// so it is silently DENIED and the whole flow stalls. Static allow entries make the
// scripts runnable at any nesting depth, no prompt. Mirrors the odin entry.
const SCRIPT_PERMISSIONS = [
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)",
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts *)",
  "Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)",
];

function readJson(path: string): { data: any; readable: boolean } {
  if (!existsSync(path)) return { data: {}, readable: true };
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")), readable: true };
  } catch {
    return { data: null, readable: false };
  }
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.bak-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

function claudeVersion(): string | null {
  try {
    const out = Bun.spawnSync(["claude", "--version"]).stdout.toString();
    return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function channelConfiguredPath(): string | null {
  const { data } = readJson(CLAUDE_JSON);
  const entry = data?.mcpServers?.["cockpit-channel"];
  const args = entry?.args;
  if (!Array.isArray(args)) return null;
  if (
    typeof entry?.command === "string" &&
    /(?:^|[/\\])skills[/\\]cockpit[/\\]bin[/\\]cockpit$/.test(entry.command) &&
    args[0] === "channel"
  )
    return entry.command;
  return (
    args.find(
      (a) => typeof a === "string" && a.endsWith("cockpit-channel.ts"),
    ) ?? null
  );
}

function cockpitCliChecks(): Check[] {
  const checks: Check[] = [];
  const add = (
    label: string,
    ok: boolean,
    level: Check["level"],
    hint?: string,
  ) => checks.push({ label, ok, level, hint });

  const ver = claudeVersion();
  add(
    `claude CLI ${ver ? `(${ver})` : ""}`.trim(),
    ver !== null,
    "optional",
    "Claude Code not found on PATH — the cockpit send box and permission relay need a build with function-hook mods.",
  );
  let executable = false;
  try {
    accessSync(COCKPIT_SHIM, constants.X_OK);
    executable = true;
  } catch {
  }
  add(
    "cockpit shim exists and is executable",
    executable,
    "required",
    `Expected at ${COCKPIT_SHIM}`,
  );
  add(
    "no leftover cockpit-channel entry in ~/.claude.json",
    channelConfiguredPath() === null,
    "optional",
    `Found a hand-wired cockpit-channel in ~/.claude.json — the channel was removed, so it is a leftover.\n   Run: bun ${import.meta.path} --migrate to remove it.`,
  );
  return checks;
}

function unwireChannel(dryRun: boolean): "removed" | "none" | "error" {
  const { data, readable } = readJson(CLAUDE_JSON);
  if (!readable) {
    console.log(`✗ Couldn't parse ${CLAUDE_JSON} — fix it first.`);
    return "error";
  }
  const hasEntry = channelConfiguredPath() !== null;
  if (!hasEntry) return "none";
  if (dryRun) {
    console.log(
      `Would remove the leftover cockpit-channel entry from ${CLAUDE_JSON}.`,
    );
    return "removed";
  }
  const next = { ...data, mcpServers: { ...(data.mcpServers ?? {}) } };
  delete next.mcpServers["cockpit-channel"];
  const bak = backup(CLAUDE_JSON);
  writeFileSync(CLAUDE_JSON, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ Removed leftover cockpit-channel from ${CLAUDE_JSON}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return "removed";
}

function missingScriptPermissions(): string[] {
  const { data } = readJson(SETTINGS_JSON);
  const allow: unknown = data?.permissions?.allow;
  const have = Array.isArray(allow) ? (allow as string[]) : [];
  return SCRIPT_PERMISSIONS.filter((p) => !have.includes(p));
}

function applyScriptPermissions(dryRun: boolean): boolean {
  const { data, readable } = readJson(SETTINGS_JSON);
  if (!readable) {
    console.log(`✗ Couldn't parse ${SETTINGS_JSON} — fix it first.`);
    return false;
  }
  const missing = missingScriptPermissions();
  if (missing.length === 0) {
    console.log("○ q-lab plugin scripts already pre-approved — nothing to do.");
    return true;
  }
  if (dryRun) {
    console.log(`Would add to permissions.allow in ${SETTINGS_JSON}:`);
    for (const p of missing) console.log(`   ${p}`);
    return true;
  }
  const allow = Array.isArray(data.permissions?.allow)
    ? (data.permissions.allow as string[])
    : [];
  const next = {
    ...data,
    permissions: { ...(data.permissions ?? {}), allow: [...allow, ...missing] },
  };
  const bak = backup(SETTINGS_JSON);
  writeFileSync(SETTINGS_JSON, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ Pre-approved q-lab plugin scripts in ${SETTINGS_JSON}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return true;
}

function scriptPermissionChecks(): Check[] {
  const missing = missingScriptPermissions();
  return [
    {
      label: "q-lab plugin scripts pre-approved (bun)",
      ok: missing.length === 0,
      level: "optional",
      hint: "Without these allow entries, `bun <plugin script>` prompts for permission — and a nested sub-agent (e.g. chronicle:drafter) can't answer it, so it's silently denied.\n   Run --apply to add them.",
    },
  ];
}

// Unwraps the collector rather than leaving it: the mod feeds the usage limits
// now, and the collector subcommand goes away in a later release.
function migrate(): string[] {
  const changed: string[] = [];

  if (unwireChannel(false) === "removed") {
    changed.push("cockpit-channel cleanup");
  }
  if (unwrapStatusline()) {
    changed.push("statusline collector removal");
  }

  return changed;
}

function unwrapStatusline(): boolean {
  const { data, readable } = readJson(SETTINGS_JSON);
  const cmd = data?.statusLine?.command;
  if (!readable || typeof cmd !== "string") return false;
  const next = unwrapCollectorCommand(cmd);
  if (next === null) return false;
  const bak = backup(SETTINGS_JSON);
  writeFileSync(
    SETTINGS_JSON,
    `${JSON.stringify({ ...data, statusLine: { ...data.statusLine, command: next } }, null, 2)}\n`,
  );
  console.log(`✓ Rewrote statusLine.command to: ${next}`);
  if (bak) console.log(`   (backup: ${bak})`);
  return true;
}

type DriftItem = { key: string; message: string };

function driftReport(): DriftItem[] {
  const { readable } = readJson(SETTINGS_JSON);
  if (!readable) {
    return [
      {
        key: "settings-unparseable",
        message: `${SETTINGS_JSON} is not valid JSON, so the permission wiring can't be read. Fix the file, then run the /monitor:install skill.`,
      },
    ];
  }

  const items: DriftItem[] = [];
  if (channelConfiguredPath() !== null) {
    items.push({
      key: "stale-channel",
      message: `${CLAUDE_JSON} still hand-wires cockpit-channel, a leftover from an older version that now points at a removed command. Run the /monitor:install skill to remove it.`,
    });
  }
  if (missingScriptPermissions().length > 0) {
    items.push({
      key: "missing-permissions",
      message:
        "the q-lab plugin scripts are missing from permissions.allow, so a nested sub-agent's `bun` call is silently denied. Run the /monitor:install skill to add them.",
    });
  }
  return items;
}

// A SessionStart hook reaches the USER only through the systemMessage field of a
// JSON stdout payload; bare stdout lands in the model's context instead. So the
function emitHookNotice(lines: string[]): void {
  const systemMessage =
    lines.length === 1
      ? `monitor: ${lines[0]}`
      : `monitor:\n${lines.map((l) => `• ${l}`).join("\n")}`;
  process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
}

function captureLogs(fn: () => string[]): {
  changed: string[];
  logs: string[];
} {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { changed: fn(), logs };
  } finally {
    console.log = original;
  }
}

function sessionCheck(): void {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const version = pluginVersion();
  if (!dataDir || !version) return;

  const notices: string[] = [];

  const marker = join(dataDir, ".wired-version");
  let last: string | null = null;
  try {
    if (existsSync(marker)) last = readFileSync(marker, "utf-8").trim();
  } catch {
    last = null;
  }
  const markerOrder = last ? compareMonitorVersions(last, version) : null;
  if (markerOrder === null || markerOrder < 0) {
    // previous version are still running. Before 3.19.0 the channel had no exit path, so
    // those are immortal; retire them now. Only true orphans (PPID 1) are touched.
    const reaped = reapStaleMonitorProcesses(version);
    if (reaped) {
      notices.push(
        `retired ${reaped} leftover process${reaped === 1 ? "" : "es"} from a previous version.`,
      );
    }

    const { changed, logs } = captureLogs(migrate);
    if (changed.length) {
      notices.push(...logs.filter(Boolean));
      notices.push(
        `updated ${changed.join(" + ")} to v${version} after a plugin update.`,
      );
    }
    try {
      writeFileSync(marker, `${version}\n`);
    } catch {
    }
  }

  const drift = driftReport();
  const signature = drift
    .map((d) => d.key)
    .sort()
    .join(",");
  const sigPath = join(dataDir, ".drift-notice");
  let lastSignature = "";
  try {
    if (existsSync(sigPath)) {
      lastSignature = readFileSync(sigPath, "utf-8").trim();
    }
  } catch {
    lastSignature = "";
  }
  if (signature !== lastSignature) {
    notices.push(...drift.map((d) => d.message));
    try {
      writeFileSync(sigPath, `${signature}\n`);
    } catch {
    }
  }

  if (notices.length) emitHookNotice(notices);
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has("--dry-run");

  if (flags.has("--session-check")) {
    sessionCheck();
    process.exit(0);
  }

  if (flags.has("--migrate")) {
    const changed = migrate();
    console.log(
      changed.length
        ? `Migrated: ${changed.join(" + ")}.`
        : "Nothing to migrate.",
    );
    process.exit(0);
  }

  if (flags.has("--apply") || dryRun) {
    let ok = unwireChannel(dryRun) !== "error";
    ok = applyScriptPermissions(dryRun) && ok;
    console.log();
    if (!dryRun && ok) console.log("Done.");
    process.exit(ok ? 0 : 1);
  }

  const { requiredFailed } = printReport([
    ...dashboardChecks(),
    ...cockpitCliChecks(),
    ...scriptPermissionChecks(),
  ]);
  console.log();
  if (requiredFailed) {
    console.log("Required checks failed. Fix the issues above and rerun.");
    process.exit(1);
  }
  console.log("Required checks passed. To wire config, run:");
  console.log(
    `   bun ${import.meta.path} --apply        # permissions + cleanup`,
  );
  console.log(
    `   bun ${import.meta.path} --dry-run      # preview without writing`,
  );
  process.exit(0);
}

if (import.meta.main) main();
