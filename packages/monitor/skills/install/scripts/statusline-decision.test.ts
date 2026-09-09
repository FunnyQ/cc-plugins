// Run: bun test packages/monitor/skills/install/scripts/statusline-decision.test.ts
import { describe, expect, test } from "bun:test";
import { decideStatusLine, sameCollectorRelease } from "./statusline-decision";

const COLLECTOR = "bun /plugin/scripts/statusline-collector.ts";

const CACHED = (root: string, version: string) =>
  `/h/${root}/plugins/cache/q-lab-marketplace/monitor/${version}/skills/usage-dashboard/scripts/statusline-collector.ts`;

describe("sameCollectorRelease", () => {
  test("same release under Claude's and Codex's cache roots", () => {
    expect(
      sameCollectorRelease(
        CACHED(".codex", "5.0.0"),
        CACHED(".claude", "5.0.0"),
      ),
    ).toBe(true);
  });

  test("different versions are different releases, whatever the root", () => {
    expect(
      sameCollectorRelease(
        CACHED(".codex", "4.9.0"),
        CACHED(".claude", "5.0.0"),
      ),
    ).toBe(false);
  });

  test("falls back to exact equality off the cache path", () => {
    expect(sameCollectorRelease("/repo/a.ts", "/repo/a.ts")).toBe(true);
    expect(sameCollectorRelease("/repo/a.ts", CACHED(".claude", "5.0.0"))).toBe(
      false,
    );
  });
});

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

  test("skips the same release cached under another harness's root", () => {
    const d = decideStatusLine(
      { command: `bun ${CACHED(".codex", "5.0.0")}` },
      `bun ${CACHED(".claude", "5.0.0")}`,
    );
    expect(d).toEqual({ action: "skip" });
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
