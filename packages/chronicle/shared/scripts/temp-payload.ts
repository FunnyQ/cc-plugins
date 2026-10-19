import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const TEMP_ROOT = join("/tmp", "q-lab", "chronicle");

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
