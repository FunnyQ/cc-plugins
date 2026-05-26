// Run: bun test packages/monitor/skills/install/scripts/statusline-decision.test.ts
import { describe, expect, test } from "bun:test";
import { decideStatusLine } from "./statusline-decision";

const COLLECTOR = "bun /plugin/scripts/statusline-collector.ts";
const always = () => true;
const never = () => false;

describe("decideStatusLine", () => {
  test("skips when the current command already runs an existing collector", () => {
    const d = decideStatusLine(
      { command: "bun /old/scripts/statusline-collector.ts" },
      COLLECTOR,
      always,
    );
    expect(d).toEqual({ action: "skip" });
  });

  test("wires fresh when there is no existing statusLine", () => {
    const d = decideStatusLine({}, COLLECTOR, never);
    expect(d).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("preserves a non-collector command by wrapping it via the env var", () => {
    const d = decideStatusLine(
      { command: "starship prompt", padding: 2 },
      COLLECTOR,
      never,
    );
    expect(d).toEqual({
      action: "write",
      command: `TOKEN_ATLAS_STATUSLINE_COMMAND='starship prompt' ${COLLECTOR}`,
      padding: 2,
      preserved: "starship prompt",
    });
  });

  test("replaces a stale collector reference outright (does not wrap it)", () => {
    // References a collector, but the file no longer exists → rewire, don't wrap.
    const d = decideStatusLine(
      { command: "bun /gone/scripts/statusline-collector.ts" },
      COLLECTOR,
      never,
    );
    expect(d).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("defaults padding to 0 when not a number", () => {
    const d = decideStatusLine(
      { command: "x", padding: "nope" },
      COLLECTOR,
      never,
    );
    expect(d.action).toBe("write");
    if (d.action === "write") expect(d.padding).toBe(0);
  });
});
