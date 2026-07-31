import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DaemonInfo = {
  pid: number;
  port: number;
  /** Absolute path of the scripts dir this daemon was launched from. */
  root: string;
  /** Absolute path of the plan dir it is serving. */
  plan: string;
};

export function recordPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ??
    join(process.env.HOME ?? homedir(), ".local", "share");

  return join(dataHome, "q-lab", "flightdeck", "daemon.json");
}

export function readRecord(): Partial<DaemonInfo> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath(), "utf8"));

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Partial<DaemonInfo>;
  } catch {
    return null;
  }
}

export function writeRecord(info: DaemonInfo): void {
  const path = recordPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info));
}

export function removeRecord(): void {
  try {
    unlinkSync(recordPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
