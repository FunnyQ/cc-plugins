#!/usr/bin/env bun
//
// monitor:install engine — the single entry that checks every prerequisite for
// both skills and wires the config a non-dev user otherwise edits by hand:
//   - permissions.allow entries that pre-approve `bun <q-lab plugin script>.ts`
//     (so deeply-nested sub-agents — e.g. chronicle:drafter — can run them without
//     hitting an unanswerable permission prompt that silently denies them).
//
// The cockpit channel MCP server is gone: a mod in hooks/register.ts delivers
// dashboard sends and the permission relay now. This engine only CLEANS UP the
// leftover hand-wired cockpit-channel entry older versions wrote to
// ~/.claude.json — it would launch a command that no longer exists.
//
// Checks reuse install.ts (dashboard) + the cockpit prerequisites here.
//
// The monitor mod's session.measure hook feeds the usage limits now, so a
// statusLine that still runs the retired collector is unwrapped by --migrate.
//
// Modes:
//   (default) / --check   read-only status report, exit 1 if a required check fails
//   --dry-run             print exactly what --apply would change, write nothing
//   --apply               pre-approve scripts + remove any leftover channel entry
//   --migrate             unwrap the retired collector + remove a leftover channel entry
//
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
const COCKPIT_SCRIPTS = resolve(
  import.meta.dir,
  "..",
  "..",
  "cockpit",
  "scripts",
);
const CLAUDE_JSON = join(HOME, ".claude.json");

// Pre-approve `bun <q-lab-marketplace plugin script>.ts` in permissions.allow.
// Without this, an un-allowlisted bun call hits a permission prompt — and a
// deeply-nested sub-agent (e.g. chronicle:editor → chronicle:drafter, or
// chronicle:manager → chronicle:analyst) can't surface that prompt to be answered,
// so it is silently DENIED and the whole flow stalls. Static allow entries make the
// scripts runnable at any nesting depth, no prompt. Mirrors the odin entry.
const SCRIPT_PERMISSIONS = [
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)",
  "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts *)",
  // Nested sub-agents cannot answer permission prompts for cockpit log calls.
  "Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)",
];

// --- helpers ----------------------------------------------------------------
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

type ResolveDependency = (specifier: string, from: string) => string;

function defaultResolve(specifier: string, from: string): string {
  return Bun.resolveSync(specifier, from);
}

// A leftover cockpit-channel entry in ~/.claude.json from an older version that
// hand-wired the channel, or null if there's none. The channel no longer exists,
// so any such entry points at a dead command and should be removed.
function channelConfiguredPath(): string | null {
  const { data } = readJson(CLAUDE_JSON);
  const entry = data?.mcpServers?.["cockpit-channel"];
  const args = entry?.args;
  if (!Array.isArray(args)) return null;
  if (
    typeof entry?.command === "string" &&
    /(?:^|[/\\])skills[/\\]cockpit[/\\]bin[/\\]cockpit$/.test(entry.command) &&
    args[0] === "channel"
  ) return entry.command;
  return (
    args.find(
      (a) => typeof a === "string" && a.endsWith("cockpit-channel.ts"),
    ) ?? null
  );
}

// --- cockpit prerequisite checks (the piece this skill owns) ----------------
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
    // A missing or non-executable shim is a partial install: a required failure.
  }
  add(
    "cockpit shim exists and is executable",
    executable,
    "required",
    `Expected at ${COCKPIT_SHIM}`,
  );
  // Older versions hand-wired the channel; the entry is a leftover now.
  add(
    "no leftover cockpit-channel entry in ~/.claude.json",
    channelConfiguredPath() === null,
    "optional",
    `Found a hand-wired cockpit-channel in ~/.claude.json — the channel was removed, so it is a leftover.\n   Run: bun ${import.meta.path} --migrate to remove it.`,
  );
  return checks;
}

export function cockpitChecks(
  resolveDep: ResolveDependency = defaultResolve,
): Check[] {
  let happyDomResolves = false;
  try {
    resolveDep("happy-dom", COCKPIT_SCRIPTS);
    happyDomResolves = true;
  } catch {
    happyDomResolves = false;
  }

  return [
    {
      label: "mermaid diagram lint (happy-dom)",
      ok: happyDomResolves,
      level: "optional",
      hint: "Mermaid --diagram lint falls back to weaker heuristics that can pass source the dashboard cannot render.\n   Run bun install in the plugin directory, or let Bun auto-install it from ~/.bun/install/cache on first use (needs network once).",
    },
  ];
}

// --- cleanup: remove a leftover hand-wired cockpit-channel from ~/.claude.json --
// Older versions wrote the channel here; the channel is gone, so the entry points
// at a dead command. "removed" when it deleted one, "none"
// when there was nothing to do, "error" when the file couldn't be parsed.
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

// --- apply: pre-approve q-lab plugin scripts in permissions.allow -----------
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

// --- migrate: leftover channel entry + retired statusline collector -----------
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

// --- drift watch: read-only, runs every session -----------------------------
// migrate() is gated on a version change, so wiring that drifts WITHIN a version
// — a hand-edited settings.json, a restored backup, a reinstall under another
// cache root — would go unseen until the next upgrade. This half never writes:
// it only names what no longer matches this install, and the user decides.
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
// whole hook speaks exactly once, and nothing may print before this.
function emitHookNotice(lines: string[]): void {
  const systemMessage =
    lines.length === 1
      ? `monitor: ${lines[0]}`
      : `monitor:\n${lines.map((l) => `• ${l}`).join("\n")}`;
  process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
}

// migrate() reports through console.log, which would break the single-JSON rule
// above. Collect its lines instead of letting them out.
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

// --- session-check: the SessionStart hook entry -----------------------------
// Two halves with different rules. The repair half is marker-gated: it runs at
// most once per plugin version, because the drift an upgrade causes is the only
// drift this script is allowed to fix on its own. The drift watch runs every
// session, reads only, and reports once per distinct set of problems.
function sessionCheck(): void {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const version = pluginVersion();
  // No data dir or unknown version → can't gate safely; do nothing.
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
  // The marker is shared across sessions. An older session can keep running after an
  // upgrade and fire this hook on resume/compact; it must never roll newer config back.
  if (markerOrder === null || markerOrder < 0) {
    // The version just changed (or this is a first run) — exactly when daemons from the
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
      // Best-effort marker; if the data dir isn't writable we just retry next session.
    }
  }

  // Drift watch. Keyed on WHICH pieces are off, not on the version, so the same
  // complaint isn't repeated every session — and a drift that returns after being
  // fixed is reported again.
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
      // Best-effort; an unwritable data dir just means the notice repeats.
    }
  }

  if (notices.length) emitHookNotice(notices);
}

// --- main -------------------------------------------------------------------
function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has("--dry-run");

  // SessionStart hook entry — quiet, never fresh-wires, notice-only off-version.
  if (flags.has("--session-check")) {
    sessionCheck();
    process.exit(0);
  }

  // Re-point drifted pieces now (no version gate); used manually too.
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

  // default: check — dashboard prerequisites + cockpit
  const { requiredFailed } = printReport([
    ...dashboardChecks(),
    ...cockpitCliChecks(),
    ...cockpitChecks(),
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
