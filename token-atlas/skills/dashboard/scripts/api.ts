#!/usr/bin/env bun
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const CODEX_DIR = join(HOME, ".codex");
const CODEX_STATE_DB = join(CODEX_DIR, "state_5.sqlite");
const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
const STATS_CACHE = join(CLAUDE_DIR, "stats-cache.json");
const HISTORY = join(CLAUDE_DIR, "history.jsonl");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
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
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

// ---------- Types ----------

type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
type PricingTable = {
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
  };
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
};

type Provider = "claude" | "codex";

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
  userMessages: number;
  toolCalls: number;
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
type TranscriptUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type TranscriptEntry = {
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  type?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: TranscriptUsage;
  };
};

// ---------- Utils ----------

function safeReadJSON<T>(path: string): T | null {
  const result = readJSONWithError<T>(path);
  return result.data;
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

function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-") || model.startsWith("anthropic/claude-");
}

function isExternal(model: string, prefixes: string[]): boolean {
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
        "Pricing override",
        USER_PRICING_OVERRIDE,
        "optional user pricing",
      ),
    ],
    counts,
  };
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
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
            table.models[m.id] = { input, output, cacheRead, cacheWrite };
            sourceByModel[m.id] = "live";
            meta.openRouter.used = true;
          }
        }
      } else {
        meta.openRouter.error = `HTTP ${res.status}`;
      }
    } catch (err) {
      meta.openRouter.error =
        err instanceof Error ? err.name || err.message : "OpenRouter failed";
    } finally {
      clearTimeout(timer);
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

function priceFor(model: string, table: PricingTable): ModelPrice {
  return (
    table.models[model] ?? table.models[`openai/${model}`] ?? table.fallback
  );
}

function pricingSourceForModel(
  model: string,
  pricing: PricingLoad,
): PricingSource | "fallback" {
  const raw = rawModelFromKey(model);
  if (pricing.sourceByModel[raw]) return pricing.sourceByModel[raw];
  const openAIKey = `openai/${raw}`;
  if (pricing.sourceByModel[openAIKey]) return pricing.sourceByModel[openAIKey];
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

function calcCost(
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
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: Array<{
    pid: number;
    sessionId: string;
    cwd: string;
    startedAt: number;
    status: string;
    updatedAt?: number;
    version?: string;
  }> = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const data = safeReadJSON<{
      pid: number;
      sessionId: string;
      cwd: string;
      startedAt: number;
      status: string;
      updatedAt?: number;
      version?: string;
    }>(join(SESSIONS_DIR, f));
    if (data) out.push(data);
  }
  return out;
}

function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addUsage(target: ModelUsage, usage: TranscriptUsage): void {
  target.inputTokens += usage.input_tokens ?? 0;
  target.outputTokens += usage.output_tokens ?? 0;
  target.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  target.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
}

function usageTokenTotal(usage: TranscriptUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function modelKey(provider: Provider, model: string): string {
  return `${provider}:${model}`;
}

function providerFromModelKey(key: string): Provider {
  return key.startsWith("codex:") ? "codex" : "claude";
}

function rawModelFromKey(key: string): string {
  return key.replace(/^(claude|codex):/, "");
}

function addModelUsage(target: ModelUsage, source: ModelUsage): void {
  target.inputTokens += source.inputTokens ?? 0;
  target.outputTokens += source.outputTokens ?? 0;
  target.cacheReadInputTokens += source.cacheReadInputTokens ?? 0;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens ?? 0;
  target.reasoningOutputTokens =
    (target.reasoningOutputTokens ?? 0) + (source.reasoningOutputTokens ?? 0);
}

function modelUsageTotal(usage: ModelUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens +
    (usage.reasoningOutputTokens ?? 0)
  );
}

function walkJsonlFiles(dir: string, out: string[] = []): string[] {
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
      walkJsonlFiles(path, out);
    } else if (stat.isFile() && path.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

function parseTranscriptUsage(): {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
  projectTokens: Map<string, number>;
  projectModelUsage: Map<string, Map<string, ModelUsage>>;
  transcriptFileCount: number;
} {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
  const projectTokens = new Map<string, number>();
  const projectModelUsage = new Map<string, Map<string, ModelUsage>>();
  const seen = new Set<string>();
  const transcriptFiles = walkJsonlFiles(PROJECTS_DIR);

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

      const model = entry.message?.model;
      const usage = entry.message?.usage;
      if (entry.type !== "assistant" || !model || !usage) continue;
      if (model === "<synthetic>" || usageTokenTotal(usage) === 0) continue;

      // Claude Code can persist multiple snapshots for one API request
      // (thinking/text/tool_use). Billing usage is identical on those lines,
      // so count a request only once.
      const key =
        entry.requestId && entry.message.id
          ? `${entry.requestId}:${entry.message.id}`
          : (entry.uuid ?? `${file}:${seen.size}`);
      if (seen.has(key)) continue;
      seen.add(key);

      const tokenTotal = usageTokenTotal(usage);
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

  return {
    modelUsage,
    dailyModelUsage,
    projectTokens,
    projectModelUsage,
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
        info?: { total_token_usage?: CodexTokenUsage };
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
      }
    }
  }
  return {
    id,
    timestampMs,
    cwd,
    model,
    tokenUsage: latest,
    userMessages: Math.max(responseUserMessages, eventUserMessages),
    toolCalls,
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

function parseCodexUsage(): {
  modelUsage: Record<string, ModelUsage>;
  dailyModelUsage: Map<string, Map<string, ModelUsage>>;
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
  codexSessionFileCount: number;
  codexThreadRowCount: number;
} {
  const modelUsage: Record<string, ModelUsage> = {};
  const dailyModelUsage = new Map<string, Map<string, ModelUsage>>();
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
  const codexSessionFiles = walkJsonlFiles(CODEX_SESSIONS_DIR);
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
  }

  return {
    modelUsage,
    dailyModelUsage,
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
    codexSessionFileCount: codexSessionFiles.length,
    codexThreadRowCount: rows.length,
  };
}

// ---------- Compose ----------

function fmtDate(ms: number): string {
  if (!ms) return "";
  // Local date — keeps day-of-week / hour-of-day semantics consistent with
  // the activity heatmap which also uses local time.
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function projectName(path: string): string {
  // Last non-empty path segment
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
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
  const pricingLoad = await loadPricingWithMeta();
  const pricing = pricingLoad.table;
  const transcriptUsage = parseTranscriptUsage();
  const codexUsage = parseCodexUsage();
  const dataHealth = buildDataHealth({
    claudeTranscriptFiles: transcriptUsage.transcriptFileCount,
    codexSessionFiles: codexUsage.codexSessionFileCount,
    codexThreadRows: codexUsage.codexThreadRowCount,
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
  const dailyActivity = cache.dailyActivity ?? [];
  const dailyModelTokens = cache.dailyModelTokens ?? [];
  const lastCachedActivityDate = dailyActivity
    .map((d) => d.date)
    .sort((a, b) => a.localeCompare(b))
    .at(-1);

  // Merge daily activity with daily model tokens
  const activityByDate = new Map(dailyActivity.map((d) => [d.date, d]));
  const supplementalHistoryDates: string[] = [];
  for (const [date, historyActivity] of dailyHistory.entries()) {
    if (activityByDate.has(date)) continue;
    if (lastCachedActivityDate && date <= lastCachedActivityDate) continue;
    activityByDate.set(date, {
      date,
      messageCount: historyActivity.messageCount,
      sessionCount: historyActivity.sessionIds.size,
      toolCallCount: 0,
    });
    supplementalHistoryDates.push(date);
  }
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
  for (const [date, activity] of codexUsage.dailyActivity.entries()) {
    const current = activityByDate.get(date);
    if (current) {
      current.sessionCount += activity.threadCount;
    } else {
      activityByDate.set(date, {
        date,
        messageCount: 0,
        sessionCount: activity.threadCount,
        toolCallCount: 0,
      });
    }
  }
  const dailyDates = new Set([
    ...dailyActivity.map((d) => d.date),
    ...supplementalHistoryDates,
    ...tokensByDate.keys(),
    ...combinedDailyModelUsage.keys(),
    ...codexUsage.dailyActivity.keys(),
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
          costUSD += calcCost(usage, rawModelFromKey(model), pricing);
        }
      }
      const usageByModelRows = usageByModel
        ? Object.fromEntries(
            Array.from(usageByModel.entries()).map(([model, usage]) => [
              model,
              {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadInputTokens,
                cacheCreationTokens: usage.cacheCreationInputTokens,
                reasoningTokens: usage.reasoningOutputTokens ?? 0,
                costUSD: calcCost(usage, rawModelFromKey(model), pricing),
                provider: providerFromModelKey(model),
                isExternal: isExternal(
                  rawModelFromKey(model),
                  pricing.externalModelPrefixes,
                ),
              },
            ]),
          )
        : {};
      const codexThreads = codexUsage.dailyActivity.get(date)?.threadCount ?? 0;
      const claudeSessions = Math.max(
        0,
        (activity?.sessionCount ?? 0) - codexThreads,
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
      };
      return {
        date,
        messages: providerDaily.claude.messages + providerDaily.codex.messages,
        sessions: activity?.sessionCount ?? 0,
        toolCalls:
          providerDaily.claude.toolCalls + providerDaily.codex.toolCalls,
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
      costUSD: calcCost(usage, rawModelFromKey(model), pricing),
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

  // Projects
  const projectCost = new Map<string, number>();
  const claudeProjectCost = new Map<string, number>();
  const codexProjectCost = new Map<string, number>();
  for (const [path, byModel] of transcriptUsage.projectModelUsage.entries()) {
    let costUSD = 0;
    for (const [model, usage] of byModel.entries()) {
      costUSD += calcCost(usage, model, pricing);
    }
    claudeProjectCost.set(path, costUSD);
    projectCost.set(path, costUSD);
  }
  for (const [path, byModel] of codexUsage.projectModelUsage.entries()) {
    let costUSD = 0;
    for (const [model, usage] of byModel.entries()) {
      costUSD += calcCost(usage, rawModelFromKey(model), pricing);
    }
    codexProjectCost.set(path, costUSD);
    projectCost.set(path, (projectCost.get(path) ?? 0) + costUSD);
  }

  const projectPaths = new Set([
    ...Array.from(byProject.keys()),
    ...Array.from(codexUsage.projectActivity.keys()),
  ]);
  const projects = Array.from(projectPaths)
    .map((path) => {
      const claude = byProject.get(path);
      const codex = codexUsage.projectActivity.get(path);
      const firstSeen = Math.min(
        claude?.firstSeen ?? Number.POSITIVE_INFINITY,
        codex?.firstSeen ?? Number.POSITIVE_INFINITY,
      );
      const lastSeen = Math.max(claude?.lastSeen ?? 0, codex?.lastSeen ?? 0);
      return {
        name: projectName(path),
        path,
        messageCount:
          (claude?.messageCount ?? 0) + (codex?.interactionCount ?? 0),
        claudeMessages: claude?.messageCount ?? 0,
        codexMessages: codex?.interactionCount ?? 0,
        codexThreads: codex?.threadCount ?? 0,
        codexToolCalls: codex?.toolCallCount ?? 0,
        claudeTokens: transcriptUsage.projectTokens.get(path) ?? 0,
        codexTokens: codexUsage.projectTokens.get(path) ?? 0,
        tokens:
          (transcriptUsage.projectTokens.get(path) ?? 0) +
          (codexUsage.projectTokens.get(path) ?? 0),
        claudeCostUSD: claudeProjectCost.get(path) ?? 0,
        codexCostUSD: codexProjectCost.get(path) ?? 0,
        costUSD: projectCost.get(path) ?? 0,
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
      (value, hour) => value + (codexUsage.weekHourMatrix[dow]?.[hour] ?? 0),
    ),
  );
  const combinedDailyHourCounts: Record<string, number[]> = {};
  for (const [date, counts] of historyDailyHourCounts) {
    combinedDailyHourCounts[date] = [...counts];
  }
  for (const [date, counts] of codexUsage.dailyHourCounts) {
    const existing = combinedDailyHourCounts[date];
    if (existing) {
      for (let h = 0; h < 24; h++) existing[h] += counts[h] ?? 0;
    } else {
      combinedDailyHourCounts[date] = [...counts];
    }
  }
  const totalSessions = (cache.totalSessions ?? 0) + codexUsage.totalThreads;
  const totalMessages =
    (cache.totalMessages ?? 0) + codexUsage.totalInteractions;
  const averageMessagesPerSession = totalSessions
    ? totalMessages / totalSessions
    : 0;
  const mostActiveProject = projects[0]?.name ?? null;

  const periodFrom = daily[0]?.date ?? "";
  const periodTo = daily[daily.length - 1]?.date ?? "";

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
      },
    },
    byModel: byModel.sort((a, b) => b.costUSD - a.costUSD),
    pricingMeta: pricingMetaForModels(
      pricingLoad,
      byModel.map((m) => m.model),
    ),
    dataHealth,
    daily,
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
