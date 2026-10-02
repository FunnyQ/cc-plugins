import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QLabPlugin } from "../../../opencode/plugin.ts";
import { TASK_PATH } from "./task-path.ts";

// No import can join the three copies, so compare source text: sample paths would miss the edit nobody thought to test.
const unescape = (re: RegExp) => re.source.replaceAll("\\/", "/");

test("flightplan-lint.sh gates on the same task path", async () => {
  const sh = await readFile(
    join(import.meta.dir, "flightplan-lint.sh"),
    "utf-8",
  );
  const pattern = sh.match(/=~ (\S+) \]\]/)?.[1];
  expect(pattern).toBe(unescape(TASK_PATH));
});

test("opencode/plugin.ts gates on the same task path", () => {
  expect(QLabPlugin.FLIGHTPLAN_TASK.source).toBe(TASK_PATH.source);
});
