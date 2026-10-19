import { expect, test } from "claude-code/testing";
import { shortPath, where } from "./where";

test("shortPath leaves a path whole before session.start sets cwd and home", () => {
  expect(where).toEqual({ cwd: "", home: "" });
  expect(shortPath("/Users/q/repo/a.ts")).toBe("/Users/q/repo/a.ts");
});
