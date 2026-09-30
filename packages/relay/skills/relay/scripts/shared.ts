import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { join, parse } from "path";
import { homedir } from "os";
import type { Mode, RunResult } from "./types";

// Temp directory root for relay runs
export const TMP_ROOT = "/tmp/q-lab/relay/relay";

// Config file path for relay models (XDG standard)
export const CONFIG_PATH = join(
  homedir(),
  ".config",
  "q-lab",
  "cc-plugins",
  "relay",
  "config.json",
);

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Parse a comma-separated flag value into a trimmed, empty-free list.
export function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Bun.spawnSync wrapper
export function run(
  args: string[],
  opts?: {
    stdin?: string;
    env?: Record<string, string | undefined>;
  },
): RunResult {
  const proc = Bun.spawnSync(args, {
    stdin: opts?.stdin !== undefined ? Buffer.from(opts.stdin) : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env,
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode ?? 1,
  };
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

// Timestamp in YYYYMMDD-HHMM format (minute resolution)
function timestampToMinute(now: Date): string {
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}`,
  ].join("-");
}

// Timestamp in YYYYMMDD-HHMMSS-milliseconds format (for paths)
export function timestampForPath(now = new Date()): string {
  return `${timestampToMinute(now)}${pad(now.getSeconds())}-${pad(
    now.getMilliseconds(),
    3,
  )}`;
}

// Create a tmp run directory and return its path
export function createTmpRunDir(): string {
  const dir = join(
    TMP_ROOT,
    `${timestampForPath()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Add timestamp suffix to file path (foo.png → foo_YYYYMMDD-HHMM.png)
export function addTimestampSuffix(filePath: string): string {
  const { dir, name, ext } = parse(filePath);
  const newName = `${name}_${timestampToMinute(new Date())}${ext}`;
  // Preserve empty dir as "." (current directory)
  if (!dir) return newName;
  return join(dir, newName);
}

// Resolve model with precedence: flag > config > undefined (the CLI's own default).
// A readConfig error propagates so a broken config never looks like "nothing configured".
export function resolveModel(
  backend: string,
  mode: Mode,
  flagModel: string | undefined,
  readConfig: () => unknown,
): string | undefined {
  if (flagModel) return flagModel;

  const config = readConfig();
  if (isObject(config) && isObject(config.models)) {
    const backendModels = config.models[backend];
    if (isObject(backendModels) && typeof backendModels[mode] === "string") {
      return backendModels[mode];
    }
  }

  return undefined;
}
