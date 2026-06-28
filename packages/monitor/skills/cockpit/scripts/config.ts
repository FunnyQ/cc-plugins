import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A scope's explicit scribe-nudge preference. Absent = "no opinion" (defer). */
export type NudgeState = "on" | "off";

export type CockpitConfig = {
  log_language?: string;
  // Persistent scribe-nudge preferences. `user` is the global default; `projects`
  // overrides it per project root. The most-specific defined scope wins
  // (session → project → user), resolved in nudge-toggle.ts.
  nudges?: {
    user?: NudgeState;
    projects?: Record<string, NudgeState>;
  };
};

function asNudgeState(v: unknown): NudgeState | undefined {
  return v === "on" || v === "off" ? v : undefined;
}

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
  writeConfig({ ...readConfig(), log_language: language });
}

function writeConfig(cfg: CockpitConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

// ── Scribe-nudge preferences (user + project scopes) ─────────────────────────

/** The global user-level nudge preference, or undefined when unset. */
export function getUserNudge(): NudgeState | undefined {
  return asNudgeState(readConfig().nudges?.user);
}

/** Set (or, with null, clear) the global user-level nudge preference. */
export function setUserNudge(state: NudgeState | null): void {
  const cfg = readConfig();
  const nudges = { ...cfg.nudges };
  if (state === null) delete nudges.user;
  else nudges.user = state;
  writeConfig({ ...cfg, nudges });
}

/** The project-level nudge preference for a project root, or undefined. */
export function getProjectNudge(project: string): NudgeState | undefined {
  return asNudgeState(readConfig().nudges?.projects?.[project]);
}

/** Set (or, with null, clear) the project-level nudge preference. */
export function setProjectNudge(
  project: string,
  state: NudgeState | null,
): void {
  const cfg = readConfig();
  const projects = { ...cfg.nudges?.projects };
  if (state === null) delete projects[project];
  else projects[project] = state;
  const nudges = { ...cfg.nudges, projects };
  if (Object.keys(projects).length === 0) delete nudges.projects;
  writeConfig({ ...cfg, nudges });
}
