#!/usr/bin/env bun
//
// Canonical prerequisite checks for the monitor plugin, owned by the install
// skill. The usage-dashboard precheck and the combined monitor:install engine
// (setup.ts) both import from here, so the check logic lives in one place.
//
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Level = "required" | "optional";
export type Check = { label: string; ok: boolean; level: Level; hint?: string };

const HOME = homedir();
// usage-dashboard assets live one skill over; resolve cross-skill from here.
const DASH = resolve(import.meta.dir, "..", "..", "usage-dashboard");
const COLLECTOR_SCRIPT = join(DASH, "scripts", "statusline-collector.ts");
const COLLECTOR_COMMAND = `bun ${COLLECTOR_SCRIPT}`;
// The plugin manifest sits three levels up from skills/install/scripts/.
const PLUGIN_JSON = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".claude-plugin",
  "plugin.json",
);

// Current plugin version from the manifest (null if unreadable).
export function pluginVersion(): string | null {
  try {
    return JSON.parse(readFileSync(PLUGIN_JSON, "utf-8")).version ?? null;
  } catch {
    return null;
  }
}

// Extract the version segment from a plugin-cache path, else null. Installed
// plugins live at `.../plugins/cache/<marketplace>/<plugin>/<version>/...`, so a
// configured path encodes the version it was wired at.
export function cachePathVersion(p: string): string | null {
  return p.match(/\/plugins\/cache\/[^/]+\/[^/]+\/([^/]+)\//)?.[1] ?? null;
}

// All read-only checks the dashboard cares about: bun, Claude data, committed
// vendor/pricing assets, and whether the statusline collector is wired.
export function dashboardChecks(): Check[] {
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, level: Level, hint?: string) =>
    checks.push({ label, ok, level, hint });

  check(
    "bun runtime",
    typeof Bun !== "undefined" && !!Bun.version,
    "required",
    "Install bun: https://bun.sh",
  );

  const statsCache = join(HOME, ".claude", "stats-cache.json");
  check(
    `stats-cache.json (${statsCache})`,
    existsSync(statsCache),
    "required",
    "File created by Claude Code on first /stats run; open Claude Code at least once.",
  );

  const history = join(HOME, ".claude", "history.jsonl");
  check(
    `history.jsonl (${history})`,
    existsSync(history),
    "optional",
    "Project ranking will be empty without it.",
  );

  const vendor = join(DASH, "dashboard", "dist", "vendor");
  check(
    `petite-vue (${vendor}/petite-vue.es.js)`,
    existsSync(join(vendor, "petite-vue.es.js")),
    "required",
  );
  check(
    `chart.js (${vendor}/chart.umd.js)`,
    existsSync(join(vendor, "chart.umd.js")),
    "required",
  );

  const pricing = join(DASH, "references", "pricing-defaults.json");
  check(`pricing defaults (${pricing})`, existsSync(pricing), "required");

  // Live usage limits — optional: dashboard works without it, the usage-window
  // panel just stays empty until Claude Code's statusline feeds rate_limits in.
  const settingsPath = join(HOME, ".claude", "settings.json");
  let statuslineCommand: string | null = null;
  let settingsReadable = true;
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const cmd = settings?.statusLine?.command;
      if (typeof cmd === "string") statuslineCommand = cmd;
    }
  } catch {
    settingsReadable = false;
  }
  // Installed plugins live at version-pinned cache paths, so a configured path
  // can drift after `claude plugin update` — and the old cache dir often still
  // exists, so existence isn't enough. Treat it as wired only if it points at
  // the *exact* live collector path.
  const referencedCollector =
    statuslineCommand?.match(/(\S*statusline-collector\.ts)/)?.[1] ?? null;
  const collectorWired = referencedCollector === COLLECTOR_SCRIPT;

  let usageHint: string | undefined;
  if (!settingsReadable) {
    usageHint = `Couldn't parse ${settingsPath} — fix it, then add a statusLine command running: ${COLLECTOR_COMMAND}`;
  } else if (referencedCollector && referencedCollector !== COLLECTOR_SCRIPT) {
    const pathVer = cachePathVersion(referencedCollector);
    const cur = pluginVersion();
    usageHint =
      pathVer && cur && pathVer !== cur
        ? `statusLine points at monitor ${pathVer} but the current version is ${cur}.\n` +
          `   Re-run setup to update statusLine.command in ${settingsPath} to: ${COLLECTOR_COMMAND}`
        : `statusLine points at a different/stale collector path.\n` +
          `   Update statusLine.command in ${settingsPath} to: ${COLLECTOR_COMMAND}`;
  } else if (statuslineCommand) {
    usageHint =
      `statusLine is set but doesn't run the collector, so live rate_limits aren't captured.\n` +
      `   Wrap your current line — set statusLine.command in ${settingsPath} to:\n` +
      `   "TOKEN_ATLAS_STATUSLINE_COMMAND='${statuslineCommand}' ${COLLECTOR_COMMAND}"`;
  } else {
    usageHint =
      `No statusLine configured. Add to ${settingsPath} to capture live usage limits:\n` +
      `   "statusLine": { "type": "command", "command": "${COLLECTOR_COMMAND}", "padding": 0 }\n` +
      `   Forwards to "bunx -y ccstatusline@latest" by default (override via TOKEN_ATLAS_STATUSLINE_COMMAND).`;
  }
  check(
    "live usage limits (statusline collector)",
    collectorWired,
    "optional",
    usageHint,
  );

  return checks;
}

// Print a check list with ✓/✗/○ marks and hints; report which levels failed.
export function printReport(checks: Check[]): {
  requiredFailed: boolean;
  optionalFailed: boolean;
} {
  let requiredFailed = false;
  let optionalFailed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.level === "required" ? "✗" : "○";
    console.log(`${mark} ${c.label}`);
    if (!c.ok) {
      if (c.level === "required") requiredFailed = true;
      else optionalFailed = true;
      if (c.hint) console.log(`   → ${c.hint}`);
    }
  }
  return { requiredFailed, optionalFailed };
}

// CLI: the dashboard precheck.
if (import.meta.main) {
  const { requiredFailed, optionalFailed } = printReport(dashboardChecks());
  console.log();
  if (requiredFailed) {
    console.log("Required checks failed. Fix the issues above and rerun.");
    process.exit(1);
  }
  if (optionalFailed) {
    console.log(
      "All required checks passed (some optional data missing — dashboard will still launch).",
    );
  } else {
    console.log("All checks passed. Run: bun run scripts/atlas-server.ts");
  }
  process.exit(0);
}
