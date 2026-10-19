import { expect, test } from "bun:test";
import { CLEAN, promptBody } from "./reviewer.ts";

const agentFile = await Bun.file(
  `${import.meta.dir}/../agents/comments-reaper.md`,
).text();

test("the prompt is the agent file without its frontmatter", () => {
  const body = promptBody(agentFile);
  expect(body).toStartWith("You review");
  expect(body).not.toContain("tools:");
});

test("the reviewer is told to skip a + line that is not a comment", () => {
  expect(promptBody(agentFile)).toContain("not a comment");
});

test("the agent file's all-clear reply is the one the mod matches", () => {
  expect(promptBody(agentFile)).toContain(`reply with exactly: ${CLEAN}`);
});
