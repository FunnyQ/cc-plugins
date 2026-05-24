// Run: bun test packages/monitor/skills/usage-dashboard/scripts/project-cost.test.ts
import { describe, expect, test } from "bun:test";
import { aggregateProjectCosts } from "./project-cost";
import type { ModelUsage } from "./api";

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...over,
});

// Cost = number of models for claude, 10x number of models for codex — makes
// the per-project sums easy to assert and proves which fn was applied where.
const claudeCost = () => 1;
const codexCost = () => 10;

describe("aggregateProjectCosts", () => {
  test("sums each model's cost per project, per provider", () => {
    const claude = new Map([
      [
        "/p1",
        new Map([
          ["m1", usage()],
          ["m2", usage()],
        ]),
      ],
    ]);
    const codex = new Map([["/p1", new Map([["o3", usage()]])]]);
    const { projectCost, claudeProjectCost, codexProjectCost } =
      aggregateProjectCosts(claude, codex, claudeCost, codexCost);

    expect(claudeProjectCost.get("/p1")).toBe(2); // two claude models × 1
    expect(codexProjectCost.get("/p1")).toBe(10); // one codex model × 10
    expect(projectCost.get("/p1")).toBe(12); // combined
  });

  test("a project seen by only one provider still lands in the combined map", () => {
    const claude = new Map([["/only-claude", new Map([["m", usage()]])]]);
    const codex = new Map([["/only-codex", new Map([["o3", usage()]])]]);
    const { projectCost } = aggregateProjectCosts(
      claude,
      codex,
      claudeCost,
      codexCost,
    );
    expect(projectCost.get("/only-claude")).toBe(1);
    expect(projectCost.get("/only-codex")).toBe(10);
  });

  test("empty inputs yield empty maps", () => {
    const { projectCost } = aggregateProjectCosts(
      new Map(),
      new Map(),
      claudeCost,
      codexCost,
    );
    expect(projectCost.size).toBe(0);
  });
});
