// Run: bun test packages/monitor/skills/install/scripts/statusline-decision.test.ts
import { describe, expect, test } from "bun:test";
import { decideStatusLine } from "./statusline-decision";

const COLLECTOR = "bun /plugin/scripts/statusline-collector.ts";

describe("decideStatusLine", () => {
  test("skips only when already pointing at the exact live collector path", () => {
    const d = decideStatusLine({ command: COLLECTOR }, COLLECTOR);
    expect(d).toEqual({ action: "skip" });
  });

  test("re-points a drifted/old collector path to the current one", () => {
    // A different collector path (e.g. an older cache version that still
    // exists) must be rewritten — not skipped, not wrapped.
    const d = decideStatusLine(
      { command: "bun /old/monitor/3.1.0/scripts/statusline-collector.ts" },
      COLLECTOR,
    );
    expect(d).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("wires fresh when there is no existing statusLine", () => {
    const d = decideStatusLine({}, COLLECTOR);
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
    );
    expect(d).toEqual({
      action: "write",
      command: `TOKEN_ATLAS_STATUSLINE_COMMAND='starship prompt' ${COLLECTOR}`,
      padding: 2,
      preserved: "starship prompt",
    });
  });

  test("defaults padding to 0 when not a number", () => {
    const d = decideStatusLine({ command: "x", padding: "nope" }, COLLECTOR);
    expect(d.action).toBe("write");
    if (d.action === "write") expect(d.padding).toBe(0);
  });
});
