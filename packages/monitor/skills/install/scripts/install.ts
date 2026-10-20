#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Level = "required" | "optional";
export type Check = { label: string; ok: boolean; level: Level; hint?: string };

const HOME = homedir();
const DASH = resolve(import.meta.dir, "..", "..", "usage-dashboard");

const LIVE_SHIM = resolve(import.meta.dir, "../../cockpit/bin/cockpit");

export const SETTINGS_JSON = join(HOME, ".claude", "settings.json");
const PLUGIN_JSON = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".claude-plugin",
  "plugin.json",
);

export function pluginVersion(): string | null {
  try {
    return JSON.parse(readFileSync(PLUGIN_JSON, "utf-8")).version ?? null;
  } catch {
    return null;
  }
}

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

  return checks;
}

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
    console.log(`All checks passed. Run: ${LIVE_SHIM} atlas serve`);
  }
  process.exit(0);
}
