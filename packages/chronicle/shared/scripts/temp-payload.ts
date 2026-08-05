import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Root for every chronicle hand-off payload. One place so a cleanup can find them all. */
export const TEMP_ROOT = join("/tmp", "chronicle");

/**
 * Writes a hand-off payload to `/tmp/chronicle/<subdir>/<prefix>-<ms>-<pid>.json`
 * and returns the path. Agents pass paths, never payloads, between phases.
 *
 * The `<ms>-<pid>` suffix is the uniqueness guarantee: each caller writes one
 * payload per process, so the pair cannot repeat across concurrent runs.
 */
export async function writeTempPayload(
  subdir: string,
  prefix: string,
  data: unknown,
): Promise<string> {
  const outputDirectory = join(TEMP_ROOT, subdir);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(
    outputDirectory,
    `${prefix}-${Date.now()}-${process.pid}.json`,
  );
  await Bun.write(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  return outputPath;
}
