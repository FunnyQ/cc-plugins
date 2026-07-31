import { describe, expect, test } from "bun:test";
import { parseArgs } from "./launch";

describe("parseArgs", () => {
  test("parses valid arguments", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "6000"])).toEqual({
      ok: true,
      args: { plan: "/plan", port: 6000, open: true },
    });
  });

  test("rejects a missing plan", () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects a relative plan", () => {
    expect(parseArgs(["--plan", "relative/plan"])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects an out-of-range port", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "65536"]).ok).toBeFalse();
  });

  test("suppresses opening the browser", () => {
    expect(parseArgs(["--plan", "/plan", "--no-open"])).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: false },
    });
  });

  test("uses the default port", () => {
    expect(parseArgs(["--plan", "/plan"])).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: true },
    });
  });
});
