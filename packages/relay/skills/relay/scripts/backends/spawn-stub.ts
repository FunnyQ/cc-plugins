import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const SPAWN_PROMPT = 'say "hi" 100% & stop\nsecond line';

/**
 * Runs `argv` with its binary swapped for a stub that saves its stdin, and
 * returns what the stub received. On win32 the stub is a `.cmd` shim, the
 * shape npm installs codex and opencode as.
 */
export function spawnStub(
  argv: string[],
  stdin: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-stub-"));
  try {
    const out = join(dir, "stdin.txt");
    const fake = join(dir, "fake.ts");
    writeFileSync(
      fake,
      `require("fs").writeFileSync(${JSON.stringify(out)}, await Bun.stdin.text());\n`,
    );
    let bin = [process.execPath, fake];
    if (platform === "win32") {
      const cmd = join(dir, "fake.cmd");
      writeFileSync(cmd, `@"${process.execPath}" "${fake}" %*\r\n`);
      bin = [cmd];
    }
    const proc = Bun.spawnSync([...bin, ...argv.slice(1)], {
      stdin: Buffer.from(stdin ?? ""),
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return readFileSync(out, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
