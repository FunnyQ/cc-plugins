import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes `script` as a bun program plus a `name` launcher for it in `dir`, and
 * returns the launcher. On win32 the launcher is a `.cmd` shim, the shape npm
 * installs codex and opencode as.
 */
export async function writeFakeBin(
  dir: string,
  name: string,
  script: string,
): Promise<string> {
  const fake = join(dir, `fake-${name}.ts`);
  await writeFile(fake, script);
  const bin = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  await writeFile(
    bin,
    process.platform === "win32"
      ? `@"${process.execPath}" "${fake}" %*\r\n`
      : `#!/bin/sh\nexec bun ${fake} "$@"\n`,
  );
  await chmod(bin, 0o755);
  return bin;
}

export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Points HOME and USERPROFILE at `dir`; returns the restorer. */
export function isolateHome(dir: string): () => void {
  const home = process.env.HOME;
  const profile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    restoreEnv("HOME", home);
    restoreEnv("USERPROFILE", profile);
  };
}
