// Run: bun test packages/monitor/skills/usage-dashboard/scripts/api.test.ts
// Importing api.ts is side-effect free — buildStats() only runs under the
// import.meta.main guard — so its pure helpers are unit-testable directly.
import { describe, expect, test } from "bun:test";
import {
  addModelUsage,
  addUsage,
  buildUsageLimitWindow,
  calcCost,
  coerceNumber,
  emptyModelUsage,
  fmtDate,
  isAnthropicModel,
  isExternal,
  modelKey,
  modelUsageTotal,
  normalizeModelId,
  openCodeUsageFromTokens,
  priceFor,
  pricingModelAliases,
  projectName,
  providerFromModelKey,
  rawModelFromKey,
  usageTokenTotal,
  type ModelUsage,
  type PricingTable,
} from "./api";

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  ...emptyModelUsage(),
  ...over,
});

const table: PricingTable = {
  models: {
    "claude-opus": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    // no distinct cache pricing → cache tokens fold into input
    "openai/o3": { input: 2, output: 4, cacheRead: NaN, cacheWrite: NaN },
  },
  fallback: { input: 1, output: 1, cacheRead: NaN, cacheWrite: NaN },
  externalModelPrefixes: ["openai/"],
};

describe("model key helpers", () => {
  test("modelKey namespaces provider:model", () => {
    expect(modelKey("codex", "o3")).toBe("codex:o3");
    expect(modelKey("opencode", "gpt-4.1")).toBe("opencode:gpt-4.1");
  });
  test("providerFromModelKey reads the prefix", () => {
    expect(providerFromModelKey("codex:o3")).toBe("codex");
    expect(providerFromModelKey("opencode:gpt-4.1")).toBe("opencode");
    expect(providerFromModelKey("claude:opus")).toBe("claude");
    expect(providerFromModelKey("opus")).toBe("claude"); // default
  });
  test("rawModelFromKey strips a known provider prefix only", () => {
    expect(rawModelFromKey("codex:o3")).toBe("o3");
    expect(rawModelFromKey("opencode:gpt-4.1")).toBe("gpt-4.1");
    expect(rawModelFromKey("claude:opus")).toBe("opus");
    expect(rawModelFromKey("gpt-4o")).toBe("gpt-4o");
  });
});

describe("token aggregation", () => {
  test("addUsage accumulates snake_case transcript usage", () => {
    const t = emptyModelUsage();
    addUsage(t, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
    });
    addUsage(t, { input_tokens: 1, cache_creation_input_tokens: 3 });
    expect(t).toMatchObject({
      inputTokens: 11,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 3,
    });
  });
  test("usageTokenTotal sums the four billed token kinds", () => {
    expect(
      usageTokenTotal({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    ).toBe(10);
  });
  test("addModelUsage merges including reasoning tokens", () => {
    const t = usage({ inputTokens: 1, reasoningOutputTokens: 2 });
    addModelUsage(t, usage({ inputTokens: 4, reasoningOutputTokens: 8 }));
    expect(t.inputTokens).toBe(5);
    expect(t.reasoningOutputTokens).toBe(10);
    expect(t.costUSD).toBeUndefined();
  });
  test("addModelUsage accumulates recorded costs only when present", () => {
    const t = usage({ inputTokens: 1, costUSD: 0.5 });
    addModelUsage(t, usage({ inputTokens: 4 }));
    addModelUsage(t, usage({ inputTokens: 4, costUSD: 0.25 }));
    expect(t.costUSD).toBeCloseTo(0.75, 5);
  });
  test("modelUsageTotal includes reasoning tokens", () => {
    expect(
      modelUsageTotal(
        usage({
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          reasoningOutputTokens: 5,
        }),
      ),
    ).toBe(15);
  });
  test("openCodeUsageFromTokens maps official token buckets", () => {
    expect(
      openCodeUsageFromTokens({
        input: 10,
        output: 5,
        reasoning: 3,
        cache: { read: 2, write: 1 },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      reasoningOutputTokens: 3,
    });
  });
});

describe("pricing lookup", () => {
  test("pricingModelAliases generates raw + openai/ + prefixed variants", () => {
    const aliases = pricingModelAliases("codex:o3", table);
    expect(aliases).toContain("o3");
    expect(aliases).toContain("openai/o3");
  });
  test("priceFor resolves via alias, falls back when unknown", () => {
    expect(priceFor("codex:o3", table)).toBe(table.models["openai/o3"]);
    expect(priceFor("nope", table)).toBe(table.fallback);
  });
});

describe("normalizeModelId", () => {
  test("strips provider prefix, version dots, and case", () => {
    expect(normalizeModelId("anthropic/claude-opus-4.8")).toBe("claudeopus48");
    expect(normalizeModelId("claude-opus-4-8")).toBe("claudeopus48");
    expect(normalizeModelId("MiniMax-M3")).toBe("minimaxm3");
    expect(normalizeModelId("minimax/minimax-m3")).toBe("minimaxm3");
  });
  test("drops a trailing -YYYYMMDD snapshot date", () => {
    expect(normalizeModelId("claude-opus-4-5-20251101")).toBe("claudeopus45");
    expect(normalizeModelId("moonshotai/kimi-k2.6-20260420")).toBe("kimik26");
  });
  test("drops :tag routing suffixes", () => {
    expect(normalizeModelId("openai/gpt-oss-120b:free")).toBe("gptoss120b");
    expect(normalizeModelId("openai/gpt-oss-120b")).toBe("gptoss120b");
  });
});

describe("priceFor normalized fallback", () => {
  const normTable: PricingTable = {
    models: {
      // Curated entry under the raw name — exact alias must win.
      "claude-opus-4-8": {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6,
      },
      // Live-style OpenRouter ids that only a normalized match can reach.
      "anthropic/claude-sonnet-4.5": {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
      "minimax/minimax-m3:free": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      "minimax/minimax-m3": {
        input: 0.25,
        output: 1,
        cacheRead: 0.025,
        cacheWrite: 0.3,
      },
    },
    fallback: { input: 1, output: 1, cacheRead: NaN, cacheWrite: NaN },
    externalModelPrefixes: ["openai/", "minimax/"],
  };

  test("exact alias wins over a normalized live id", () => {
    // Has a curated default — normalization must not reprice it.
    expect(priceFor("claude:claude-opus-4-8", normTable)).toBe(
      normTable.models["claude-opus-4-8"],
    );
  });
  test("normalized fallback bridges dash↔dot + provider prefix + date", () => {
    expect(priceFor("claude:claude-sonnet-4-5-20250929", normTable)).toBe(
      normTable.models["anthropic/claude-sonnet-4.5"],
    );
  });
  test("prefers the canonical id over a $0 :free routing variant", () => {
    expect(priceFor("opencode:MiniMax-M3", normTable)).toBe(
      normTable.models["minimax/minimax-m3"],
    );
  });
  test("still falls back when nothing matches", () => {
    expect(priceFor("claude:utterly-unknown-xyz", normTable)).toBe(
      normTable.fallback,
    );
  });
});

describe("calcCost", () => {
  test("uses distinct cache pricing when available (per 1M tokens)", () => {
    const cost = calcCost(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
      "claude-opus",
      table,
    );
    // 3 + 15 + 0.3 + 3.75
    expect(cost).toBeCloseTo(22.05, 5);
  });
  test("folds cache tokens into input when no cache pricing exists", () => {
    const cost = calcCost(
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
      "codex:o3",
      table,
    );
    // (1M + 1M + 1M) input × 2 + 1M output × 4 = 6 + 4
    expect(cost).toBeCloseTo(10, 5);
  });
});

describe("coerceNumber", () => {
  test("passes finite numbers, parses numeric strings, rejects junk", () => {
    expect(coerceNumber(42)).toBe(42);
    expect(coerceNumber(" 3.5 ")).toBe(3.5);
    expect(coerceNumber("nope")).toBeNull();
    expect(coerceNumber(null)).toBeNull();
    expect(coerceNumber(Infinity)).toBeNull();
  });
});

describe("buildUsageLimitWindow", () => {
  test("returns null when there is no bucket", () => {
    expect(buildUsageLimitWindow(null, 1000, 0)).toBeNull();
  });
  test("computes elapsed/remaining from resets_at and duration", () => {
    // resets_at in seconds → resetMs = 1_000_000; duration 1000ms;
    // start = 999_000; now = 999_500 → halfway through the window.
    const w = buildUsageLimitWindow(
      { used_percentage: "50", resets_at: 1000 },
      1000,
      999_500,
    );
    expect(w).toEqual({
      usedPercent: 50,
      resetAt: new Date(1_000_000).toISOString(),
      elapsedPercent: 50,
      remainingMs: 500,
    });
  });
  test("null resets_at yields a partial window", () => {
    const w = buildUsageLimitWindow({ used_percentage: 12 }, 1000, 0);
    expect(w).toEqual({
      usedPercent: 12,
      resetAt: null,
      elapsedPercent: null,
      remainingMs: null,
    });
  });
});

describe("misc helpers", () => {
  test("isAnthropicModel / isExternal", () => {
    expect(isAnthropicModel("claude-opus-4-7")).toBe(true);
    expect(isAnthropicModel("anthropic/claude-3")).toBe(true);
    expect(isAnthropicModel("gpt-4o")).toBe(false);
    expect(isExternal("gpt-4o", ["openai/"])).toBe(true);
    expect(isExternal("claude-opus", ["openai/"])).toBe(false);
    expect(isExternal("anthropic/claude-3", ["anthropic/"])).toBe(true);
  });
  test("fmtDate formats local YYYY-MM-DD, empty for 0", () => {
    expect(fmtDate(0)).toBe("");
    // Local-time construction so the assertion is timezone-independent.
    const ms = new Date(2026, 4, 25).getTime();
    expect(fmtDate(ms)).toBe("2026-05-25");
  });
  test("projectName takes the last path segment", () => {
    expect(projectName("/Users/q/Projects/cc-plugins")).toBe("cc-plugins");
    expect(projectName("/Users/q/foo/")).toBe("foo");
  });
});
