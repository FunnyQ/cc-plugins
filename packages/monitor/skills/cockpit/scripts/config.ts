import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CockpitConfig = { log_language?: string };

export function configPath(): string {
  // Owner choice: this global config intentionally follows XDG instead of the
  // repo's older ~/.cockpit / COCKPIT_HOME house style.
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "q-lab", "cockpit", "config.json");
}

export function readConfig(): CockpitConfig {
  try {
    const path = configPath();
    if (!existsSync(path)) return {};

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    return parsed as CockpitConfig;
  } catch {
    return {};
  }
}

export function getLanguage(): string {
  // readConfig() is total (returns {} on any failure) and the remaining work is
  // a property read + trim on a guarded value, which cannot throw — no outer
  // try/catch needed.
  const language = readConfig().log_language;
  if (typeof language !== "string") return "English";

  const trimmed = language.trim();
  return trimmed === "" ? "English" : trimmed;
}

export function setLanguage(language: string): void {
  const cfg = { ...readConfig(), log_language: language };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
