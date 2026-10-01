import { describe, expect, test } from "bun:test";
import { parseArgs } from "./firefox";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(
      parseArgs([
        "open",
        "http://a",
        "--zen",
        "--headed",
        "--size",
        "800x600",
        "--id",
        "k",
      ]),
    ).toMatchObject({
      command: "open",
      args: ["http://a"],
      zen: true,
      headed: true,
      size: "800x600",
      id: "k",
    });
  });

  test("keeps a positional that only looks like a flag value", () => {
    expect(parseArgs(["type", "#q", "--full"])).toMatchObject({
      command: "type",
      args: ["#q"],
      full: true,
    });
  });

  test("rejects a value flag with nothing after it", () => {
    expect(() => parseArgs(["screenshot", "--output"])).toThrow(
      "--output needs a value",
    );
  });
});

