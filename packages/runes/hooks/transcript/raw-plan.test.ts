import { expect, test } from "claude-code/testing";

import { planRaw, shellLine } from "./raw-plan";

const has =
  (...found: string[]) =>
  (cmd: string) =>
    found.includes(cmd);

test("herdr-app peeks, herdr popups, anything else opens a .txt", () => {
  const nvim = has("nvim");
  expect(planRaw({ HC_TERMINAL_ID: "t1" }, nvim, "darwin")).toEqual({
    via: "peek",
    editor: ["nvim", "-R"],
  });
  expect(planRaw({ HERDR_ENV: "1" }, nvim, "linux")).toEqual({
    via: "popup",
    editor: ["nvim", "-R"],
  });
  expect(planRaw({}, nvim, "darwin")).toEqual({ via: "system" });
});

test("the editor falls from nvim to vim to $EDITOR", () => {
  const env = { HC_TERMINAL_ID: "t1", EDITOR: "hx --vsplit" };
  expect(planRaw(env, has("nvim", "vim"), "darwin")).toMatchObject({
    editor: ["nvim", "-R"],
  });
  expect(planRaw(env, has("vim"), "darwin")).toMatchObject({
    editor: ["vim", "-R"],
  });
  expect(planRaw(env, has(), "darwin")).toMatchObject({
    editor: ["hx", "--vsplit"],
  });
});

test("a configured editor runs as written, and falls back when it is missing", () => {
  const env = { HERDR_ENV: "1" };
  expect(planRaw(env, has("nvim", "nano"), "linux", "nano -v")).toEqual({
    via: "popup",
    editor: ["nano", "-v"],
  });
  expect(planRaw(env, has("nvim"), "linux", "nano")).toEqual({
    via: "system",
  });
  expect(planRaw(env, has("nvim"), "linux", "auto")).toMatchObject({
    editor: ["nvim", "-R"],
  });
});

test("no editor, or herdr's sh popup on Windows, falls back to the system opener", () => {
  expect(planRaw({ HC_TERMINAL_ID: "t1" }, has(), "linux")).toEqual({
    via: "system",
  });
  expect(planRaw({ HERDR_ENV: "1" }, has("nvim"), "win32")).toEqual({
    via: "system",
  });
});

test("shellLine quotes every argument for sh", () => {
  expect(shellLine(["nvim", "-R", "/tmp/it's here.md"])).toBe(
    `'nvim' '-R' '/tmp/it'\\''s here.md'`,
  );
});
