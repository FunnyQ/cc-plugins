import { describe, expect, test } from "bun:test";

import { planLine } from "../../skills/autopilot/scripts/launch.ts";
import { FLIGHTDECK_COMMAND, planArg, planFromOutput } from "./deck-command.ts";

describe("FLIGHTDECK_COMMAND", () => {
  test.each([
    `bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"`,
    `bun "/abs/autopilot/scripts/flightdeck.ts" --plan "/abs/run"`,
    `bun flightdeck.ts --plan=/abs/y`,
    `bun flightdeck.ts --plan '/a b'`,
    `cd /repo && bun flightdeck.ts --no-open --plan /abs/z`,
  ])("matches %s", (command) => {
    expect(FLIGHTDECK_COMMAND.test(command)).toBe(true);
  });

  test.each([
    `bun flightdeck.test.ts`,
    `bun test flightdeck.test.ts --plan /abs/x`,
    `bun flightdeck.ts`,
    `bun myflightdeck.ts --plan /abs/x`,
    `bun flightdeck.tsx --plan /abs/x`,
    `bun flightdeck.ts --planned /abs/x`,
  ])("rejects %s", (command) => {
    expect(FLIGHTDECK_COMMAND.test(command)).toBe(false);
  });
});

describe("planArg", () => {
  test.each([
    [`bun "$OWN"/flightdeck.ts --plan "/abs/docs/x"`, "/abs/docs/x"],
    [
      `bun "/abs/autopilot/scripts/flightdeck.ts" --plan "/abs/run"`,
      "/abs/run",
    ],
    [`bun flightdeck.ts --plan=/abs/y`, "/abs/y"],
    [`bun flightdeck.ts --plan '/a b'`, "/a b"],
    [`bun flightdeck.ts --plan /abs/z --no-open`, "/abs/z"],
    [`bun flightdeck.ts --plan="/a c"`, "/a c"],
  ])("%s → %s", (command, plan) => {
    expect(planArg(command)).toBe(plan);
  });

  test("reads the --plan of the flightdeck.ts call, not an earlier command's", () => {
    expect(
      planArg("bun prepare.ts --plan /abs/a && bun flightdeck.ts --plan /abs/b"),
    ).toBe("/abs/b");
    expect(
      planArg("bun flightdeck.ts --no-open; bun other.ts --plan /abs/a"),
    ).toBeNull();
  });

  test("is null for an unexpanded shell value", () => {
    expect(planArg(`bun flightdeck.ts --plan "$PLAN"`)).toBeNull();
    expect(planArg("bun flightdeck.ts --plan $(pwd)/docs/x")).toBeNull();
  });

  test("is null without --plan", () => {
    expect(planArg("bun flightdeck.ts")).toBeNull();
    expect(planArg("bun flightdeck.ts --planned /abs/x")).toBeNull();
  });
});

describe("planFromOutput", () => {
  test("reads the launcher's plan line out of a compound command's output", () => {
    const stdout = `http://localhost:5757/\n${planLine("/abs/docs/x")}\n/abs/docs/x/.flightlog/orchestrator.js\n`;
    expect(planFromOutput(stdout)).toBe("/abs/docs/x");
  });

  test("a path with spaces survives the round trip", () => {
    expect(planFromOutput(planLine("/a b/docs/x"))).toBe("/a b/docs/x");
  });

  test("no plan line, no plan", () => {
    expect(planFromOutput("http://localhost:5757/\n")).toBeNull();
    expect(planFromOutput("")).toBeNull();
  });
});
