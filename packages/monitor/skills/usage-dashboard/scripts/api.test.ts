// Run: bun test packages/monitor/skills/usage-dashboard/scripts/api.test.ts
// Importing api.ts is side-effect free — buildStats() only runs under the
// import.meta.main guard — so its pure helpers are unit-testable directly.
import { describe, expect, test } from "bun:test";
import {
  addModelUsage,
  addUsage,
  buildCodexUsageLimits,
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
      durationMs: 1000,
    });
  });
  test("null resets_at yields a partial window", () => {
    const w = buildUsageLimitWindow({ used_percentage: 12 }, 1000, 0);
    expect(w).toEqual({
      usedPercent: 12,
      resetAt: null,
      elapsedPercent: null,
      remainingMs: null,
      // Known even without resets_at: the caller supplied it.
      durationMs: 1000,
    });
  });
});

describe("buildCodexUsageLimits window slotting", () => {
  // A fixed clock: buildCodexUsageLimits takes nowMs, so nothing here depends
  // on how long the test takes to run.
  const NOW_MS = 1_787_254_275_000; // 2026-08-20T19:31:15Z, on a whole second
  const bucket = (
    windowSeconds: number | null,
    usedPercent: number,
    resetsInSeconds: number,
  ) => ({
    used_percent: usedPercent,
    reset_at: Math.floor(NOW_MS / 1000) + resetsInSeconds,
    ...(windowSeconds === null ? {} : { limit_window_seconds: windowSeconds }),
  });
  const build = (usage: Parameters<typeof buildCodexUsageLimits>[0]) =>
    buildCodexUsageLimits(usage, null, NOW_MS, null, NOW_MS);

  test("a weekly-length primary_window lands in weekly, not fiveHour", () => {
    // OpenAI dropped Codex's 5-hour limit, so the one bucket it still returns
    // arrives as primary_window while describing a 7-day window. This is the
    // live payload shape, secondary_window explicitly null and all.
    const limits = build({
      plan_type: "prolite",
      rate_limit: {
        primary_window: bucket(604800, 1, 561600),
        secondary_window: null,
      },
    });
    expect(limits.fiveHour).toBeNull();
    expect(limits.weekly?.usedPercent).toBe(1);
    expect(limits.error).toBeNull();
    // Elapsed math must use the 7-day length, not a 5-hour one.
    expect(limits.weekly?.remainingMs).toBe(561_600_000);
    expect(limits.weekly?.elapsedPercent).toBeCloseTo(7.14, 2);
    // The window reports its own length, so the label need not trust the slot.
    expect(limits.weekly?.durationMs).toBe(604_800_000);
  });

  test("both windows are kept when the API reports both lengths", () => {
    const limits = build({
      rate_limit: {
        primary_window: bucket(18000, 40, 3600),
        secondary_window: bucket(604800, 12, 432000),
      },
    });
    expect(limits.fiveHour?.usedPercent).toBe(40);
    expect(limits.weekly?.usedPercent).toBe(12);
  });

  test("slots by length even when the API swaps the two fields", () => {
    const limits = build({
      rate_limit: {
        primary_window: bucket(604800, 12, 432000),
        secondary_window: bucket(18000, 40, 3600),
      },
    });
    expect(limits.fiveHour?.usedPercent).toBe(40);
    expect(limits.weekly?.usedPercent).toBe(12);
  });

  test("falls back to slot position when limit_window_seconds is absent", () => {
    const limits = build({
      rate_limit: {
        primary_window: bucket(null, 7, 3600),
        secondary_window: bucket(null, 3, 432000),
      },
    });
    expect(limits.fiveHour?.usedPercent).toBe(7);
    expect(limits.weekly?.usedPercent).toBe(3);
  });

  test("keeps the first bucket and drops the second when both share a slot", () => {
    // Unreachable today — the API returns at most one weekly window. Locked so
    // the collision stays deterministic rather than accidental.
    const limits = build({
      rate_limit: {
        primary_window: bucket(604800, 12, 432000),
        secondary_window: bucket(2592000, 88, 2000000),
      },
    });
    expect(limits.weekly?.usedPercent).toBe(12);
    expect(limits.fiveHour).toBeNull();
  });

  test("carries a duration no slot name describes", () => {
    // A 30-day window lands in the weekly slot but must not claim to be weekly.
    const limits = build({
      rate_limit: { primary_window: bucket(2592000, 4, 2000000) },
    });
    expect(limits.weekly?.durationMs).toBe(2_592_000_000);
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
