import { describe, expect, test } from "bun:test";
import { settle } from "./cdp";
import { parseArgs } from "./chrome";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(
      parseArgs([
        "open",
        "http://a",
        "--new",
        "--headed",
        "--size",
        "800x600",
        "--id",
        "k",
      ]),
    ).toMatchObject({
      command: "open",
      args: ["http://a"],
      fresh: true,
      headed: true,
      size: "800x600",
      id: "k",
    });
  });

  test("rejects --zen, which belongs to the firefox skill", () => {
    expect(() => parseArgs(["open", "http://a", "--zen"])).toThrow(
      "chrome has no --zen: use the firefox skill",
    );
  });
});

describe("settle", () => {
  test("returns the result of a successful reply", () => {
    expect(
      settle("Page.navigate", { id: 1, result: { frameId: "f" } }),
    ).toEqual({ frameId: "f" });
  });

  // Measured on Chrome 154: an unknown method answers with code -32601.
  test("throws the method and message of a protocol error", () => {
    expect(() =>
      settle("Nope.method", {
        id: 2,
        error: { code: -32601, message: "'Nope.method' wasn't found" },
      }),
    ).toThrow("Nope.method: 'Nope.method' wasn't found");
  });
});

