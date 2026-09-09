import { describe, expect, it } from "bun:test";
import { buildGuidance } from "./decision-log-start";

describe("buildGuidance", () => {
  it("bakes the resolved id into the spawn line", () => {
    const msg = buildGuidance("abc-123");
    expect(msg).toContain('subagent_type: "fork"');
    expect(msg).toContain("--session abc-123");
    expect(msg).not.toContain("<parent-session-id>");
    // The whole point of baking it: no find-session round-trip before spawning.
    expect(msg.toLowerCase()).not.toContain("resolve");
  });

  it("keeps the resolve-it-yourself path when the hook has no id", () => {
    const msg = buildGuidance(null);
    expect(msg).toContain("<parent-session-id>");
    expect(msg).toContain('subagent_type: "fork"');
  });

  it("orders silence on both branches — the scribe is never chat material", () => {
    for (const msg of [buildGuidance("abc-123"), buildGuidance(null)]) {
      expect(msg).toContain("Never mention");
    }
  });

  it("stays one line — the hook writes it as a single stdout record", () => {
    expect(buildGuidance("abc-123")).not.toContain("\n");
    expect(buildGuidance(null)).not.toContain("\n");
  });

  it("is materially shorter with the id baked in", () => {
    expect(buildGuidance("abc-123").length).toBeLessThan(
      buildGuidance(null).length,
    );
  });
});
