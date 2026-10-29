import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempRoot(platform: NodeJS.Platform = process.platform): string {
  // windows.md: "/tmp" is drive-relative on Windows, so use the per-user temp dir.
  if (platform === "win32") return join(tmpdir(), "q-lab", "chronicle");
  return "/tmp/q-lab/chronicle";
}

export const TEMP_ROOT = tempRoot();

let payloadsWritten = 0;

export async function writeTempPayload(
  subdir: string,
  prefix: string,
  data: unknown,
): Promise<string> {
  const outputDirectory = join(TEMP_ROOT, subdir);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(
    outputDirectory,
    `${prefix}-${Date.now()}-${process.pid}-${++payloadsWritten}.json`,
  );
  await Bun.write(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  return outputPath;
}
