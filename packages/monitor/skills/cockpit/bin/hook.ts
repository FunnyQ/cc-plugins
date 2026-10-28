import { join } from "node:path";

export function shouldSkip(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

if (import.meta.main) {
  if (shouldSkip(process.platform)) {
    await Bun.stdin.text();
    process.exit(0);
  }
  const proc = Bun.spawn(
    [join(import.meta.dir, "cockpit"), "hook", ...process.argv.slice(2)],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(await proc.exited);
}
