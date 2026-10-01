import { describe, expect, test } from "bun:test";
import { pickInstance, resolveBinary, type Instance } from "./instances";

const instance = (id: string, overrides: Partial<Instance> = {}): Instance => ({
  id,
  pid: 1,
  port: 2828,
  profile: `/tmp/${id}`,
  browser: "firefox",
  headless: true,
  ...overrides,
});

describe("pickInstance", () => {
  test("takes the only live instance without an id", () => {
    expect(pickInstance([instance("a")], null).id).toBe("a");
  });

  test("refuses to guess between several and names them", () => {
    expect(() => pickInstance([instance("a"), instance("b")], null)).toThrow(
      /2 instances are open — pass --id: a, b/,
    );
  });

  test("finds the named one", () => {
    expect(pickInstance([instance("a"), instance("b")], "b").id).toBe("b");
  });

  test("says when none is open", () => {
    expect(() => pickInstance([], null)).toThrow(
      "no instance is open — run `open <url>` first",
    );
  });
});

describe("resolveBinary", () => {
  test("takes the first candidate that exists", () => {
    expect(resolveBinary("firefox", ["/a", "/b"], (path) => path === "/b")).toBe("/b");
  });

  test("names every path it looked for when none exists", () => {
    expect(() => resolveBinary("zen", ["/Applications/Zen.app/x"], () => false)).toThrow(
      "no zen found; looked for /Applications/Zen.app/x",
    );
  });
});
