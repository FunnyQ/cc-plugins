import { join } from "node:path";

if (process.platform === "win32") {
  await Bun.stdin.text();
  process.exit(0);
}
const proc = Bun.spawn(
  [join(import.meta.dir, "cockpit"), "hook", ...process.argv.slice(2)],
  { stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(await proc.exited);
