import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { QLabPlugin } from "../../../opencode/plugin.ts";
import { COMMIT_COMMAND } from "./commit-command.ts";

// No import can join the three copies, so compare source text: sample commands would miss the edit nobody thought to test.
test("check-branch.sh gates on the same commit command", async () => {
  const sh = await readFile(join(import.meta.dir, "check-branch.sh"), "utf-8");
  const pattern = sh.match(/=~ (\S+) \]\]/)?.[1];
  expect(pattern?.replaceAll("[[:space:]]", "\\s")).toBe(COMMIT_COMMAND.source);
});

test("check-branch.sh's jq-skipping prefilter admits every commit command", async () => {
  const sh = await readFile(join(import.meta.dir, "check-branch.sh"), "utf-8");
  const word = sh.match(/!= \*(\w+)\* \]\]/)?.[1];
  expect(word).toBeDefined();
  expect(COMMIT_COMMAND.source).toEndWith(word!);
});

test("opencode/plugin.ts gates on the same commit command", () => {
  expect(QLabPlugin.COMMIT_COMMAND.source).toBe(COMMIT_COMMAND.source);
});
