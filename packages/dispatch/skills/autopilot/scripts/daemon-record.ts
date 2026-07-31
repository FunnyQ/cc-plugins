import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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

function isPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65535
  );
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

/**
 * Read the record, or null when any field is missing or malformed.
 *
 * The pid in this file reaches `process.kill`, so a half-written or hand-edited
 * record must never pass through: an unchecked field decides which process is
 * signalled and which URL the launcher prints.
 */
export function readRecord(): DaemonInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath(), "utf8"));

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const { pid, port, root, plan } = parsed as Record<string, unknown>;

    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    if (!isPort(port)) return null;
    if (!isAbsolutePath(root) || !isAbsolutePath(plan)) return null;

    return { pid: pid as number, port, root, plan };
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
