import { describe, expect, test } from "bun:test";

import { FLIGHTDECK_COMMAND, planArg } from "./deck-command.ts";

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

  test("is null without --plan", () => {
    expect(planArg("bun flightdeck.ts")).toBeNull();
    expect(planArg("bun flightdeck.ts --planned /abs/x")).toBeNull();
  });
});
