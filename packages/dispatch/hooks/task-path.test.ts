import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QLabPlugin } from "../../../opencode/plugin.ts";
import { TASK_PATH } from "./task-path.ts";

const MATCHES = [
  "docs/x/tasks/ui/01-a.md",
  "C:\\repo\\docs\\x\\tasks\\ui\\01-a.md",
  "docs\\x\\tasks\\ui\\01-a.md",
  "C:\\repo/docs/x\\tasks/ui\\01-a.md",
];
const REJECTS = [
  "C:\\repo\\docs\\x\\tasks\\ui-kit\\01-a.md",
  "docs/x/tasks/ui-kit/01-a.md",
  "mydocs\\x\\tasks\\ui\\01-a.md",
];

async function shPattern(): Promise<string | undefined> {
  const sh = await readFile(
    join(import.meta.dir, "flightplan-lint.sh"),
    "utf-8",
  );
  return sh.match(/=~ (\S+) \]\]/)?.[1];
}

// No import can join the three copies, so compare source text: sample paths would miss the edit nobody thought to test.
test("flightplan-lint.sh gates on the same task path", async () => {
  expect(await shPattern()).toBe(TASK_PATH.source);
});

test("opencode/plugin.ts gates on the same task path", () => {
  expect(QLabPlugin.FLIGHTPLAN_TASK.source).toBe(TASK_PATH.source);
});

test("TASK_PATH accepts / and \\ as every separator, and still rejects a dashed bucket", () => {
  for (const path of MATCHES)
    expect([path, TASK_PATH.test(path)]).toEqual([path, true]);
  for (const path of REJECTS)
    expect([path, TASK_PATH.test(path)]).toEqual([path, false]);
});

// The hook's shebang is /bin/bash (3.2 on macOS); Git Bash on Windows is the bash on PATH.
const SHELLS = process.platform === "win32" ? ["bash"] : ["bash", "/bin/bash"];

test.each(SHELLS)(
  "%s's =~ with the flightplan-lint.sh pattern accepts / and \\ separators and rejects a dashed bucket",
  async (shell) => {
    const pattern = await shPattern();
    // Script on stdin and path in env, as the hook reads both: MSYS halves every \\ in a quoted argv entry.
    const verdict = (path: string) =>
      Bun.spawnSync([shell], {
        stdin: new TextEncoder().encode(`[[ "$TASK_FILE" =~ ${pattern} ]]`),
        env: { ...process.env, TASK_FILE: path },
      }).exitCode === 0;
    for (const path of MATCHES)
      expect([path, verdict(path)]).toEqual([path, true]);
    for (const path of REJECTS)
      expect([path, verdict(path)]).toEqual([path, false]);
  },
);
