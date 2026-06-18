import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const migratedTargets = new Set<string>();

function defaultCockpitHome(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "q-lab", "cockpit");
}

function migrateLegacyHome(newHome: string): void {
  if (migratedTargets.has(newHome)) return;
  migratedTargets.add(newHome);

  const legacyHome = join(homedir(), ".cockpit");
  try {
    if (existsSync(newHome) || !existsSync(legacyHome)) return;
    mkdirSync(dirname(newHome), { recursive: true });
    renameSync(legacyHome, newHome);
  } catch {
    // Best-effort only: another process may have migrated first, or the legacy
    // path may be unavailable. Callers still use the new XDG location.
  }
}

export function cockpitHome(): string {
  if (process.env.COCKPIT_HOME) return process.env.COCKPIT_HOME;

  const home = defaultCockpitHome();
  migrateLegacyHome(home);
  return home;
}
