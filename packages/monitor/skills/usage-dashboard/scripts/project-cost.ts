// Per-project cost aggregation across both providers. Extracted from buildStats
// so the "sum each model's cost, then combine claude + codex per project" logic
// is testable without the filesystem/pricing pipeline. The actual cost function
// is injected (api.ts passes calcCost bound to the loaded pricing table) — that
// keeps this module pure and avoids importing back into api.ts at runtime.
import type { ModelUsage } from "./api";

export type ProjectModelUsage = Map<string, Map<string, ModelUsage>>;

export type ProjectCosts = {
  // path -> combined (claude + codex) USD
  projectCost: Map<string, number>;
  claudeProjectCost: Map<string, number>;
  codexProjectCost: Map<string, number>;
};

// `claudeCost` / `codexCost` map a (model, usage) pair to USD. They differ
// because codex model keys are namespaced and must be stripped before pricing
// lookup — api.ts bakes that into the codex function it passes in.
export function aggregateProjectCosts(
  claudeUsage: ProjectModelUsage,
  codexUsage: ProjectModelUsage,
  claudeCost: (model: string, usage: ModelUsage) => number,
  codexCost: (model: string, usage: ModelUsage) => number,
): ProjectCosts {
  const projectCost = new Map<string, number>();
  const claudeProjectCost = new Map<string, number>();
  const codexProjectCost = new Map<string, number>();

  for (const [path, byModel] of claudeUsage.entries()) {
    let costUSD = 0;
    for (const [model, usage] of byModel.entries()) {
      costUSD += claudeCost(model, usage);
    }
    claudeProjectCost.set(path, costUSD);
    projectCost.set(path, costUSD);
  }

  for (const [path, byModel] of codexUsage.entries()) {
    let costUSD = 0;
    for (const [model, usage] of byModel.entries()) {
      costUSD += codexCost(model, usage);
    }
    codexProjectCost.set(path, costUSD);
    projectCost.set(path, (projectCost.get(path) ?? 0) + costUSD);
  }

  return { projectCost, claudeProjectCost, codexProjectCost };
}
