#!/usr/bin/env bun
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { dedupKey } from "./dedup";
import { aggregateProjectCosts } from "./project-cost";
import { mergeDailyActivity } from "./daily-activity";
import { allHourlyRows, openRollupDb } from "./rollup-db";
import { updateRollup } from "./rollup-update";
import { openCodeTimestampMs } from "../../shared/scripts/opencode";
import { readSessionFiles } from "./session-files";
import { projectNameFor } from "./live-sessions";
import {
  CODEX_AUTH,
  CODEX_SESSIONS_DIR,
  CODEX_STATE_DB,
  HISTORY,
  HOME,
  OPENCODE_DB,
  OPENCODE_PROJECT_DIR,
  OPENCODE_STORAGE_DIR,
  PROJECTS_DIR,
  SESSIONS_DIR,
  STATS_CACHE,
} from "./paths";
const PRICING_DEFAULTS = join(
  import.meta.dir,
  "..",
  "references",
  "pricing-defaults.json",
);
const USER_PRICING_OVERRIDE = join(
  HOME,
  ".config",
  "cc-dashboard",
  "pricing.json",
);
const USER_BUDGET_CONFIG = join(HOME, ".config", "cc-dashboard", "budget.json");
const TOKEN_ATLAS_CACHE_DIR = join(HOME, ".cache", "token-atlas");
const RATE_LIMITS_CACHE = join(TOKEN_ATLAS_CACHE_DIR, "rate-limits.json");
const CODEX_USAGE_CACHE = join(
  TOKEN_ATLAS_CACHE_DIR,
  "codex-usage-limits.json",
);
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const RATE_LIMITS_STALE_AFTER_MS = 5 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- Types ----------

export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
export type PricingTable = {
  models: Record<string, ModelPrice>;
  fallback: ModelPrice;
  externalModelPrefixes: string[];
};
type PricingSource = "default" | "live" | "override";
type PricingMeta = {
  defaultsLoaded: boolean;
  openRouter: {
    attempted: boolean;
    used: boolean;
    error: string | null;
  };
  userOverride: {
    path: string;
    loaded: boolean;
    error: string | null;
  };
  models: {
    priced: number;
    default: number;
    fallback: number;
    fallbackModels: string[];
  };
};
type PricingLoad = {
  table: PricingTable;
  meta: PricingMeta;
  sourceByModel: Record<string, PricingSource>;
};
type BudgetConfig = {
  monthlyBudgetUSD?: number;
};
type BudgetMeta = {
  monthlyBudgetUSD: number | null;
  source: string;
  loaded: boolean;
  error: string | null;
};
type RateLimitBucket = {
  used_percentage?: number | string | null;
  resets_at?: number | string | null;
};
type RateLimitsCache = {
  capturedAt?: string;
  capturedAtEpochMs?: number;
  rate_limits?: {
    five_hour?: RateLimitBucket | null;
    seven_day?: RateLimitBucket | null;
  } | null;
};
type UsageLimitWindow = {
  usedPercent: number | null;
  resetAt: string | null;
  elapsedPercent: number | null;
  remainingMs: number | null;
};
type UsageLimits = {
  source: string;
  path: string;
  capturedAt: string | null;
  stale: boolean;
  error: string | null;
  plan?: string | null;
  fiveHour: UsageLimitWindow | null;
  weekly: UsageLimitWindow | null;
};
type CodexAuth = {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
};
type CodexApiRateLimitBucket = {
  used_percent?: number | string | null;
  reset_at?: number | string | null;
  limit_window_seconds?: number | string | null;
};
type CodexApiUsage = {
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: CodexApiRateLimitBucket | null;
    secondary_window?: CodexApiRateLimitBucket | null;
  } | null;
};
type CodexUsageCache = {
  capturedAt?: string;
  capturedAtEpochMs?: number;
  usage?: CodexApiUsage | null;
};

type DataHealthSourceStatus = "ok" | "missing" | "unreadable" | "empty";
type DataHealthSource = {
  name: string;
  path: string;
  status: DataHealthSourceStatus;
  modifiedAt: string | null;
  note: string;
};
type DataHealth = {
  sources: DataHealthSource[];
  counts: {
    claudeTranscriptFiles: number;
    codexSessionFiles: number;
    codexThreadRows: number;
    openCodeSessionFiles: number;
    openCodeMessageFiles: number;
    openCodeSessionRows: number;
    openCodeMessageRows: number;
  };
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
};

export type Provider = "claude" | "codex" | "opencode";
type LedgerCostBasis = "usage" | "thread_tokens" | "unavailable";
type LedgerRow = {
  id: string;
  provider: Provider;
  timestampMs: number;
  date: string;
  projectPath: string;
  projectName: string;
  model: string;
  interactions: number;
  toolCalls: number;
  tokens: number;
  costUSD: number | null;
  costBasis: LedgerCostBasis;
  usageByModel?: Record<string, SerializedModelUsage>;
};
type InternalLedgerRow = Omit<LedgerRow, "costUSD"> & {
  usageByModel: Map<string, ModelUsage>;
};
type SerializedModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUSD: number;
  provider: Provider;
  isExternal: boolean;
};
type HourlyUsageBucket = {
  timestampMs: number;
  usageByModel: Map<string, ModelUsage>;
};

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  cwd: string;
  title: string;
  model: string | null;
  tokens_used: number;
};

type CodexTokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

type CodexSessionSummary = {
  id: string | null;
  timestampMs: number;
  cwd: string;
  model: string | null;
  tokenUsage: CodexTokenUsage | null;
  tokenEvents: Array<{ timestampMs: number; usage: CodexTokenUsage }>;
  userMessages: number;
  toolCalls: number;
};

type OpenCodeTokenUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
};

type OpenCodeSession = {
  id?: string;
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  title?: string;
};

type OpenCodeMessage = {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  modelID?: string;
  providerID?: string;
  path?: {
    cwd?: string;
    root?: string;
  };
  cost?: number;
  tokens?: OpenCodeTokenUsage;
};

type OpenCodeStoredMessage = {
  info?: OpenCodeMessage;
  parts?: Array<{ type?: string }>;
} & OpenCodeMessage;

type OpenCodeSessionRow = {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
};

type OpenCodeMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

type StatsCache = {
  version?: number;
  lastComputedDate?: string;
  dailyActivity?: Array<{
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }>;
  dailyModelTokens?: Array<{
    date: string;
    tokensByModel: Record<string, number>;
  }>;
  modelUsage?: Record<string, ModelUsage>;
  hourCounts?: Record<string, number>;
  totalSessions?: number;
  totalMessages?: number;
  longestSession?: {
    sessionId: string;
    duration: number;
    messageCount: number;
    timestamp: string;
  };
  firstSessionDate?: string;
};

type HistoryEntry = {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
};
export type TranscriptUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type TranscriptEntry = {
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  sessionId?: string;
  type?: string;
  cwd?: string;
  isMeta?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: TranscriptUsage;
    content?: unknown;
  };
};

// ---------- Utils ----------

function safeReadJSON<T>(path: string): T | null {
  const result = readJSONWithError<T>(path);
  return result.data;
}

function safeParseJSON<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function readJSONWithError<T>(path: string): {
  exists: boolean;
  data: T | null;
  error: string | null;
} {
  try {
    if (!existsSync(path)) return { exists: false, data: null, error: null };
    return {
      exists: true,
      data: JSON.parse(readFileSync(path, "utf-8")) as T,
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      data: null,
      error: err instanceof Error ? err.message : "Unreadable JSON",
    };
  }
}

export function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("anthropic/claude-");
}

export function isExternal(model: string, prefixes: string[]): boolean {
  return !isAnthropicModel(model) || prefixes.some((p) => model.startsWith(p));
}

function displayPath(path: string): string {
  return path.replace(HOME, "~");
}

function sourceHealth(
  name: string,
  path: string,
  note: string,
): DataHealthSource {
  try {
    if (!existsSync(path)) {
      return {
        name,
        path: displayPath(path),
        status: "missing",
        modifiedAt: null,
        note,
      };
    }
    accessSync(path, constants.R_OK);
    const stat = statSync(path);
    let status: DataHealthSourceStatus = "ok";
    if (stat.isFile() && stat.size === 0) status = "empty";
    if (stat.isDirectory() && readdirSync(path).length === 0) status = "empty";
    return {
      name,
      path: displayPath(path),
      status,
      modifiedAt: stat.mtime.toISOString(),
      note,
    };
  } catch (err) {
    return {
      name,
      path: displayPath(path),
      status: "unreadable",
      modifiedAt: null,
      note: err instanceof Error ? err.message : note,
    };
  }
}

function buildDataHealth(counts: DataHealth["counts"]): DataHealth {
  return {
    sources: [
      sourceHealth("Claude stats cache", STATS_CACHE, "required"),
      sourceHealth("Claude history", HISTORY, "optional activity timeline"),
      sourceHealth("Claude sessions", SESSIONS_DIR, "optional session records"),
      sourceHealth(
        "Claude projects",
        PROJECTS_DIR,
        "optional transcript records",
      ),
      sourceHealth("Codex state DB", CODEX_STATE_DB, "optional thread index"),
      sourceHealth(
        "Codex sessions",
        CODEX_SESSIONS_DIR,
        "optional rollout records",
      ),
      sourceHealth(
        "Codex usage cache",
        CODEX_USAGE_CACHE,
        "optional live limit cache",
      ),
      sourceHealth(
        "OpenCode storage",
        OPENCODE_STORAGE_DIR,
        "optional root storage",
      ),
      sourceHealth("OpenCode database", OPENCODE_DB, "optional SQLite usage"),
      sourceHealth(
        "OpenCode projects",
        OPENCODE_PROJECT_DIR,
        "optional project storage",
      ),
      sourceHealth(
        "Pricing override",
        USER_PRICING_OVERRIDE,
        "optional user pricing",
      ),
      sourceHealth("Budget config", USER_BUDGET_CONFIG, "optional budget"),
    ],
    counts,
  };
}

function loadBudgetConfig(): BudgetMeta {
  const budget = readJSONWithError<BudgetConfig>(USER_BUDGET_CONFIG);
  const source = displayPath(USER_BUDGET_CONFIG);
  if (!budget.exists) {
    return {
      monthlyBudgetUSD: null,
      source,
      loaded: false,
      error: null,
    };
  }
  if (budget.error) {
    return {
      monthlyBudgetUSD: null,
      source,
      loaded: false,
      error: budget.error,
    };
  }
  const monthlyBudgetUSD = budget.data?.monthlyBudgetUSD;
  if (
    typeof monthlyBudgetUSD !== "number" ||
    !Number.isFinite(monthlyBudgetUSD) ||
    monthlyBudgetUSD <= 0
  ) {
    return {
      monthlyBudgetUSD: null,
      source,
      loaded: false,
      error: "Expected positive numeric monthlyBudgetUSD",
    };
  }
  return {
    monthlyBudgetUSD,
    source,
    loaded: true,
    error: null,
  };
}

export function coerceNumber(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildUsageLimitWindow(
  bucket: RateLimitBucket | null | undefined,
  durationMs: number,
  nowMs: number,
): UsageLimitWindow | null {
  if (!bucket) return null;

  const usedPercent = coerceNumber(bucket.used_percentage);
  const resetAtSeconds = coerceNumber(bucket.resets_at);
  if (resetAtSeconds === null) {
    return {
      usedPercent,
      resetAt: null,
      elapsedPercent: null,
      remainingMs: null,
    };
  }

  const resetAtMs = resetAtSeconds * 1000;
  const resetAt = new Date(resetAtMs).toISOString();
  const startAtMs = resetAtMs - durationMs;
  const elapsedMs = Math.max(0, Math.min(durationMs, nowMs - startAtMs));
  const remainingMs = durationMs - elapsedMs;

  return {
    usedPercent,
    resetAt,
    elapsedPercent: (elapsedMs / durationMs) * 100,
    remainingMs,
  };
}

function readUsageLimits(): UsageLimits {
  const cache = readJSONWithError<RateLimitsCache>(RATE_LIMITS_CACHE);
  const base = {
    source: "statusline-cache",
    path: displayPath(RATE_LIMITS_CACHE),
    capturedAt: null,
    stale: true,
    error: null,
    fiveHour: null,
    weekly: null,
  };

  if (!cache.exists) {
    return {
      ...base,
      error: "missing",
    };
  }

  if (cache.error || !cache.data) {
    return {
      ...base,
      error: cache.error ?? "unreadable",
    };
  }

  const capturedAtMs =
    cache.data.capturedAtEpochMs ??
    (cache.data.capturedAt ? Date.parse(cache.data.capturedAt) : Number.NaN);
  const nowMs = Date.now();
  const stale =
    !Number.isFinite(capturedAtMs) ||
    nowMs - capturedAtMs > RATE_LIMITS_STALE_AFTER_MS;
  const rateLimits = cache.data.rate_limits;

  if (!rateLimits) {
    return {
      ...base,
      capturedAt: cache.data.capturedAt ?? null,
      stale,
      error: "missing-rate-limits",
    };
  }

  return {
    ...base,
    capturedAt: cache.data.capturedAt ?? null,
    stale,
    error: null,
    fiveHour: buildUsageLimitWindow(rateLimits.five_hour, FIVE_HOUR_MS, nowMs),
    weekly: buildUsageLimitWindow(rateLimits.seven_day, SEVEN_DAY_MS, nowMs),
  };
}

function codexUsageBase(error: string | null = null): UsageLimits {
  return {
    source: "codex-api",
    path: displayPath(CODEX_USAGE_CACHE),
    capturedAt: null,
    stale: true,
    error,
    plan: null,
    fiveHour: null,
    weekly: null,
  };
}

function buildCodexUsageLimits(
  usage: CodexApiUsage | null | undefined,
  capturedAt: string | null,
  capturedAtMs: number,
  error: string | null,
): UsageLimits {
  const nowMs = Date.now();
  const rateLimit = usage?.rate_limit;
  const primary = rateLimit?.primary_window ?? null;
  const secondary = rateLimit?.secondary_window ?? null;
  const nextError =
    error ?? (!primary && !secondary ? "missing-rate-limits" : null);
  const primaryDurationMs =
    (coerceNumber(primary?.limit_window_seconds) ?? 5 * 60 * 60) * 1000;
  const secondaryDurationMs =
    (coerceNumber(secondary?.limit_window_seconds) ?? 7 * 24 * 60 * 60) * 1000;

  return {
    ...codexUsageBase(nextError),
    capturedAt,
    stale:
      !Number.isFinite(capturedAtMs) ||
      nowMs - capturedAtMs > RATE_LIMITS_STALE_AFTER_MS,
    plan: usage?.plan_type ?? null,
    fiveHour: primary
      ? buildUsageLimitWindow(
          {
            used_percentage: primary.used_percent,
            resets_at: primary.reset_at,
          },
          primaryDurationMs,
          nowMs,
        )
      : null,
    weekly: secondary
      ? buildUsageLimitWindow(
          {
            used_percentage: secondary.used_percent,
            resets_at: secondary.reset_at,
          },
          secondaryDurationMs,
          nowMs,
        )
      : null,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCodexAccessToken(auth: CodexAuth): Promise<string> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) throw new Error("missing-refresh-token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
  const res = await fetchWithTimeout(
    CODEX_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    4000,
  );
  if (!res.ok) throw new Error(`refresh-http-${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("missing-refreshed-access-token");
  return json.access_token;
}

async function fetchCodexUsageWithToken(
  accessToken: string,
  accountId: string,
): Promise<CodexApiUsage> {
  const res = await fetchWithTimeout(
    CODEX_USAGE_URL,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "chatgpt-account-id": accountId,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    },
    4000,
  );
  if (!res.ok) throw new Error(`http-${res.status}`);
  return (await res.json()) as CodexApiUsage;
}

async function fetchCodexUsage(): Promise<CodexApiUsage> {
  const auth = readJSONWithError<CodexAuth>(CODEX_AUTH);
  if (!auth.exists) throw new Error("missing-auth");
  if (auth.error || !auth.data)
    throw new Error(auth.error ?? "unreadable-auth");

  const accessToken = auth.data.tokens?.access_token;
  if (!accessToken) throw new Error("missing-access-token");
  const accountId = auth.data.tokens?.account_id ?? "";

  try {
    return await fetchCodexUsageWithToken(accessToken, accountId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (!message.includes("http-401") && !message.includes("http-403")) {
      throw err;
    }
    const refreshed = await refreshCodexAccessToken(auth.data);
    return await fetchCodexUsageWithToken(refreshed, accountId);
  }
}

function readCodexUsageCache(): UsageLimits {
  const cache = readJSONWithError<CodexUsageCache>(CODEX_USAGE_CACHE);
  if (!cache.exists) return codexUsageBase("missing");
  if (cache.error || !cache.data) {
    return codexUsageBase(cache.error ?? "unreadable");
  }

  const capturedAtMs =
    cache.data.capturedAtEpochMs ??
    (cache.data.capturedAt ? Date.parse(cache.data.capturedAt) : Number.NaN);
  return buildCodexUsageLimits(
    cache.data.usage,
    cache.data.capturedAt ?? null,
    capturedAtMs,
    null,
  );
}

async function readCodexUsageLimits(): Promise<UsageLimits> {
  const cached = readCodexUsageCache();
  if (!cached.stale && !cached.error) return cached;

  try {
    const usage = await fetchCodexUsage();
    const capturedAtEpochMs = Date.now();
    const cache: CodexUsageCache = {
      capturedAt: new Date(capturedAtEpochMs).toISOString(),
      capturedAtEpochMs,
      usage,
    };
    mkdirSync(TOKEN_ATLAS_CACHE_DIR, { recursive: true });
    writeFileSync(CODEX_USAGE_CACHE, `${JSON.stringify(cache, null, 2)}\n`);
    return buildCodexUsageLimits(
      usage,
      cache.capturedAt ?? null,
      capturedAtEpochMs,
      null,
    );
  } catch (err) {
    if (cached.capturedAt) {
      return {
        ...cached,
        stale: true,
        error: err instanceof Error ? err.message : "fetch-failed",
      };
    }
    return codexUsageBase(err instanceof Error ? err.message : "fetch-failed");
  }
}

// ---------- Pricing ----------

let pricingCache: Promise<PricingLoad> | null = null;

function clonePricingTable(table: PricingTable): PricingTable {
  return {
    models: { ...table.models },
    fallback: { ...table.fallback },
    externalModelPrefixes: [...table.externalModelPrefixes],
  };
}

type OpenRouterPricing = {
  models: Record<string, ModelPrice>;
  error: string | null;
};

// Fetch live per-model pricing from OpenRouter. Keys are OpenRouter model ids
// (e.g. "anthropic/claude-opus-4", "minimax/minimax-m3") — harness-agnostic.
// Failures are reported via `error`, never thrown.
async function fetchOpenRouterPricing(
  timeoutMs = 3000,
): Promise<OpenRouterPricing> {
  const models: Record<string, ModelPrice> = {};
  let error: string | null = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(OPENROUTER_URL, { signal: ctrl.signal });
    if (res.ok) {
      const json = (await res.json()) as {
        data?: Array<{
          id: string;
          pricing?: {
            prompt?: string;
            completion?: string;
            input_cache_read?: string;
            input_cache_write?: string;
          };
        }>;
      };
      for (const m of json.data ?? []) {
        const p = m.pricing;
        if (!p?.prompt || !p?.completion) continue;
        // OpenRouter pricing is per token, multiply by 1M
        const input = parseFloat(p.prompt) * 1_000_000;
        const output = parseFloat(p.completion) * 1_000_000;
        const cacheRead = p.input_cache_read
          ? parseFloat(p.input_cache_read) * 1_000_000
          : input * 0.1;
        const cacheWrite = p.input_cache_write
          ? parseFloat(p.input_cache_write) * 1_000_000
          : input * 1.25;
        if (Number.isFinite(input) && Number.isFinite(output)) {
          models[m.id] = { input, output, cacheRead, cacheWrite };
        }
      }
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch (err) {
    error =
      err instanceof Error ? err.name || err.message : "OpenRouter failed";
  } finally {
    clearTimeout(timer);
  }
  return { models, error };
}

async function loadPricingWithMeta(): Promise<PricingLoad> {
  if (pricingCache) return pricingCache;
  pricingCache = (async () => {
    const defaults = safeReadJSON<PricingTable>(PRICING_DEFAULTS);
    if (!defaults)
      throw new Error(`Missing pricing defaults: ${PRICING_DEFAULTS}`);
    const table = clonePricingTable(defaults);
    const sourceByModel: Record<string, PricingSource> = Object.fromEntries(
      Object.keys(table.models).map((model) => [model, "default" as const]),
    );
    const meta: PricingMeta = {
      defaultsLoaded: true,
      openRouter: {
        attempted: true,
        used: false,
        error: null,
      },
      userOverride: {
        path: USER_PRICING_OVERRIDE.replace(HOME, "~"),
        loaded: false,
        error: null,
      },
      models: {
        priced: 0,
        default: 0,
        fallback: 0,
        fallbackModels: [],
      },
    };

    // Try OpenRouter. Failures are non-fatal; defaults remain the basis.
    const live = await fetchOpenRouterPricing(3000);
    meta.openRouter.error = live.error;
    for (const [id, price] of Object.entries(live.models)) {
      table.models[id] = price;
      sourceByModel[id] = "live";
      meta.openRouter.used = true;
    }

    // User override last (highest priority)
    const override = readJSONWithError<{ models?: Record<string, ModelPrice> }>(
      USER_PRICING_OVERRIDE,
    );
    meta.userOverride.error = override.error;
    meta.userOverride.loaded = override.exists && !override.error;
    if (override.data?.models) {
      for (const [k, v] of Object.entries(override.data.models)) {
        table.models[k] = v;
        sourceByModel[k] = "override";
      }
    }

    return { table, meta, sourceByModel };
  })();
  return pricingCache;
}

async function loadPricing(): Promise<PricingTable> {
  return (await loadPricingWithMeta()).table;
}

export function pricingModelAliases(
  model: string,
  table: PricingTable,
): string[] {
  const raw = rawModelFromKey(model);
  const aliases = new Set([raw, `openai/${raw}`]);
  for (const prefix of table.externalModelPrefixes ?? []) {
    aliases.add(`${prefix}${raw}`);
  }
  return [...aliases];
}

// Reduce a model id — ours or OpenRouter's — to a provider/harness-agnostic
// comparison key: drop the provider prefix (`anthropic/`, `minimax/`, …), any
// `:tag` routing suffix (`:free`, `:thinking`, …), a trailing `-YYYYMMDD`
// snapshot date, then lowercase and strip `. - _` separators. Lets our
// `claude-opus-4-5-20251101` match OpenRouter's `anthropic/claude-opus-4.5`.
export function normalizeModelId(id: string): string {
  let s = String(id).toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/-\d{8}$/, "");
  return s.replace(/[._-]/g, "");
}

// Memoized normalized id → table key index, keyed by the table object so it is
// rebuilt only when the pricing table is replaced (cache invalidation / refresh).
const normalizedIndexCache = new WeakMap<PricingTable, Map<string, string>>();
function normalizedModelIndex(table: PricingTable): Map<string, string> {
  const cached = normalizedIndexCache.get(table);
  if (cached) return cached;
  const idx = new Map<string, string>();
  for (const key of Object.keys(table.models)) {
    const n = normalizeModelId(key);
    if (!n) continue;
    const prev = idx.get(n);
    // Prefer a canonical (untagged) id over routing variants like `:free`, whose
    // $0 pricing would otherwise shadow the real price under the same norm key.
    if (prev === undefined || (prev.includes(":") && !key.includes(":"))) {
      idx.set(n, key);
    }
  }
  normalizedIndexCache.set(table, idx);
  return idx;
}

// Resolve a model to its table key: exact aliases first (so curated defaults and
// overrides always win), then a normalized fallback that only catches models
// which would otherwise have no price at all.
function resolveModelKey(model: string, table: PricingTable): string | null {
  for (const key of pricingModelAliases(model, table)) {
    if (table.models[key]) return key;
  }
  const n = normalizeModelId(rawModelFromKey(model));
  const hit = n ? normalizedModelIndex(table).get(n) : undefined;
  return hit ?? null;
}

export function priceFor(model: string, table: PricingTable): ModelPrice {
  const key = resolveModelKey(model, table);
  return key ? table.models[key] : table.fallback;
}

function pricingSourceForModel(
  model: string,
  pricing: PricingLoad,
): PricingSource | "fallback" {
  const key = resolveModelKey(model, pricing.table);
  if (key && pricing.sourceByModel[key]) return pricing.sourceByModel[key];
  return "fallback";
}

function pricingMetaForModels(
  pricing: PricingLoad,
  models: string[],
): PricingMeta {
  const fallbackModels: string[] = [];
  let priced = 0;
  let defaultPriced = 0;
  for (const model of models) {
    const source = pricingSourceForModel(model, pricing);
    if (source === "fallback") {
      fallbackModels.push(model);
      continue;
    }
    priced += 1;
    if (source === "default") defaultPriced += 1;
  }
  return {
    ...pricing.meta,
    openRouter: { ...pricing.meta.openRouter },
    userOverride: { ...pricing.meta.userOverride },
    models: {
      priced,
      default: defaultPriced,
      fallback: fallbackModels.length,
      fallbackModels,
    },
  };
}

export type PricingRefreshResult = {
  ok: boolean;
  overridePath: string;
  openRouterError: string | null;
  resolved: { model: string; key: string }[];
  unresolved: string[];
  writtenCount: number;
};

// Fetch live OpenRouter pricing and persist it into the user override file
// (~/.config/cc-dashboard/pricing.json) for every used model OpenRouter knows.
// Override entries are keyed by the raw model name (no provider/harness prefix),
// so pricing is purely model-scoped — a model used across harnesses gets one
// entry. Existing override entries not in the used set are preserved.
export async function refreshPricingOverride(
  usedModelKeys?: string[],
): Promise<PricingRefreshResult> {
  const defaults = safeReadJSON<PricingTable>(PRICING_DEFAULTS);
  if (!defaults)
    throw new Error(`Missing pricing defaults: ${PRICING_DEFAULTS}`);

  // Resolve the used-model list. Trust the caller's list when provided
  // (the dashboard already has it); otherwise derive it from a fresh build.
  let keys = (usedModelKeys ?? []).filter((k) => typeof k === "string" && k);
  if (keys.length === 0) {
    const stats = await buildStats();
    keys = stats.byModel.map((m: { model: string }) => m.model);
  }

  // User asked for this explicitly — allow a longer timeout than the 3s
  // background fetch so a slow network still resolves.
  const live = await fetchOpenRouterPricing(10_000);
  // A throwaway table so resolveModelKey can match used models against the live
  // ids the same way priceFor does — exact aliases first, then normalized.
  const liveTable: PricingTable = {
    models: live.models,
    fallback: defaults.fallback,
    externalModelPrefixes: defaults.externalModelPrefixes,
  };

  // Preserve hand-set override entries; merge fresh live prices on top.
  const existing = readJSONWithError<{ models?: Record<string, ModelPrice> }>(
    USER_PRICING_OVERRIDE,
  );
  if (existing.error) throw new Error(`Override unreadable: ${existing.error}`);
  const models: Record<string, ModelPrice> = {
    ...(existing.data?.models ?? {}),
  };

  const resolved: { model: string; key: string }[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const modelKeyStr of keys) {
    const raw = rawModelFromKey(modelKeyStr);
    if (seen.has(raw)) continue; // collapse the same model across harnesses
    seen.add(raw);
    const liveKey = resolveModelKey(modelKeyStr, liveTable);
    if (liveKey) {
      models[raw] = live.models[liveKey];
      resolved.push({ model: modelKeyStr, key: raw });
    } else {
      unresolved.push(modelKeyStr);
    }
  }

  mkdirSync(dirname(USER_PRICING_OVERRIDE), { recursive: true });
  writeFileSync(
    USER_PRICING_OVERRIDE,
    `${JSON.stringify({ models }, null, 2)}\n`,
  );
  // Drop the cached pricing so the next buildStats reflects the new override.
  pricingCache = null;

  return {
    ok: true,
    overridePath: USER_PRICING_OVERRIDE.replace(HOME, "~"),
    openRouterError: live.error,
    resolved,
    unresolved,
    writtenCount: resolved.length,
  };
}

export function calcCost(
  usage: ModelUsage,
  model: string,
  table: PricingTable,
): number {
  const p = priceFor(model, table);
  // Use distinct cache pricing when available; fall back to charging cache as
  // input tokens only when neither cacheRead nor cacheWrite is defined for
  // this model (typical for some external models).
  const hasCachePricing =
    Number.isFinite(p.cacheRead) || Number.isFinite(p.cacheWrite);
  if (hasCachePricing) {
    const cacheReadRate = Number.isFinite(p.cacheRead) ? p.cacheRead : p.input;
    const cacheWriteRate = Number.isFinite(p.cacheWrite)
      ? p.cacheWrite
      : p.input;
    return (
      (usage.inputTokens * p.input) / 1_000_000 +
      (usage.outputTokens * p.output) / 1_000_000 +
      (usage.cacheReadInputTokens * cacheReadRate) / 1_000_000 +
      (usage.cacheCreationInputTokens * cacheWriteRate) / 1_000_000
    );
  }
  // No cache pricing at all → fold cache tokens into input.
  const inputTokens =
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  return (
    (inputTokens * p.input) / 1_000_000 +
    (usage.outputTokens * p.output) / 1_000_000
  );
}

// ---------- Parsers ----------

function parseStatsCache(): StatsCache {
  const data = safeReadJSON<StatsCache>(STATS_CACHE);
  if (!data) throw new Error(`Missing or unreadable: ${STATS_CACHE}`);
  return data;
}

function parseHistory(): {
  byProject: Map<
    string,
    { messageCount: number; firstSeen: number; lastSeen: number; path: string }
  >;
  weekHourMatrix: number[][];
  dailyHistory: Map<string, { messageCount: number; sessionIds: Set<string> }>;
  dailyHourCounts: Map<string, number[]>;
} {
  const byProject = new Map<
    string,
    { messageCount: number; firstSeen: number; lastSeen: number; path: string }
  >();
  const dailyHistory = new Map<
    string,
    { messageCount: number; sessionIds: Set<string> }
  >();
  const dailyHourCounts = new Map<string, number[]>();
  // [dayOfWeek 0=Sun..6=Sat][hour 0..23]
  const weekHourMatrix: number[][] = Array.from({ length: 7 }, () =>
    Array(24).fill(0),
  );
  if (!existsSync(HISTORY))
    return { byProject, weekHourMatrix, dailyHistory, dailyHourCounts };

  const raw = readFileSync(HISTORY, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: HistoryEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ?? 0;
    if (ts) {
      const d = new Date(ts);
      weekHourMatrix[d.getDay()][d.getHours()] += 1;
      const date = fmtDate(ts);
      const daily = dailyHistory.get(date) ?? {
        messageCount: 0,
        sessionIds: new Set<string>(),
      };
      daily.messageCount += 1;
      if (entry.sessionId) daily.sessionIds.add(entry.sessionId);
      dailyHistory.set(date, daily);
      const hourCounts = dailyHourCounts.get(date) ?? new Array(24).fill(0);
      hourCounts[d.getHours()] += 1;
      dailyHourCounts.set(date, hourCounts);
    }
    if (!entry.project) continue;
    const path = entry.project;
    const cur = byProject.get(path);
    if (cur) {
      cur.messageCount += 1;
      if (ts && ts < cur.firstSeen) cur.firstSeen = ts;
      if (ts && ts > cur.lastSeen) cur.lastSeen = ts;
    } else {
      byProject.set(path, {
        messageCount: 1,
        firstSeen: ts || Date.now(),
        lastSeen: ts || 0,
        path,
      });
    }
  }
  return { byProject, weekHourMatrix, dailyHistory, dailyHourCounts };
}

function parseSessions(): Array<{
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status: string;
  updatedAt?: number;
  version?: string;
}> {
  return readSessionFiles();
}

export function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

export function addUsage(target: ModelUsage, usage: TranscriptUsage): void {
  target.inputTokens += usage.input_tokens ?? 0;
  target.outputTokens += usage.output_tokens ?? 0;
  target.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  target.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
}

export function usageTokenTotal(usage: TranscriptUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export function modelKey(provider: Provider, model: string): string {
  return `${provider}:${model}`;
}

export function providerFromModelKey(key: string): Provider {
  if (key.startsWith("codex:")) return "codex";
  if (key.startsWith("opencode:")) return "opencode";
  return "claude";
}

export function rawModelFromKey(key: string): string {
  return key.replace(/^(claude|codex|opencode):/, "");
}

export function addModelUsage(target: ModelUsage, source: ModelUsage): void {
  target.inputTokens += source.inputTokens ?? 0;
  target.outputTokens += source.outputTokens ?? 0;
  target.cacheReadInputTokens += source.cacheReadInputTokens ?? 0;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens ?? 0;
  target.reasoningOutputTokens =
    (target.reasoningOutputTokens ?? 0) + (source.reasoningOutputTokens ?? 0);
  if (source.costUSD !== undefined || target.costUSD !== undefined) {
    target.costUSD = (target.costUSD ?? 0) + (source.costUSD ?? 0);
  }
}

function hourStartMs(timestampMs: number): number {
  const d = new Date(timestampMs);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function addHourlyUsage(
  buckets: Map<number, HourlyUsageBucket>,
  timestampMs: number,
  model: string,
  usage: ModelUsage,
): void {
  if (!timestampMs) return;
  const hourMs = hourStartMs(timestampMs);
  const bucket =
    buckets.get(hourMs) ??
    ({
      timestampMs: hourMs,
      usageByModel: new Map<string, ModelUsage>(),
    } satisfies HourlyUsageBucket);
  const current = bucket.usageByModel.get(model) ?? emptyModelUsage();
  addModelUsage(current, usage);
  bucket.usageByModel.set(model, current);
  buckets.set(hourMs, bucket);
}

export function modelUsageTotal(usage: ModelUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens +
    (usage.reasoningOutputTokens ?? 0)
  );
}

function serializeProjectModelUsage(
  provider: Provider,
  byModel: Map<string, ModelUsage> | undefined,
  pricing: PricingTable,
) {
  if (!byModel) return [];
  return Array.from(byModel.entries())
    .map(([model, usage]) => {
      // Claude transcript keys are bare model names; codex keys are already "codex:model" namespaced.
      const modelName =
        provider === "claude" ? modelKey("claude", model) : model;
      const rawModel = provider === "claude" ? model : rawModelFromKey(model);
      return {
        model: modelName,
        provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        reasoningTokens: usage.reasoningOutputTokens ?? 0,
        costUSD: usageCost(usage, rawModel, pricing),
        isExternal: isExternal(rawModel, pricing.externalModelPrefixes),
      };
    })
    .filter(
      (row) =>
        row.inputTokens +
          row.outputTokens +
          row.cacheReadTokens +
          row.cacheCreationTokens +
          row.reasoningTokens +
          row.costUSD >
        0,
    )
    .sort((a, b) => b.costUSD - a.costUSD);
}

function usageCost(
  usage: ModelUsage,
  model: string,
  pricing: PricingTable,
): number {
  return usage.costUSD && usage.costUSD > 0
    ? usage.costUSD
    : calcCost(usage, model, pricing);
}

function walkFiles(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(path, ext, out);
    } else if (stat.isFile() && path.endsWith(ext)) {
      out.push(path);
    }
  }
  return out;
}

function openCodeStorageRoots(): string[] {
  const roots = new Set<string>();
  if (existsSync(OPENCODE_STORAGE_DIR)) roots.add(OPENCODE_STORAGE_DIR);
  if (existsSync(OPENCODE_PROJECT_DIR)) {
    for (const name of readdirSync(OPENCODE_PROJECT_DIR)) {
      const storage = join(OPENCODE_PROJECT_DIR, name, "storage");
      if (existsSync(storage)) roots.add(storage);
    }
  }
  return [...roots];
}

function countClaudeToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "tool_use",
  ).length;
}

type ClaudeAggregates = {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
  hourlyUsage: Map<number, HourlyUsageBucket>;
  projectTokens: Map<string, number>;
  projectModelUsage: Map<string, Map<string, ModelUsage>>;
};

// Reconstruct the four Claude aggregate maps + projectTokens from the persistent
// rollup, so they reflect the *full* token history even after Claude Code deletes
// the underlying transcripts. usage_hourly is finer-grained than any single map
// (it carries hour + project + model), so each map is a different GROUP BY of the
// same rows. hour_ms=0 rows are timeless entries: counted in the model/project
// totals but excluded from the hourly/daily maps — exactly the live parser's
// behaviour (addHourlyUsage skips ts=0; daily skips empty dates).
function readRollupAggregates(db: Database): ClaudeAggregates {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  const hourlyUsage = new Map<number, HourlyUsageBucket>();
  const projectTokens = new Map<string, number>();
  const projectModelUsage = new Map<string, Map<string, ModelUsage>>();

  for (const r of allHourlyRows(db)) {
    const usage: ModelUsage = {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadInputTokens: r.cache_read,
      cacheCreationInputTokens: r.cache_creation,
      reasoningOutputTokens: r.reasoning,
    };

    // modelUsage — every row, keyed by raw model (buildStats applies modelKey).
    modelUsage[r.model] ??= emptyModelUsage();
    addModelUsage(modelUsage[r.model], usage);

    // projectModelUsage + projectTokens — only rows with a cwd, matching the live
    // parser which writes these solely when entry.cwd is truthy.
    if (r.project) {
      let byModel = projectModelUsage.get(r.project);
      if (!byModel) {
        byModel = new Map();
        projectModelUsage.set(r.project, byModel);
      }
      const pu = byModel.get(r.model) ?? emptyModelUsage();
      addModelUsage(pu, usage);
      byModel.set(r.model, pu);
      projectTokens.set(
        r.project,
        (projectTokens.get(r.project) ?? 0) + modelUsageTotal(usage),
      );
    }

    // hourly + daily — only timestamped rows.
    if (r.hour_ms) {
      // hourlyUsage is keyed by the namespaced modelKey (see live parser).
      addHourlyUsage(
        hourlyUsage,
        r.hour_ms,
        modelKey("claude", r.model),
        usage,
      );
      const date = fmtDate(r.hour_ms);
      let byModel = dailyModelUsage.get(date);
      if (!byModel) {
        byModel = new Map();
        dailyModelUsage.set(date, byModel);
      }
      const du = byModel.get(r.model) ?? emptyModelUsage();
      addModelUsage(du, usage);
      byModel.set(r.model, du);
    }
  }

  return {
    modelUsage,
    dailyModelUsage,
    hourlyUsage,
    projectTokens,
    projectModelUsage,
  };
}

function parseTranscriptUsage(): {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
  hourlyUsage: Map<number, HourlyUsageBucket>;
  projectTokens: Map<string, number>;
  projectModelUsage: Map<string, Map<string, ModelUsage>>;
  ledger: InternalLedgerRow[];
  transcriptFileCount: number;
} {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  const hourlyUsage = new Map<number, HourlyUsageBucket>();
  const projectTokens = new Map<string, number>();
  const projectModelUsage = new Map<string, Map<string, ModelUsage>>();
  const ledgerBySession = new Map<
    string,
    InternalLedgerRow & { toolCallIds: Set<string> }
  >();
  const seen = new Set<string>();
  const transcriptFiles = walkFiles(PROJECTS_DIR, ".jsonl");

  for (const file of transcriptFiles) {
    let raw = "";
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const sessionId = entry.sessionId ?? file.split("/").at(-1) ?? file;
      const parsedTimestamp = entry.timestamp ? Date.parse(entry.timestamp) : 0;
      const timestampMs = Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : 0;
      const projectPath = entry.cwd ?? "";
      const existingLedger = ledgerBySession.get(sessionId);
      const ledger =
        existingLedger ??
        ({
          id: `claude:${sessionId}`,
          provider: "claude",
          timestampMs,
          date: timestampMs ? fmtDate(timestampMs) : "",
          projectPath,
          projectName: projectPath ? projectName(projectPath) : "n/a",
          model: "n/a",
          interactions: 0,
          toolCalls: 0,
          tokens: 0,
          costBasis: "unavailable",
          usageByModel: new Map<string, ModelUsage>(),
          toolCallIds: new Set<string>(),
        } satisfies InternalLedgerRow & { toolCallIds: Set<string> });
      if (!existingLedger) ledgerBySession.set(sessionId, ledger);
      if (timestampMs && timestampMs > ledger.timestampMs) {
        ledger.timestampMs = timestampMs;
        ledger.date = fmtDate(timestampMs);
      }
      if (!ledger.projectPath && projectPath) {
        ledger.projectPath = projectPath;
        ledger.projectName = projectName(projectPath);
      }
      if (entry.type === "user" && !entry.isMeta) ledger.interactions += 1;
      const contentToolCalls = countClaudeToolCalls(entry.message?.content);
      if (contentToolCalls > 0) {
        const toolKey =
          entry.message?.id ?? entry.uuid ?? `${file}:${timestampMs}`;
        if (!ledger.toolCallIds.has(toolKey)) {
          ledger.toolCallIds.add(toolKey);
          ledger.toolCalls += contentToolCalls;
        }
      }

      const model = entry.message?.model;
      const usage = entry.message?.usage;
      if (entry.type !== "assistant" || !model || !usage) continue;
      if (model === "<synthetic>" || usageTokenTotal(usage) === 0) continue;

      // Dedup billing: Claude Code persists multiple snapshots per API request
      // with identical usage — count each request once (see dedup.ts).
      const key = dedupKey(entry, file, seen.size);
      if (seen.has(key)) continue;
      seen.add(key);

      const tokenTotal = usageTokenTotal(usage);
      const ledgerModel = modelKey("claude", model);
      const ledgerUsage =
        ledger.usageByModel.get(ledgerModel) ?? emptyModelUsage();
      addUsage(ledgerUsage, usage);
      ledger.usageByModel.set(ledgerModel, ledgerUsage);
      addHourlyUsage(hourlyUsage, timestampMs, modelKey("claude", model), {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        reasoningOutputTokens: 0,
      });
      ledger.tokens += tokenTotal;
      ledger.costBasis = "usage";
      ledger.model = ledger.usageByModel.size === 1 ? ledgerModel : "mixed";

      modelUsage[model] ??= emptyModelUsage();
      addUsage(modelUsage[model], usage);

      if (entry.cwd) {
        projectTokens.set(
          entry.cwd,
          (projectTokens.get(entry.cwd) ?? 0) + tokenTotal,
        );
        let byModel = projectModelUsage.get(entry.cwd);
        if (!byModel) {
          byModel = new Map();
          projectModelUsage.set(entry.cwd, byModel);
        }
        const projectUsage = byModel.get(model) ?? emptyModelUsage();
        addUsage(projectUsage, usage);
        byModel.set(model, projectUsage);
      }

      const date = entry.timestamp ? fmtDate(Date.parse(entry.timestamp)) : "";
      if (!date) continue;
      let byModel = dailyModelUsage.get(date);
      if (!byModel) {
        byModel = new Map();
        dailyModelUsage.set(date, byModel);
      }
      const dayUsage = byModel.get(model) ?? emptyModelUsage();
      addUsage(dayUsage, usage);
      byModel.set(model, dayUsage);
    }
  }

  const ledger = Array.from(ledgerBySession.values())
    .map(({ toolCallIds: _toolCallIds, ...row }) => row)
    .filter(
      (row) =>
        row.timestampMs > 0 &&
        (row.interactions > 0 || row.tokens > 0 || row.toolCalls > 0),
    );

  // The aggregate maps come from the persistent rollup (full history, survives
  // transcript deletion); the per-session ledger + file count stay sourced from
  // the live walk above (inherently recent — they shrink as files are cleaned up,
  // which is acceptable). If the rollup is unavailable for any reason, fall back
  // to the live-walk maps so the dashboard still renders.
  let aggregates: ClaudeAggregates = {
    modelUsage,
    dailyModelUsage,
    hourlyUsage,
    projectTokens,
    projectModelUsage,
  };
  try {
    const db = openRollupDb();
    try {
      updateRollup(db);
      aggregates = readRollupAggregates(db);
    } finally {
      db.close();
    }
  } catch {
    // keep live-walk aggregates
  }

  return {
    ...aggregates,
    ledger,
    transcriptFileCount: transcriptFiles.length,
  };
}

function readCodexSession(file: string): CodexSessionSummary | null {
  let raw = "";
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }

  let latest: CodexTokenUsage | null = null;
  let id: string | null = null;
  let timestampMs = 0;
  let cwd = "";
  let model: string | null = null;
  let responseUserMessages = 0;
  let eventUserMessages = 0;
  let toolCalls = 0;
  const tokenEvents: Array<{ timestampMs: number; usage: CodexTokenUsage }> =
    [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      timestamp?: string;
      type?: string;
      payload?: {
        id?: string;
        timestamp?: string;
        cwd?: string;
        model?: string;
        type?: string;
        role?: string;
        message?: { role?: string };
        info?: {
          total_token_usage?: CodexTokenUsage;
          last_token_usage?: CodexTokenUsage;
        };
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!timestampMs && entry.timestamp) {
      const parsed = Date.parse(entry.timestamp);
      if (Number.isFinite(parsed)) timestampMs = parsed;
    }
    if (entry.type === "session_meta") {
      id = entry.payload?.id ?? id;
      cwd = entry.payload?.cwd ?? cwd;
      model = entry.payload?.model ?? model;
      if (!timestampMs && entry.payload?.timestamp) {
        const parsed = Date.parse(entry.payload.timestamp);
        if (Number.isFinite(parsed)) timestampMs = parsed;
      }
    }
    if (entry.type === "turn_context") {
      cwd = entry.payload?.cwd ?? cwd;
      model = entry.payload?.model ?? model;
    }
    if (entry.type === "response_item") {
      if (entry.payload?.type === "function_call") toolCalls += 1;
      if (entry.payload?.type === "message" && entry.payload.role === "user") {
        responseUserMessages += 1;
      }
    }
    if (entry.type === "event_msg") {
      if (entry.payload?.type === "user_message") eventUserMessages += 1;
      if (
        entry.payload?.type === "token_count" &&
        entry.payload.info?.total_token_usage
      ) {
        latest = entry.payload.info.total_token_usage;
        const eventTimestamp = entry.timestamp
          ? Date.parse(entry.timestamp)
          : 0;
        const totalUsage = entry.payload.info.total_token_usage;
        if (Number.isFinite(eventTimestamp) && eventTimestamp && totalUsage) {
          tokenEvents.push({ timestampMs: eventTimestamp, usage: totalUsage });
        }
      }
    }
  }
  return {
    id,
    timestampMs,
    cwd,
    model,
    tokenUsage: latest,
    tokenEvents,
    userMessages: Math.max(responseUserMessages, eventUserMessages),
    toolCalls,
  };
}

function codexUsageFromTokenUsage(usage: CodexTokenUsage): ModelUsage {
  const cachedInput = usage.cached_input_tokens ?? 0;
  const input = Math.max(0, (usage.input_tokens ?? 0) - cachedInput);
  return {
    inputTokens: input,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: cachedInput,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
  };
}

function codexTokenUsageDelta(
  current: CodexTokenUsage,
  previous: CodexTokenUsage | null,
): CodexTokenUsage {
  if (!previous) return current;
  return {
    input_tokens: Math.max(
      0,
      (current.input_tokens ?? 0) - (previous.input_tokens ?? 0),
    ),
    cached_input_tokens: Math.max(
      0,
      (current.cached_input_tokens ?? 0) - (previous.cached_input_tokens ?? 0),
    ),
    output_tokens: Math.max(
      0,
      (current.output_tokens ?? 0) - (previous.output_tokens ?? 0),
    ),
    reasoning_output_tokens: Math.max(
      0,
      (current.reasoning_output_tokens ?? 0) -
        (previous.reasoning_output_tokens ?? 0),
    ),
    total_tokens: Math.max(
      0,
      (current.total_tokens ?? 0) - (previous.total_tokens ?? 0),
    ),
  };
}

function codexUsageFromThread(
  row: Pick<CodexThreadRow, "tokens_used">,
  session: CodexSessionSummary | null,
): ModelUsage {
  const usage = session?.tokenUsage ?? null;
  if (!usage) {
    return {
      inputTokens: row.tokens_used,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };
  }

  return codexUsageFromTokenUsage(usage);
}

function parseCodexUsage(): {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
  hourlyUsage: Map<number, HourlyUsageBucket>;
  projectTokens: Map<string, number>;
  projectModelUsage: Map<string, Map<string, ModelUsage>>;
  projectActivity: Map<
    string,
    {
      threadCount: number;
      interactionCount: number;
      toolCallCount: number;
      firstSeen: number;
      lastSeen: number;
      path: string;
    }
  >;
  dailyActivity: Map<
    string,
    { threadCount: number; interactionCount: number; toolCallCount: number }
  >;
  hourCounts: Record<string, number>;
  weekHourMatrix: number[][];
  dailyHourCounts: Map<string, number[]>;
  totalThreads: number;
  totalInteractions: number;
  totalToolCalls: number;
  ledger: InternalLedgerRow[];
  codexSessionFileCount: number;
  codexThreadRowCount: number;
} {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  const hourlyUsage = new Map<number, HourlyUsageBucket>();
  const projectTokens = new Map<string, number>();
  const projectModelUsage = new Map<string, Map<string, ModelUsage>>();
  const projectActivity = new Map<
    string,
    {
      threadCount: number;
      interactionCount: number;
      toolCallCount: number;
      firstSeen: number;
      lastSeen: number;
      path: string;
    }
  >();
  const dailyActivity = new Map<
    string,
    { threadCount: number; interactionCount: number; toolCallCount: number }
  >();
  const hourCounts: Record<string, number> = {};
  const dailyHourCounts = new Map<string, number[]>();
  const ledger: InternalLedgerRow[] = [];
  const weekHourMatrix: number[][] = Array.from({ length: 7 }, () =>
    Array(24).fill(0),
  );

  let rows: CodexThreadRow[] = [];
  if (existsSync(CODEX_STATE_DB)) {
    try {
      const db = new Database(CODEX_STATE_DB, { readonly: true });
      rows = db
        .query(
          `select id, rollout_path, created_at, updated_at, cwd, title, model, tokens_used
           from threads
           where tokens_used > 0 or rollout_path != ''
           order by created_at asc`,
        )
        .all() as CodexThreadRow[];
      db.close();
    } catch {
      rows = [];
    }
  }

  const rowByRollout = new Map(rows.map((row) => [row.rollout_path, row]));
  const codexSessionFiles = walkFiles(CODEX_SESSIONS_DIR, ".jsonl");
  const sessionFiles = new Set([
    ...rows.map((row) => row.rollout_path).filter(Boolean),
    ...codexSessionFiles,
  ]);
  let totalInteractions = 0;
  let totalToolCalls = 0;

  for (const file of sessionFiles) {
    const row = rowByRollout.get(file);
    const session = readCodexSession(file);
    const model = row?.model || session?.model || "unknown";
    const key = modelKey("codex", model);
    const usage = codexUsageFromThread(
      { tokens_used: row?.tokens_used ?? 0 },
      session,
    );
    const tokenTotal = row?.tokens_used || modelUsageTotal(usage);
    const createdMs = row?.created_at
      ? row.created_at * 1000
      : (session?.timestampMs ?? 0);
    const updatedMs = row?.updated_at ? row.updated_at * 1000 : createdMs;
    if (!createdMs) continue;
    const cwd = row?.cwd || session?.cwd || "";
    const interactionCount = session?.userMessages || 1;
    const toolCallCount = session?.toolCalls ?? 0;
    const date = fmtDate(createdMs);
    const d = new Date(createdMs);
    totalInteractions += interactionCount;
    totalToolCalls += toolCallCount;

    modelUsage[key] ??= emptyModelUsage();
    addModelUsage(modelUsage[key], usage);
    if (session?.tokenEvents.length) {
      let previousUsage: CodexTokenUsage | null = null;
      for (const event of session.tokenEvents) {
        const delta = codexTokenUsageDelta(event.usage, previousUsage);
        previousUsage = event.usage;
        addHourlyUsage(
          hourlyUsage,
          event.timestampMs,
          key,
          codexUsageFromTokenUsage(delta),
        );
      }
    } else {
      addHourlyUsage(hourlyUsage, updatedMs || createdMs, key, usage);
    }

    let byModel = dailyModelUsage.get(date);
    if (!byModel) {
      byModel = new Map();
      dailyModelUsage.set(date, byModel);
    }
    const dayUsage = byModel.get(key) ?? emptyModelUsage();
    addModelUsage(dayUsage, usage);
    byModel.set(key, dayUsage);

    if (cwd) {
      projectTokens.set(cwd, (projectTokens.get(cwd) ?? 0) + tokenTotal);
      let projectByModel = projectModelUsage.get(cwd);
      if (!projectByModel) {
        projectByModel = new Map();
        projectModelUsage.set(cwd, projectByModel);
      }
      const projectUsage = projectByModel.get(key) ?? emptyModelUsage();
      addModelUsage(projectUsage, usage);
      projectByModel.set(key, projectUsage);

      const current = projectActivity.get(cwd);
      if (current) {
        current.threadCount += 1;
        current.interactionCount += interactionCount;
        current.toolCallCount += toolCallCount;
        current.firstSeen = Math.min(current.firstSeen, createdMs);
        current.lastSeen = Math.max(current.lastSeen, updatedMs);
      } else {
        projectActivity.set(cwd, {
          threadCount: 1,
          interactionCount,
          toolCallCount,
          firstSeen: createdMs,
          lastSeen: updatedMs,
          path: cwd,
        });
      }
    }

    const daily = dailyActivity.get(date) ?? {
      threadCount: 0,
      interactionCount: 0,
      toolCallCount: 0,
    };
    daily.threadCount += 1;
    daily.interactionCount += interactionCount;
    daily.toolCallCount += toolCallCount;
    dailyActivity.set(date, daily);
    hourCounts[String(d.getHours())] =
      (hourCounts[String(d.getHours())] || 0) + interactionCount;
    weekHourMatrix[d.getDay()][d.getHours()] += interactionCount;
    const hourBuckets = dailyHourCounts.get(date) ?? new Array(24).fill(0);
    hourBuckets[d.getHours()] += interactionCount;
    dailyHourCounts.set(date, hourBuckets);

    ledger.push({
      id: `codex:${row?.id ?? session?.id ?? file}`,
      provider: "codex",
      timestampMs: updatedMs || createdMs,
      date: fmtDate(updatedMs || createdMs),
      projectPath: cwd,
      projectName: cwd ? projectName(cwd) : "n/a",
      model: modelKey("codex", model),
      interactions: interactionCount,
      toolCalls: toolCallCount,
      tokens: tokenTotal,
      costBasis: session?.tokenUsage
        ? "usage"
        : row?.tokens_used
          ? "thread_tokens"
          : "unavailable",
      usageByModel: new Map([[key, usage]]),
    });
  }

  for (const row of rows) {
    if (row.rollout_path) continue;
    const model = row.model || "unknown";
    const key = modelKey("codex", model);
    const usage = codexUsageFromThread({ tokens_used: row.tokens_used }, null);
    const timestampMs = (row.updated_at || row.created_at) * 1000;
    if (!timestampMs) continue;
    addHourlyUsage(hourlyUsage, timestampMs, key, usage);

    modelUsage[key] ??= emptyModelUsage();
    addModelUsage(modelUsage[key], usage);

    const date = fmtDate(timestampMs);
    let byModel = dailyModelUsage.get(date);
    if (!byModel) {
      byModel = new Map();
      dailyModelUsage.set(date, byModel);
    }
    const dayUsage = byModel.get(key) ?? emptyModelUsage();
    addModelUsage(dayUsage, usage);
    byModel.set(key, dayUsage);

    if (row.cwd) {
      const tokenTotal = row.tokens_used || modelUsageTotal(usage);
      projectTokens.set(
        row.cwd,
        (projectTokens.get(row.cwd) ?? 0) + tokenTotal,
      );
      let projectByModel = projectModelUsage.get(row.cwd);
      if (!projectByModel) {
        projectByModel = new Map();
        projectModelUsage.set(row.cwd, projectByModel);
      }
      const projectUsage = projectByModel.get(key) ?? emptyModelUsage();
      addModelUsage(projectUsage, usage);
      projectByModel.set(key, projectUsage);
    }

    ledger.push({
      id: `codex:${row.id}`,
      provider: "codex",
      timestampMs,
      date: fmtDate(timestampMs),
      projectPath: row.cwd,
      projectName: row.cwd ? projectName(row.cwd) : "n/a",
      model: key,
      interactions: 1,
      toolCalls: 0,
      tokens: row.tokens_used,
      costBasis: row.tokens_used ? "thread_tokens" : "unavailable",
      usageByModel: new Map([[key, usage]]),
    });
  }

  return {
    modelUsage,
    dailyModelUsage,
    hourlyUsage,
    projectTokens,
    projectModelUsage,
    projectActivity,
    dailyActivity,
    hourCounts,
    weekHourMatrix,
    dailyHourCounts,
    totalThreads: sessionFiles.size,
    totalInteractions,
    totalToolCalls,
    ledger,
    codexSessionFileCount: codexSessionFiles.length,
    codexThreadRowCount: rows.length,
  };
}

function openCodeMessageInfo(stored: OpenCodeStoredMessage): OpenCodeMessage {
  return stored.info ?? stored;
}

export function openCodeUsageFromTokens(
  tokens: OpenCodeTokenUsage,
): ModelUsage {
  return {
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    cacheReadInputTokens: tokens.cache?.read ?? 0,
    cacheCreationInputTokens: tokens.cache?.write ?? 0,
    reasoningOutputTokens: tokens.reasoning ?? 0,
  };
}

function countOpenCodeToolCalls(parts: Array<{ type?: string }> | undefined) {
  if (!Array.isArray(parts)) return 0;
  return parts.filter((part) => part?.type === "tool").length;
}

function parseOpenCodeUsage(): {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
  hourlyUsage: Map<number, HourlyUsageBucket>;
  projectTokens: Map<string, number>;
  projectModelUsage: Map<string, Map<string, ModelUsage>>;
  projectActivity: Map<
    string,
    {
      sessionCount: number;
      interactionCount: number;
      toolCallCount: number;
      firstSeen: number;
      lastSeen: number;
      path: string;
    }
  >;
  dailyActivity: Map<
    string,
    { sessionCount: number; interactionCount: number; toolCallCount: number }
  >;
  weekHourMatrix: number[][];
  dailyHourCounts: Map<string, number[]>;
  totalSessions: number;
  totalInteractions: number;
  totalToolCalls: number;
  ledger: InternalLedgerRow[];
  openCodeSessionFileCount: number;
  openCodeMessageFileCount: number;
  openCodeSessionRowCount: number;
  openCodeMessageRowCount: number;
} {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  const hourlyUsage = new Map<number, HourlyUsageBucket>();
  const projectTokens = new Map<string, number>();
  const projectModelUsage = new Map<string, Map<string, ModelUsage>>();
  const projectActivity = new Map<
    string,
    {
      sessionCount: number;
      interactionCount: number;
      toolCallCount: number;
      firstSeen: number;
      lastSeen: number;
      path: string;
    }
  >();
  const dailyActivity = new Map<
    string,
    { sessionCount: number; interactionCount: number; toolCallCount: number }
  >();
  const dailyHourCounts = new Map<string, number[]>();
  const ledgerBySession = new Map<
    string,
    InternalLedgerRow & {
      projectFirstSeen: number;
      userMessageIds: Set<string>;
    }
  >();
  const weekHourMatrix: number[][] = Array.from({ length: 7 }, () =>
    Array(24).fill(0),
  );

  const storageRoots = openCodeStorageRoots();
  const sessionFiles = storageRoots.flatMap((root) =>
    walkFiles(join(root, "session"), ".json"),
  );
  const messageFiles = storageRoots.flatMap((root) =>
    walkFiles(join(root, "message"), ".json"),
  );
  const sessionsById = new Map<string, OpenCodeSession>();
  const toolCallsByMessageId = new Map<string, number>();

  let openCodeSessionRowCount = 0;
  let openCodeMessageRowCount = 0;
  if (existsSync(OPENCODE_DB)) {
    let db: Database | null = null;
    try {
      db = new Database(OPENCODE_DB, { readonly: true });
      const sessionRows = db
        .query<OpenCodeSessionRow, []>(
          "select id, directory, time_created, time_updated from session",
        )
        .all();
      openCodeSessionRowCount = sessionRows.length;
      for (const row of sessionRows) {
        sessionsById.set(row.id, {
          id: row.id,
          directory: row.directory,
          time: {
            created: row.time_created,
            updated: row.time_updated,
          },
        });
      }

      const toolRows = db
        .query<{ message_id: string; tool_calls: number }, []>(
          "select message_id, count(*) as tool_calls from part where json_extract(data, '$.type') = 'tool' group by message_id",
        )
        .all();
      for (const row of toolRows) {
        toolCallsByMessageId.set(row.message_id, row.tool_calls);
      }

      const messageRows = db
        .query<OpenCodeMessageRow, []>(
          "select id, session_id, time_created, time_updated, data from message",
        )
        .all();
      openCodeMessageRowCount = messageRows.length;
      for (const row of messageRows) {
        const info = safeParseJSON<OpenCodeMessage>(row.data);
        if (!info) continue;
        ingestOpenCodeMessage({
          info: {
            ...info,
            id: row.id,
            sessionID: row.session_id,
            time: {
              created: info.time?.created ?? row.time_created,
              completed: info.time?.completed ?? row.time_updated,
            },
          },
          sessionId: row.session_id,
          session: sessionsById.get(row.session_id),
          fallbackTimestampMs: row.time_updated || row.time_created,
          toolCalls: toolCallsByMessageId.get(row.id) ?? 0,
        });
      }
    } catch {
      // OpenCode JSON storage below remains a best-effort fallback.
    } finally {
      db?.close();
    }
  }

  if (openCodeSessionRowCount === 0) {
    for (const file of sessionFiles) {
      const session = safeReadJSON<OpenCodeSession>(file);
      if (session?.id) sessionsById.set(session.id, session);
    }
  }

  function ingestOpenCodeMessage({
    info,
    sessionId,
    session,
    fallbackTimestampMs,
    toolCalls,
  }: {
    info: OpenCodeMessage;
    sessionId: string;
    session: OpenCodeSession | undefined;
    fallbackTimestampMs: number;
    toolCalls: number;
    fallbackMessageId?: string;
  }) {
    const createdMs =
      openCodeTimestampMs(info.time?.created ?? 0) ||
      openCodeTimestampMs(session?.time?.created ?? 0) ||
      openCodeTimestampMs(fallbackTimestampMs);
    const completedMs =
      openCodeTimestampMs(info.time?.completed ?? 0) ||
      openCodeTimestampMs(session?.time?.updated ?? 0) ||
      createdMs;
    const timestampMs = completedMs || createdMs;
    if (!timestampMs) return;

    const cwd = info.path?.cwd ?? session?.directory ?? "";
    const ledger =
      ledgerBySession.get(sessionId) ??
      ({
        id: `opencode:${sessionId}`,
        provider: "opencode",
        timestampMs,
        date: fmtDate(timestampMs),
        projectPath: cwd,
        projectName: cwd ? projectName(cwd) : "n/a",
        model: "n/a",
        interactions: 0,
        toolCalls: 0,
        tokens: 0,
        costBasis: "unavailable",
        usageByModel: new Map<string, ModelUsage>(),
        projectFirstSeen: timestampMs,
        userMessageIds: new Set<string>(),
      } satisfies InternalLedgerRow & {
        projectFirstSeen: number;
        userMessageIds: Set<string>;
      });
    ledgerBySession.set(sessionId, ledger);
    ledger.timestampMs = Math.max(ledger.timestampMs, timestampMs);
    ledger.date = fmtDate(ledger.timestampMs);
    ledger.projectFirstSeen = Math.min(ledger.projectFirstSeen, timestampMs);
    if (!ledger.projectPath && cwd) {
      ledger.projectPath = cwd;
      ledger.projectName = projectName(cwd);
    }

    if (info.role === "user") {
      const messageId =
        info.id ?? fallbackMessageId ?? `${sessionId}:${timestampMs}`;
      if (!ledger.userMessageIds.has(messageId)) {
        ledger.userMessageIds.add(messageId);
        ledger.interactions += 1;
      }
      return;
    }

    if (info.role !== "assistant" || !info.tokens) return;
    const model = info.modelID || "unknown";
    const key = modelKey("opencode", model);
    const usage = openCodeUsageFromTokens(info.tokens);
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) {
      usage.costUSD = info.cost;
    }
    const tokenTotal = modelUsageTotal(usage);
    if (tokenTotal <= 0 && !(info.cost && info.cost > 0)) return;

    const ledgerUsage = ledger.usageByModel.get(key) ?? emptyModelUsage();
    addModelUsage(ledgerUsage, usage);
    ledger.usageByModel.set(key, ledgerUsage);
    ledger.tokens += tokenTotal;
    ledger.costBasis = "usage";
    ledger.model = ledger.usageByModel.size === 1 ? key : "mixed";
    ledger.toolCalls += toolCalls;

    modelUsage[key] ??= emptyModelUsage();
    addModelUsage(modelUsage[key], usage);
    addHourlyUsage(hourlyUsage, timestampMs, key, usage);

    const date = fmtDate(timestampMs);
    let dayByModel = dailyModelUsage.get(date);
    if (!dayByModel) {
      dayByModel = new Map();
      dailyModelUsage.set(date, dayByModel);
    }
    const dayUsage = dayByModel.get(key) ?? emptyModelUsage();
    addModelUsage(dayUsage, usage);
    dayByModel.set(key, dayUsage);

    if (cwd) {
      projectTokens.set(cwd, (projectTokens.get(cwd) ?? 0) + tokenTotal);
      let projectByModel = projectModelUsage.get(cwd);
      if (!projectByModel) {
        projectByModel = new Map();
        projectModelUsage.set(cwd, projectByModel);
      }
      const projectUsage = projectByModel.get(key) ?? emptyModelUsage();
      addModelUsage(projectUsage, usage);
      projectByModel.set(key, projectUsage);
    }
  }

  if (openCodeMessageRowCount === 0) {
    for (const file of messageFiles) {
      const stored = safeReadJSON<OpenCodeStoredMessage>(file);
      if (!stored) continue;
      const info = openCodeMessageInfo(stored);
      const sessionId =
        info.sessionID ?? stored.sessionID ?? file.split("/").at(-2) ?? file;
      ingestOpenCodeMessage({
        info,
        sessionId,
        session: sessionsById.get(sessionId),
        fallbackTimestampMs: 0,
        toolCalls: countOpenCodeToolCalls(stored.parts),
        fallbackMessageId: file,
      });
    }
  }

  let totalInteractions = 0;
  let totalToolCalls = 0;
  const activeLedgerRows: InternalLedgerRow[] = [];
  for (const ledger of ledgerBySession.values()) {
    if (
      ledger.timestampMs <= 0 ||
      (ledger.interactions <= 0 && ledger.tokens <= 0 && ledger.toolCalls <= 0)
    ) {
      continue;
    }

    const {
      projectFirstSeen: _projectFirstSeen,
      userMessageIds: _ids,
      ...row
    } = ledger;
    activeLedgerRows.push(row);
    totalInteractions += ledger.interactions;
    totalToolCalls += ledger.toolCalls;
    const d = new Date(ledger.timestampMs);
    const date = fmtDate(ledger.timestampMs);
    const daily = dailyActivity.get(date) ?? {
      sessionCount: 0,
      interactionCount: 0,
      toolCallCount: 0,
    };
    daily.sessionCount += 1;
    daily.interactionCount += ledger.interactions;
    daily.toolCallCount += ledger.toolCalls;
    dailyActivity.set(date, daily);
    weekHourMatrix[d.getDay()][d.getHours()] += ledger.interactions;
    const hourBuckets = dailyHourCounts.get(date) ?? new Array(24).fill(0);
    hourBuckets[d.getHours()] += ledger.interactions;
    dailyHourCounts.set(date, hourBuckets);

    if (ledger.projectPath) {
      const current = projectActivity.get(ledger.projectPath);
      if (current) {
        current.sessionCount += 1;
        current.interactionCount += ledger.interactions;
        current.toolCallCount += ledger.toolCalls;
        current.firstSeen = Math.min(
          current.firstSeen,
          ledger.projectFirstSeen,
        );
        current.lastSeen = Math.max(current.lastSeen, ledger.timestampMs);
      } else {
        projectActivity.set(ledger.projectPath, {
          sessionCount: 1,
          interactionCount: ledger.interactions,
          toolCallCount: ledger.toolCalls,
          firstSeen: ledger.projectFirstSeen,
          lastSeen: ledger.timestampMs,
          path: ledger.projectPath,
        });
      }
    }
  }

  return {
    modelUsage,
    dailyModelUsage,
    hourlyUsage,
    projectTokens,
    projectModelUsage,
    projectActivity,
    dailyActivity,
    weekHourMatrix,
    dailyHourCounts,
    totalSessions: activeLedgerRows.length,
    totalInteractions,
    totalToolCalls,
    ledger: activeLedgerRows,
    openCodeSessionFileCount: sessionFiles.length,
    openCodeMessageFileCount: messageFiles.length,
    openCodeSessionRowCount,
    openCodeMessageRowCount,
  };
}

// ---------- Compose ----------

export function fmtDate(ms: number): string {
  if (!ms) return "";
  // Local date — keeps day-of-week / hour-of-day semantics consistent with
  // the activity heatmap which also uses local time.
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const projectName = projectNameFor;

function serializeLedgerRows(
  rows: InternalLedgerRow[],
  pricing: PricingTable,
): LedgerRow[] {
  return rows
    .map((row) => {
      let costUSD: number | null = null;
      if (row.usageByModel.size > 0 && row.costBasis !== "unavailable") {
        costUSD = 0;
        for (const [model, usage] of row.usageByModel.entries()) {
          costUSD += usageCost(usage, rawModelFromKey(model), pricing);
        }
      }
      return {
        id: row.id,
        provider: row.provider,
        timestampMs: row.timestampMs,
        date: row.date,
        projectPath: row.projectPath,
        projectName: row.projectName,
        model: row.model,
        interactions: row.interactions,
        toolCalls: row.toolCalls,
        tokens: row.tokens,
        costUSD,
        costBasis: row.costBasis,
        usageByModel: serializeUsageByModel(row.usageByModel, pricing),
      };
    })
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

function serializeUsageByModel(
  usageByModel: Map<string, ModelUsage>,
  pricing: PricingTable,
): Record<string, SerializedModelUsage> {
  return Object.fromEntries(
    Array.from(usageByModel.entries()).map(([model, usage]) => [
      model,
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        reasoningTokens: usage.reasoningOutputTokens ?? 0,
        costUSD: usageCost(usage, rawModelFromKey(model), pricing),
        provider: providerFromModelKey(model),
        isExternal: isExternal(
          rawModelFromKey(model),
          pricing.externalModelPrefixes,
        ),
      },
    ]),
  );
}

function serializeHourlyUsage(
  buckets: Map<number, HourlyUsageBucket>,
  pricing: PricingTable,
) {
  return Array.from(buckets.values())
    .map((bucket) => {
      const tokensByModel = Object.fromEntries(
        Array.from(bucket.usageByModel.entries()).map(([model, usage]) => [
          model,
          modelUsageTotal(usage),
        ]),
      );
      const usageByModel = serializeUsageByModel(bucket.usageByModel, pricing);
      return {
        timestampMs: bucket.timestampMs,
        date: fmtDate(bucket.timestampMs),
        messages: 0,
        sessions: 0,
        toolCalls: 0,
        tokens: Object.values(tokensByModel).reduce(
          (sum, value) => sum + value,
          0,
        ),
        tokensByModel,
        usageByModel,
        costUSD: Object.values(usageByModel).reduce(
          (sum, usage) => sum + usage.costUSD,
          0,
        ),
      };
    })
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

export async function buildStats() {
  const cache = parseStatsCache();
  const {
    byProject,
    weekHourMatrix,
    dailyHistory,
    dailyHourCounts: historyDailyHourCounts,
  } = parseHistory();
  const sessions = parseSessions();
  const [pricingLoad, codexUsageLimits] = await Promise.all([
    loadPricingWithMeta(),
    readCodexUsageLimits(),
  ]);
  const pricing = pricingLoad.table;
  const budget = loadBudgetConfig();
  const usageLimits = readUsageLimits();
  const transcriptUsage = parseTranscriptUsage();
  const codexUsage = parseCodexUsage();
  const openCodeUsage = parseOpenCodeUsage();
  const dataHealth = buildDataHealth({
    claudeTranscriptFiles: transcriptUsage.transcriptFileCount,
    codexSessionFiles: codexUsage.codexSessionFileCount,
    codexThreadRows: codexUsage.codexThreadRowCount,
    openCodeSessionFiles: openCodeUsage.openCodeSessionFileCount,
    openCodeMessageFiles: openCodeUsage.openCodeMessageFileCount,
    openCodeSessionRows: openCodeUsage.openCodeSessionRowCount,
    openCodeMessageRows: openCodeUsage.openCodeMessageRowCount,
  });

  const claudeModelUsage =
    Object.keys(transcriptUsage.modelUsage).length > 0
      ? transcriptUsage.modelUsage
      : (cache.modelUsage ?? {});
  const modelUsage: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(claudeModelUsage)) {
    modelUsage[modelKey("claude", model)] = usage;
  }
  for (const [model, usage] of Object.entries(codexUsage.modelUsage)) {
    modelUsage[model] = usage;
  }
  for (const [model, usage] of Object.entries(openCodeUsage.modelUsage)) {
    modelUsage[model] = usage;
  }
  const dailyActivity = cache.dailyActivity ?? [];
  const dailyModelTokens = cache.dailyModelTokens ?? [];
  const lastCachedActivityDate = dailyActivity
    .map((d) => d.date)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);

  // Merge daily activity with daily model tokens (see daily-activity.ts: the
  // cache wins for the days it covers; history only supplements newer days).
  const { activityByDate, supplementalHistoryDates } = mergeDailyActivity(
    dailyActivity,
    dailyHistory,
    lastCachedActivityDate,
  );
  const tokensByDate = new Map<string, Record<string, number>>();
  for (const d of dailyModelTokens) {
    tokensByDate.set(
      d.date,
      Object.fromEntries(
        Object.entries(d.tokensByModel).map(([model, tokens]) => [
          modelKey("claude", model),
          tokens,
        ]),
      ),
    );
  }
  const combinedDailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  for (const [
    date,
    usageByModel,
  ] of transcriptUsage.dailyModelUsage.entries()) {
    let combined = combinedDailyModelUsage.get(date);
    if (!combined) {
      combined = new Map();
      combinedDailyModelUsage.set(date, combined);
    }
    for (const [model, usage] of usageByModel.entries()) {
      combined.set(modelKey("claude", model), usage);
    }
    if (tokensByDate.has(date)) continue;
    tokensByDate.set(
      date,
      Object.fromEntries(
        Array.from(usageByModel.entries()).map(([model, usage]) => [
          modelKey("claude", model),
          modelUsageTotal(usage),
        ]),
      ),
    );
  }
  for (const [date, usageByModel] of codexUsage.dailyModelUsage.entries()) {
    let combined = combinedDailyModelUsage.get(date);
    if (!combined) {
      combined = new Map();
      combinedDailyModelUsage.set(date, combined);
    }
    const dayTokens = tokensByDate.get(date) ?? {};
    for (const [model, usage] of usageByModel.entries()) {
      combined.set(model, usage);
      dayTokens[model] = (dayTokens[model] ?? 0) + modelUsageTotal(usage);
    }
    tokensByDate.set(date, dayTokens);
  }
  for (const [date, usageByModel] of openCodeUsage.dailyModelUsage.entries()) {
    let combined = combinedDailyModelUsage.get(date);
    if (!combined) {
      combined = new Map();
      combinedDailyModelUsage.set(date, combined);
    }
    const dayTokens = tokensByDate.get(date) ?? {};
    for (const [model, usage] of usageByModel.entries()) {
      combined.set(model, usage);
      dayTokens[model] = (dayTokens[model] ?? 0) + modelUsageTotal(usage);
    }
    tokensByDate.set(date, dayTokens);
  }
  for (const [source, sessionField] of [
    [codexUsage.dailyActivity, "threadCount"],
    [openCodeUsage.dailyActivity, "sessionCount"],
  ] as const) {
    for (const [date, activity] of source.entries()) {
      const current = activityByDate.get(date);
      const sessionCount = activity[sessionField];
      if (current) {
        current.sessionCount += sessionCount;
      } else {
        activityByDate.set(date, {
          date,
          messageCount: 0,
          sessionCount,
          toolCallCount: 0,
        });
      }
    }
  }
  const dailyDates = new Set([
    ...dailyActivity.map((d) => d.date),
    ...supplementalHistoryDates,
    ...tokensByDate.keys(),
    ...combinedDailyModelUsage.keys(),
    ...codexUsage.dailyActivity.keys(),
    ...openCodeUsage.dailyActivity.keys(),
  ]);

  const daily = Array.from(dailyDates)
    .map((date) => {
      const activity = activityByDate.get(date);
      const tokensByModel = tokensByDate.get(date) ?? {};
      const tokens = Object.values(tokensByModel).reduce((a, b) => a + b, 0);
      const usageByModel = combinedDailyModelUsage.get(date);
      let costUSD = 0;
      if (usageByModel) {
        for (const [model, usage] of usageByModel.entries()) {
          costUSD += usageCost(usage, rawModelFromKey(model), pricing);
        }
      }
      const usageByModelRows = usageByModel
        ? serializeUsageByModel(usageByModel, pricing)
        : {};
      const codexThreads = codexUsage.dailyActivity.get(date)?.threadCount ?? 0;
      const openCodeSessions =
        openCodeUsage.dailyActivity.get(date)?.sessionCount ?? 0;
      const claudeSessions = Math.max(
        0,
        (activity?.sessionCount ?? 0) - codexThreads - openCodeSessions,
      );
      const providerDaily = {
        claude: {
          messages: activity?.messageCount ?? 0,
          sessions: claudeSessions,
          toolCalls: activity?.toolCallCount ?? 0,
        },
        codex: {
          messages:
            codexUsage.dailyActivity.get(date)?.interactionCount ??
            codexThreads,
          sessions: codexThreads,
          toolCalls: codexUsage.dailyActivity.get(date)?.toolCallCount ?? 0,
        },
        opencode: {
          messages:
            openCodeUsage.dailyActivity.get(date)?.interactionCount ?? 0,
          sessions: openCodeSessions,
          toolCalls: openCodeUsage.dailyActivity.get(date)?.toolCallCount ?? 0,
        },
      };
      const providerValues = Object.values(providerDaily);
      return {
        date,
        messages: providerValues.reduce(
          (sum, provider) => sum + provider.messages,
          0,
        ),
        sessions: activity?.sessionCount ?? 0,
        toolCalls: providerValues.reduce(
          (sum, provider) => sum + provider.toolCalls,
          0,
        ),
        tokens,
        tokensByModel,
        usageByModel: usageByModelRows,
        costUSD,
        providers: providerDaily,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Per-model summary
  const byModel = Object.entries(modelUsage)
    .map(([model, usage]) => ({
      model,
      provider: providerFromModelKey(model),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      reasoningTokens: usage.reasoningOutputTokens ?? 0,
      costUSD: usageCost(usage, rawModelFromKey(model), pricing),
      isExternal: isExternal(
        rawModelFromKey(model),
        pricing.externalModelPrefixes,
      ),
    }))
    .filter(
      (m) =>
        m.inputTokens +
          m.outputTokens +
          m.cacheReadTokens +
          m.cacheCreationTokens +
          m.reasoningTokens >
        0,
    );

  // Summary totals
  const totalInputTokens = byModel.reduce((s, m) => s + m.inputTokens, 0);
  const totalOutputTokens = byModel.reduce((s, m) => s + m.outputTokens, 0);
  const totalCacheReadTokens = byModel.reduce(
    (s, m) => s + m.cacheReadTokens,
    0,
  );
  const totalCacheCreationTokens = byModel.reduce(
    (s, m) => s + m.cacheCreationTokens,
    0,
  );
  const totalReasoningTokens = byModel.reduce(
    (s, m) => s + m.reasoningTokens,
    0,
  );
  const totalTokens =
    totalInputTokens +
    totalOutputTokens +
    totalCacheReadTokens +
    totalCacheCreationTokens +
    totalReasoningTokens;
  const estimatedCostUSD = byModel.reduce((s, m) => s + m.costUSD, 0);

  // Projects — sum each model's cost per project, combining both providers
  // (codex model keys are namespaced, so strip the prefix before pricing).
  const { projectCost, claudeProjectCost, codexProjectCost } =
    aggregateProjectCosts(
      transcriptUsage.projectModelUsage,
      codexUsage.projectModelUsage,
      (model, usage) => usageCost(usage, model, pricing),
      (model, usage) => usageCost(usage, rawModelFromKey(model), pricing),
    );
  const openCodeProjectCost = new Map<string, number>();
  for (const [path, byModel] of openCodeUsage.projectModelUsage.entries()) {
    let costUSD = 0;
    for (const [model, usage] of byModel.entries()) {
      costUSD += usageCost(usage, rawModelFromKey(model), pricing);
    }
    openCodeProjectCost.set(path, costUSD);
    projectCost.set(path, (projectCost.get(path) ?? 0) + costUSD);
  }

  const projectPaths = new Set([
    ...Array.from(byProject.keys()),
    ...Array.from(codexUsage.projectActivity.keys()),
    ...Array.from(openCodeUsage.projectActivity.keys()),
  ]);
  const projects = Array.from(projectPaths)
    .map((path) => {
      const claude = byProject.get(path);
      const codex = codexUsage.projectActivity.get(path);
      const openCode = openCodeUsage.projectActivity.get(path);
      const models = [
        ...serializeProjectModelUsage(
          "claude",
          transcriptUsage.projectModelUsage.get(path),
          pricing,
        ),
        ...serializeProjectModelUsage(
          "codex",
          codexUsage.projectModelUsage.get(path),
          pricing,
        ),
        ...serializeProjectModelUsage(
          "opencode",
          openCodeUsage.projectModelUsage.get(path),
          pricing,
        ),
      ].sort((a, b) => b.costUSD - a.costUSD);
      const firstSeen = Math.min(
        claude?.firstSeen ?? Number.POSITIVE_INFINITY,
        codex?.firstSeen ?? Number.POSITIVE_INFINITY,
        openCode?.firstSeen ?? Number.POSITIVE_INFINITY,
      );
      const lastSeen = Math.max(
        claude?.lastSeen ?? 0,
        codex?.lastSeen ?? 0,
        openCode?.lastSeen ?? 0,
      );
      const providerTotals = {
        claude: {
          messages: claude?.messageCount ?? 0,
          sessions: 0,
          toolCalls: 0,
          tokens: transcriptUsage.projectTokens.get(path) ?? 0,
          costUSD: claudeProjectCost.get(path) ?? 0,
        },
        codex: {
          messages: codex?.interactionCount ?? 0,
          sessions: codex?.threadCount ?? 0,
          toolCalls: codex?.toolCallCount ?? 0,
          tokens: codexUsage.projectTokens.get(path) ?? 0,
          costUSD: codexProjectCost.get(path) ?? 0,
        },
        opencode: {
          messages: openCode?.interactionCount ?? 0,
          sessions: openCode?.sessionCount ?? 0,
          toolCalls: openCode?.toolCallCount ?? 0,
          tokens: openCodeUsage.projectTokens.get(path) ?? 0,
          costUSD: openCodeProjectCost.get(path) ?? 0,
        },
      };
      return {
        name: projectName(path),
        path,
        messageCount:
          providerTotals.claude.messages +
          providerTotals.codex.messages +
          providerTotals.opencode.messages,
        claudeMessages: claude?.messageCount ?? 0,
        codexMessages: codex?.interactionCount ?? 0,
        codexThreads: codex?.threadCount ?? 0,
        codexToolCalls: codex?.toolCallCount ?? 0,
        openCodeMessages: openCode?.interactionCount ?? 0,
        openCodeSessions: openCode?.sessionCount ?? 0,
        openCodeToolCalls: openCode?.toolCallCount ?? 0,
        claudeTokens: transcriptUsage.projectTokens.get(path) ?? 0,
        codexTokens: codexUsage.projectTokens.get(path) ?? 0,
        openCodeTokens: openCodeUsage.projectTokens.get(path) ?? 0,
        tokens:
          (transcriptUsage.projectTokens.get(path) ?? 0) +
          (codexUsage.projectTokens.get(path) ?? 0) +
          (openCodeUsage.projectTokens.get(path) ?? 0),
        claudeCostUSD: claudeProjectCost.get(path) ?? 0,
        codexCostUSD: codexProjectCost.get(path) ?? 0,
        openCodeCostUSD: openCodeProjectCost.get(path) ?? 0,
        costUSD: projectCost.get(path) ?? 0,
        providers: providerTotals,
        models,
        firstSeen: Number.isFinite(firstSeen) ? fmtDate(firstSeen) : "",
        lastSeen: fmtDate(lastSeen),
        lastSeenMs: lastSeen,
      };
    })
    .sort((a, b) => b.messageCount - a.messageCount);

  // Insights
  const mostActiveDay = daily.reduce<{ date: string; messages: number } | null>(
    (best, d) =>
      !best || d.messages > best.messages
        ? { date: d.date, messages: d.messages }
        : best,
    null,
  );
  const mostUsedModel = byModel.reduce<{
    model: string;
    tokens: number;
  } | null>((best, m) => {
    const tokens =
      m.inputTokens +
      m.outputTokens +
      m.cacheReadTokens +
      m.cacheCreationTokens;
    return !best || tokens > best.tokens ? { model: m.model, tokens } : best;
  }, null);
  const combinedWeekHourMatrix = weekHourMatrix.map((row, dow) =>
    row.map(
      (value, hour) =>
        value +
        (codexUsage.weekHourMatrix[dow]?.[hour] ?? 0) +
        (openCodeUsage.weekHourMatrix[dow]?.[hour] ?? 0),
    ),
  );
  const combinedDailyHourCounts: Record<string, number[]> = {};
  for (const [date, counts] of historyDailyHourCounts) {
    combinedDailyHourCounts[date] = [...counts];
  }
  for (const source of [
    codexUsage.dailyHourCounts,
    openCodeUsage.dailyHourCounts,
  ]) {
    for (const [date, counts] of source) {
      const existing = combinedDailyHourCounts[date];
      if (existing) {
        for (let h = 0; h < 24; h++) existing[h] += counts[h] ?? 0;
      } else {
        combinedDailyHourCounts[date] = [...counts];
      }
    }
  }
  const totalSessions =
    (cache.totalSessions ?? 0) +
    codexUsage.totalThreads +
    openCodeUsage.totalSessions;
  const totalMessages =
    (cache.totalMessages ?? 0) +
    codexUsage.totalInteractions +
    openCodeUsage.totalInteractions;
  const averageMessagesPerSession = totalSessions
    ? totalMessages / totalSessions
    : 0;
  const mostActiveProject = projects[0]?.name ?? null;

  const periodFrom = daily[0]?.date ?? "";
  const periodTo = daily[daily.length - 1]?.date ?? "";
  const ledger = serializeLedgerRows(
    [...transcriptUsage.ledger, ...codexUsage.ledger, ...openCodeUsage.ledger],
    pricing,
  );
  const hourlyUsage = new Map<number, HourlyUsageBucket>();
  for (const source of [
    transcriptUsage.hourlyUsage,
    codexUsage.hourlyUsage,
    openCodeUsage.hourlyUsage,
  ]) {
    for (const bucket of source.values()) {
      for (const [model, usage] of bucket.usageByModel.entries()) {
        addHourlyUsage(hourlyUsage, bucket.timestampMs, model, usage);
      }
    }
  }

  return {
    period: { from: periodFrom, to: periodTo },
    summary: {
      totalSessions,
      totalMessages,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalReasoningTokens,
      totalToolCalls: daily.reduce((sum, d) => sum + (d.toolCalls ?? 0), 0),
      estimatedCostUSD,
      providers: {
        claude: {
          totalSessions: cache.totalSessions ?? 0,
          totalMessages: cache.totalMessages ?? 0,
        },
        codex: {
          totalSessions: codexUsage.totalThreads,
          totalMessages: codexUsage.totalInteractions,
          totalToolCalls: codexUsage.totalToolCalls,
        },
        opencode: {
          totalSessions: openCodeUsage.totalSessions,
          totalMessages: openCodeUsage.totalInteractions,
          totalToolCalls: openCodeUsage.totalToolCalls,
        },
      },
    },
    byModel: byModel.sort((a, b) => b.costUSD - a.costUSD),
    pricingMeta: pricingMetaForModels(
      pricingLoad,
      byModel.map((m) => m.model),
    ),
    budget,
    usageLimits,
    codexUsageLimits,
    dataHealth,
    daily,
    ledger,
    hourlyUsage: serializeHourlyUsage(hourlyUsage, pricing),
    activityDays: Array.from(activityByDate.entries())
      .map(([date, activity]) => ({
        date,
        messages: activity.messageCount,
        sessions: activity.sessionCount,
        interactions: activity.messageCount + activity.sessionCount,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourlyDistribution: cache.hourCounts ?? {},
    weekHourMatrix: combinedWeekHourMatrix,
    dailyHourCounts: combinedDailyHourCounts,
    projects,
    sessions,
    insights: {
      mostActiveDay: mostActiveDay?.date ?? null,
      mostActiveDayMessages: mostActiveDay?.messages ?? 0,
      mostUsedModel: mostUsedModel?.model ?? null,
      averageMessagesPerSession:
        Math.round(averageMessagesPerSession * 10) / 10,
      mostActiveProject,
      firstSessionDate: cache.firstSessionDate ?? null,
      longestSession: cache.longestSession ?? null,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      cacheVersion: cache.version ?? null,
      lastComputedDate: cache.lastComputedDate ?? null,
    },
  };
}

// CLI mode: print JSON
if (import.meta.main) {
  buildStats()
    .then((data) => {
      process.stdout.write(JSON.stringify(data, null, 2));
    })
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
