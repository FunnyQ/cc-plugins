import { createApp } from "/vendor/petite-vue.es.js";

// Chart.js is UMD; load via script injection so it attaches to window.
let chartLoadPromise = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (chartLoadPromise) return chartLoadPromise;
  chartLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/chart.umd.js";
    s.onload = () => resolve(window.Chart);
    s.onerror = () => {
      chartLoadPromise = null;
      reject(new Error("Failed to load /vendor/chart.umd.js"));
    };
    document.head.appendChild(s);
  });
  return chartLoadPromise;
}

// ---------- Color palette ----------

// Sunrise spectrum — Claude pulls warm dawn hues, Codex pulls cool dusk hues.
// Both readable on warm-light surface and dusk-dark surface.
const CLAUDE_PALETTE = [
  "oklch(66% 0.20 25)",
  "oklch(72% 0.18 50)",
  "oklch(80% 0.16 70)",
  "oklch(60% 0.20 15)",
  "oklch(76% 0.14 60)",
  "oklch(82% 0.12 85)",
  "oklch(64% 0.20 35)",
  "oklch(70% 0.16 45)",
];

const CODEX_PALETTE = [
  "oklch(58% 0.20 305)",
  "oklch(62% 0.22 340)",
  "oklch(58% 0.18 285)",
  "oklch(64% 0.16 260)",
  "oklch(72% 0.12 250)",
  "oklch(54% 0.20 320)",
  "oklch(68% 0.14 235)",
  "oklch(60% 0.16 290)",
];

const OTHER_COLOR = "oklch(64% 0.014 50)";

const colorCache = new Map();
function colorFor(model) {
  if (model === "__other__") return OTHER_COLOR;
  if (!colorCache.has(model)) {
    const palette =
      providerForModel(model) === "codex" ? CODEX_PALETTE : CLAUDE_PALETTE;
    const idx = hashString(rawModel(model)) % palette.length;
    colorCache.set(model, palette[idx]);
  }
  return colorCache.get(model);
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ---------- Formatters ----------

function fmtNum(n) {
  if (n == null) return "n/a";
  return n.toLocaleString();
}

function fmtTokens(n) {
  if (n == null || n === 0) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtUSD(n) {
  if (n == null || n === 0) return "$0";
  if (n >= 1_000)
    return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 10) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}

function shortModel(m) {
  const provider = providerForModel(m);
  const raw = rawModel(m)
    .replace("anthropic/", "")
    .replace(/-\d{8}$/, "")
    .replace("claude-", "");
  const compact = raw.includes("/") ? raw.split("/").pop() : raw;
  if (provider === "codex") return `Codex · ${compact}`;
  if (provider === "claude") return `Claude · ${compact}`;
  return compact;
}

function providerForModel(m) {
  if (m.startsWith("codex:")) return "codex";
  if (m.startsWith("claude:")) return "claude";
  return "claude";
}

function rawModel(m) {
  return m
    .replace(/^(claude|codex):/, "")
    .replace("anthropic/", "")
    .replace(/-\d{8}$/, "")
    .replace("claude-", "");
}

function modelMarkClass(model) {
  return {
    dot: true,
    "dot--codex": providerForModel(model) === "codex",
    "dot--claude": providerForModel(model) === "claude",
  };
}

function providerBadgeClass(provider) {
  return {
    badge: true,
    "badge--claude": provider === "claude",
    "badge--codex": provider === "codex",
  };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Chart instances stay outside reactive scope because petite-vue 0.4 deep-reactivates
// any object property, but Chart.js stores Maps internally which crashes its
// reactive Proxy creation (`new Proxy(map, null)`).
const charts = { trend: null, donut: null };
const AUTO_REFRESH_MS = 60_000;
const ANOMALY_MULTIPLIER = 2;
const ANOMALY_MIN_COST = 1;
const ANOMALY_MIN_TOKENS = 50_000;
const LEDGER_INITIAL_VISIBLE = 5;
const LEDGER_PAGE_SIZE = 50;
const PREFS_STORAGE_KEY = "token-atlas:prefs:v1";
const THEME_STORAGE_KEY = "token-atlas:theme:v1";

function loadStoredTheme() {
  try {
    const raw = window.localStorage?.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

function saveStoredTheme(mode) {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Theme is optional; keep usable when storage is blocked.
  }
}

function detectInitialTheme() {
  const stored = loadStoredTheme();
  if (stored) return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
const MODEL_EXPORT_HEADERS = [
  "model",
  "label",
  "provider",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
  "totalTokens",
  "costUSD",
  "isExternal",
];
const PROJECT_EXPORT_HEADERS = [
  "name",
  "path",
  "provider",
  "range",
  "messages",
  "tokens",
  "costUSD",
  "claudeMessages",
  "codexMessages",
  "codexThreads",
  "codexToolCalls",
  "claudeTokens",
  "codexTokens",
  "claudeCostUSD",
  "codexCostUSD",
  "firstSeen",
  "lastSeen",
];
const TOKEN_BUCKETS = [
  {
    key: "inputTokens",
    label: "Input",
    className: "token-composition-segment--input",
  },
  {
    key: "outputTokens",
    label: "Output",
    className: "token-composition-segment--output",
  },
  {
    key: "cacheReadTokens",
    label: "Cache read",
    className: "token-composition-segment--cache-read",
  },
  {
    key: "cacheCreationTokens",
    label: "Cache write",
    className: "token-composition-segment--cache-write",
  },
  {
    key: "reasoningTokens",
    label: "Reasoning",
    className: "token-composition-segment--reasoning",
  },
];
const ALLOWED_PREFS = {
  providerKey: ["all", "claude", "codex"],
  rangeKey: ["7", "30", "90", "all"],
  trendMode: ["tokens", "cost"],
  trendModelScope: ["all", "top5"],
  topProjectMode: ["tokens", "cost"],
};

function loadStoredPrefs() {
  try {
    const raw = window.localStorage?.getItem(PREFS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredPrefs(prefs) {
  try {
    window.localStorage?.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are optional; keep the dashboard usable when storage is blocked.
  }
}

function normalizePrefs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const prefs = {};
  for (const [key, allowed] of Object.entries(ALLOWED_PREFS)) {
    if (allowed.includes(raw[key])) prefs[key] = raw[key];
  }
  if (
    raw.selectedModels &&
    typeof raw.selectedModels === "object" &&
    !Array.isArray(raw.selectedModels)
  ) {
    const selectedModels = {};
    for (const [model, selected] of Object.entries(raw.selectedModels)) {
      if (typeof model === "string" && typeof selected === "boolean") {
        selectedModels[model] = selected;
      }
    }
    prefs.selectedModels = selectedModels;
  }
  return prefs;
}

function enrichProjectRow(p, value, claudeValue, codexValue, total, fmt) {
  const providerTotal = claudeValue + codexValue || value || 1;
  return {
    ...p,
    displayLabel: fmt(value),
    pct: ((value / total) * 100).toFixed(1),
    claudePct: ((claudeValue / providerTotal) * 100).toFixed(1),
    codexPct: ((codexValue / providerTotal) * 100).toFixed(1),
    hasClaude: claudeValue > 0,
    hasCodex: codexValue > 0,
    claudeDisplay: fmt(claudeValue),
    codexDisplay: fmt(codexValue),
  };
}

// ---------- App ----------

function App() {
  const initialPrefs = normalizePrefs(loadStoredPrefs());

  return {
    stats: null,
    loading: false,
    refreshInFlight: false,
    refreshTimer: null,
    error: null,
    rangeKey: initialPrefs.rangeKey ?? "7",
    providerKey: initialPrefs.providerKey ?? "all",
    trendMode: initialPrefs.trendMode ?? "tokens",
    trendModelScope: initialPrefs.trendModelScope ?? "all",
    topProjectMode: initialPrefs.topProjectMode ?? "tokens",
    selectedModels: initialPrefs.selectedModels ?? {},
    selectedProjectPath: null,
    modalScrollY: 0,
    ledgerSortKey: "date",
    ledgerVisibleCount: LEDGER_INITIAL_VISIBLE,
    themeMode: detectInitialTheme(),
    loaderVisible: true,
    loaderFading: false,
    loadingTitleChars: "Reading local traces".split(""),

    async mounted() {
      this.applyTheme(this.themeMode);
      this.loading = true;
      this.error = null;
      try {
        await loadChartJs();
      } catch (err) {
        this.error = err.message ?? String(err);
        this.loading = false;
        return;
      }
      await this.refresh();
      this.startAutoRefresh();
    },

    applyTheme(mode) {
      const resolved = mode === "dark" ? "dark" : "light";
      this.themeMode = resolved;
      document.documentElement.dataset.theme = resolved;
    },

    toggleTheme() {
      const next = this.themeMode === "dark" ? "light" : "dark";
      const apply = () => {
        this.applyTheme(next);
        saveStoredTheme(next);
        // Charts read cssVar at render time — redraw so tooltip/grid pick up new theme
        this.$nextTick(() => {
          this.renderTrend();
          this.renderDonut();
        });
      };
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (document.startViewTransition && !reduceMotion) {
        document.startViewTransition(apply);
      } else {
        apply();
      }
    },

    startAutoRefresh() {
      if (this.refreshTimer) window.clearInterval(this.refreshTimer);
      this.refreshTimer = window.setInterval(() => {
        if (document.hidden) return;
        this.refresh({ quiet: true });
      }, AUTO_REFRESH_MS);
    },

    async refresh(options = {}) {
      if (this.refreshInFlight) return;
      const quiet = options.quiet === true && this.stats;
      this.refreshInFlight = true;
      if (!quiet) this.loading = true;
      if (!quiet) this.error = null;
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        this.stats = data;
        this.reconcileSelectedModels();
        this.reconcileSelectedProject();
        await this.$nextTick();
        this.renderTrend();
        this.renderDonut();
        if (this.loaderVisible && !this.loaderFading) {
          this.loaderFading = true;
          // Match the staggered exit: 400ms blur + 350ms opacity fade = 750ms,
          // plus a small tail before unmounting.
          window.setTimeout(() => {
            this.loaderVisible = false;
          }, 800);
        }
      } catch (err) {
        if (quiet) {
          console.warn("Auto refresh failed", err);
        } else {
          this.error = err.message ?? String(err);
        }
      } finally {
        this.refreshInFlight = false;
        if (!quiet) this.loading = false;
      }
    },

    onRangeChange() {
      // Overview, trend, distribution, and per-model table are windowed.
      this.ledgerVisibleCount = LEDGER_INITIAL_VISIBLE;
      this.savePrefs();
      this.$nextTick(() => {
        this.renderTrend();
        this.renderDonut();
      });
    },

    onProviderChange(provider) {
      this.providerKey = provider;
      this.ledgerVisibleCount = LEDGER_INITIAL_VISIBLE;
      this.reconcileSelectedModels();
      this.savePrefs();
      this.$nextTick(() => {
        this.renderTrend();
        this.renderDonut();
      });
    },

    onTrendModeChange(mode) {
      this.trendMode = mode;
      this.savePrefs();
      this.$nextTick(() => this.renderTrend());
    },

    onTrendModelScopeChange(scope) {
      this.trendModelScope = scope;
      this.savePrefs();
      this.$nextTick(() => this.renderTrend());
    },

    onTopProjectModeChange(mode) {
      this.topProjectMode = mode;
      this.savePrefs();
    },

    onLedgerSortChange(sortKey) {
      this.ledgerSortKey = sortKey;
    },

    onSelectedModelsChange() {
      this.savePrefs();
      this.renderTrend();
    },

    exportCurrentViewJSON() {
      const content = JSON.stringify(this.exportPayload(), null, 2);
      this.downloadBlob(
        this.exportFilename("current-view", "json"),
        content,
        "application/json;charset=utf-8",
      );
    },

    exportModelsCSV() {
      const rows = this.filteredByModel.map((model) => ({
        model: model.model,
        label: shortModel(model.model),
        provider: model.provider ?? providerForModel(model.model),
        inputTokens: model.inputTokens ?? 0,
        outputTokens: model.outputTokens ?? 0,
        cacheReadTokens: model.cacheReadTokens ?? 0,
        cacheCreationTokens: model.cacheCreationTokens ?? 0,
        reasoningTokens: model.reasoningTokens ?? 0,
        totalTokens: this.modelTokenTotal(model),
        costUSD: this.formatCSVNumber(model.costUSD ?? 0),
        isExternal: model.isExternal === true,
      }));
      this.downloadBlob(
        this.exportFilename("models", "csv"),
        this.toCSV(rows, MODEL_EXPORT_HEADERS),
        "text/csv;charset=utf-8",
      );
    },

    exportProjectsCSV() {
      this.downloadBlob(
        this.exportFilename("projects", "csv"),
        this.toCSV(this.exportProjectRows(), PROJECT_EXPORT_HEADERS),
        "text/csv;charset=utf-8",
      );
    },

    // ---------- Computed ----------

    get allModels() {
      if (!this.stats) return [];
      const set = new Set();
      for (const d of this.stats.daily) {
        for (const m of Object.keys(d.tokensByModel ?? {})) set.add(m);
        for (const m of Object.keys(d.usageByModel ?? {})) set.add(m);
      }
      return [...set]
        .filter(
          (m) =>
            this.providerKey === "all" ||
            providerForModel(m) === this.providerKey,
        )
        .sort();
    },

    get filteredDaily() {
      if (!this.stats) return [];
      const all = this.stats.daily;
      const providerFiltered = all.map((d) => this.filterDayByProvider(d));
      if (this.rangeKey === "all") return providerFiltered;
      const days = parseInt(this.rangeKey, 10);
      return providerFiltered.slice(-days);
    },

    get filtered() {
      return { summary: this.summarizeDaily(this.filteredDaily) };
    },

    get comparisonDaily() {
      if (!this.stats || this.rangeKey === "all") return [];
      const days = parseInt(this.rangeKey, 10);
      if (!Number.isFinite(days) || days <= 0) return [];
      const providerFiltered = this.stats.daily.map((d) =>
        this.filterDayByProvider(d),
      );
      const currentStart = Math.max(0, providerFiltered.length - days);
      const previousStart = Math.max(0, currentStart - days);
      return providerFiltered.slice(previousStart, currentStart);
    },

    get previousTrendAvailable() {
      return (
        this.rangeKey !== "all" &&
        this.activeTrendModels.length > 0 &&
        this.comparisonDaily.length === this.filteredDaily.length
      );
    },

    get previousTrendLabel() {
      if (this.rangeKey === "all") return "";
      return `Previous ${this.rangeKey}d`;
    },

    get comparisonSummary() {
      return this.summarizeDaily(this.comparisonDaily);
    },

    get summaryDeltas() {
      const current = this.filtered.summary;
      const previous = this.comparisonSummary;
      const currentDays = this.filteredDaily.length || 1;
      const previousDays = this.comparisonDaily.length || 1;
      return {
        cost: this.buildSummaryDelta("cost", current.cost, previous.cost),
        dailyBurn: this.buildSummaryDelta(
          "dailyBurn",
          current.cost / currentDays,
          this.comparisonDaily.length > 0 ? previous.cost / previousDays : 0,
        ),
        tokens: this.buildSummaryDelta(
          "tokens",
          current.tokens,
          previous.tokens,
        ),
        messages: this.buildSummaryDelta(
          "messages",
          current.messages,
          previous.messages,
        ),
        sessions: this.buildSummaryDelta(
          "sessions",
          current.sessions,
          previous.sessions,
        ),
        toolCalls: this.buildSummaryDelta(
          "toolCalls",
          current.toolCalls,
          previous.toolCalls,
        ),
      };
    },

    get dailyBurnUSD() {
      const days = this.filteredDaily.length || 0;
      if (!days) return 0;
      return this.filtered.summary.cost / days;
    },

    /* Sparkline series for daily cost — used in the Daily burn card.
       Returns SVG polyline points string sized for a 100×24 viewBox,
       so the consumer can drop it straight into a <polyline points="..."/>. */
    get costSparkSeries() {
      const series = this.filteredDaily.map((d) => d.costUSD || 0);
      if (!series.length) return { points: "", max: 0, hasData: false };
      const max = Math.max(...series);
      if (max <= 0) return { points: "", max, hasData: false };
      const W = 100;
      const H = 24;
      const lastIdx = Math.max(1, series.length - 1);
      const points = series
        .map((v, i) => {
          const x = (i / lastIdx) * W;
          const y = H - (v / max) * (H - 2) - 1;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
      return { points, max, hasData: true };
    },

    summarizeDaily(daily) {
      let messages = 0,
        sessions = 0,
        toolCalls = 0,
        tokens = 0,
        cost = 0;
      for (const d of daily) {
        messages += d.messages || 0;
        sessions += d.sessions || 0;
        toolCalls += d.toolCalls || 0;
        tokens += d.tokens || 0;
        cost += d.costUSD || 0;
      }
      // Older API payloads did not include daily costs; keep a fallback so the
      // dashboard still renders if a stale server is open.
      if (cost === 0 && this.stats) {
        let dailyTotal = 0;
        for (const d of this.stats.daily) dailyTotal += d.tokens || 0;
        if (dailyTotal > 0) {
          cost =
            (tokens / dailyTotal) * (this.stats.summary.estimatedCostUSD || 0);
        }
      }
      return { messages, sessions, toolCalls, tokens, cost };
    },

    get filteredByModel() {
      if (!this.stats) return [];
      if (this.rangeKey === "all") {
        return this.stats.byModel
          .filter(
            (m) =>
              (this.providerKey === "all" ||
                (m.provider ?? providerForModel(m.model)) ===
                  this.providerKey) &&
              (m.inputTokens ?? 0) +
                (m.outputTokens ?? 0) +
                (m.cacheReadTokens ?? 0) +
                (m.cacheCreationTokens ?? 0) +
                (m.reasoningTokens ?? 0) +
                (m.costUSD ?? 0) >
                0,
          )
          .sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0));
      }

      const byModel = new Map();
      for (const d of this.filteredDaily) {
        for (const [model, usage] of Object.entries(d.usageByModel ?? {})) {
          const current = byModel.get(model) ?? {
            model,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
            costUSD: 0,
            provider: usage.provider ?? providerForModel(model),
            isExternal: usage.isExternal,
          };
          current.inputTokens += usage.inputTokens ?? 0;
          current.outputTokens += usage.outputTokens ?? 0;
          current.cacheReadTokens += usage.cacheReadTokens ?? 0;
          current.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
          current.reasoningTokens += usage.reasoningTokens ?? 0;
          current.costUSD += usage.costUSD ?? 0;
          current.isExternal = current.isExternal || usage.isExternal;
          byModel.set(model, current);
        }
      }

      return Array.from(byModel.values())
        .filter(
          (m) =>
            m.inputTokens +
              m.outputTokens +
              m.cacheReadTokens +
              m.cacheCreationTokens +
              m.reasoningTokens +
              m.costUSD >
            0,
        )
        .sort((a, b) => b.costUSD - a.costUSD);
    },

    get defaultTrendModels() {
      if (!this.stats) return [];
      return [...this.stats.byModel]
        .sort((a, b) => this.modelTokenTotal(b) - this.modelTokenTotal(a))
        .slice(0, 5)
        .map((m) => m.model);
    },

    get trendModels() {
      const activeSet = new Set(this.filteredByModel.map((m) => m.model));
      if (this.trendModelScope === "top5") {
        const top = new Set(this.defaultTrendModels);
        return this.allModels.filter((m) => top.has(m) && activeSet.has(m));
      }
      return this.allModels.filter((m) => activeSet.has(m));
    },

    get activeTrendModels() {
      return this.trendModels.filter((m) => this.selectedModels[m]);
    },

    get maxModelCost() {
      return this.filteredByModel.reduce(
        (max, m) => Math.max(max, m.costUSD ?? 0),
        0,
      );
    },

    modelCostPct(model) {
      const max = this.maxModelCost || 0;
      if (max <= 0) return 0;
      return Math.max(0, Math.min(100, ((model.costUSD ?? 0) / max) * 100));
    },

    get tokenComposition() {
      const totals = Object.fromEntries(
        TOKEN_BUCKETS.map((bucket) => [bucket.key, 0]),
      );
      for (const model of this.filteredByModel) {
        for (const bucket of TOKEN_BUCKETS) {
          totals[bucket.key] += model[bucket.key] ?? 0;
        }
      }
      const total = Object.values(totals).reduce(
        (sum, value) => sum + value,
        0,
      );
      const rows = TOKEN_BUCKETS.map((bucket) => {
        const value = totals[bucket.key] ?? 0;
        const pct = this.compositionPct(value, total);
        return {
          ...bucket,
          value,
          pct,
          pctLabel: `${pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)}%`,
          valueLabel: fmtTokens(value),
          title: `${bucket.label}: ${fmtNum(value)} tokens (${pct.toFixed(1)}%)`,
        };
      });
      return { total, totalLabel: fmtTokens(total), rows };
    },

    get cacheEfficiency() {
      const buckets = this.tokenComposition;
      const cacheRead =
        buckets.rows.find((row) => row.key === "cacheReadTokens")?.value ?? 0;
      const cacheWrite =
        buckets.rows.find((row) => row.key === "cacheCreationTokens")?.value ??
        0;
      const freshInput =
        buckets.rows.find((row) => row.key === "inputTokens")?.value ?? 0;
      const total = buckets.total;
      return {
        cacheReadShare: this.compositionPct(cacheRead, total),
        cacheReadRatio: freshInput > 0 ? cacheRead / freshInput : null,
        cacheWriteShare: this.compositionPct(cacheWrite, total),
        cacheReadLabel: `${this.compositionPct(cacheRead, total).toFixed(1)}%`,
        cacheReadRatioLabel:
          freshInput > 0 ? `${(cacheRead / freshInput).toFixed(2)}x` : "n/a",
        cacheWriteLabel: `${this.compositionPct(cacheWrite, total).toFixed(
          1,
        )}%`,
      };
    },

    get topProjects() {
      if (!this.stats) return [];
      const isCost = this.topProjectMode === "cost";
      const key = isCost ? "costUSD" : "tokens";
      const fmt = isCost ? fmtUSD : fmtTokens;
      const projects = [...this.stats.projects]
        .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
        .slice(0, 10);
      const total = projects.reduce((s, p) => s + (p[key] ?? 0), 0) || 1;
      return projects
        .filter((p) => (p[key] ?? 0) > 0)
        .map((p) => {
          const value = p[key] ?? 0;
          const claudeValue = isCost
            ? (p.claudeCostUSD ?? 0)
            : (p.claudeTokens ?? 0);
          const codexValue = isCost
            ? (p.codexCostUSD ?? 0)
            : (p.codexTokens ?? 0);
          return enrichProjectRow(
            p,
            value,
            claudeValue,
            codexValue,
            total,
            fmt,
          );
        });
    },

    get topCostProjects() {
      if (!this.stats) return [];
      const projects = [...this.stats.projects]
        .filter((p) => (p.costUSD ?? 0) > 0)
        .sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0))
        .slice(0, 3);
      const total = projects.reduce((s, p) => s + (p.costUSD ?? 0), 0) || 1;
      return projects.map((p) => {
        const enriched = enrichProjectRow(
          p,
          p.costUSD ?? 0,
          p.claudeCostUSD ?? 0,
          p.codexCostUSD ?? 0,
          total,
          fmtUSD,
        );
        return { ...enriched, tokenLabel: fmtTokens(p.tokens ?? 0) };
      });
    },

    get selectedProject() {
      if (!this.stats || !this.selectedProjectPath) return null;
      return (
        this.stats.projects.find((p) => p.path === this.selectedProjectPath) ??
        null
      );
    },

    get selectedProjectModels() {
      const project = this.selectedProject;
      if (!project) return [];
      return [...(project.models ?? [])]
        .filter(
          (model) =>
            this.providerKey === "all" ||
            (model.provider ?? providerForModel(model.model)) ===
              this.providerKey,
        )
        .sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0));
    },

    get selectedProjectProviderSummary() {
      const project = this.selectedProject;
      if (!project) return null;
      if (this.providerKey === "claude") {
        return {
          label: "Claude",
          messages: project.claudeMessages ?? 0,
          tokens: project.claudeTokens ?? 0,
          costUSD: project.claudeCostUSD ?? 0,
        };
      }
      if (this.providerKey === "codex") {
        return {
          label: "Codex",
          messages: project.codexMessages ?? 0,
          tokens: project.codexTokens ?? 0,
          costUSD: project.codexCostUSD ?? 0,
        };
      }
      return {
        label: "All sources",
        messages: project.messageCount ?? 0,
        tokens: project.tokens ?? 0,
        costUSD: project.costUSD ?? 0,
      };
    },

    get activeProjectDetail() {
      const project = this.selectedProject ?? {};
      const summary = this.selectedProjectProviderSummary ?? {
        label: "All sources",
        messages: 0,
        tokens: 0,
        costUSD: 0,
      };
      return {
        project,
        summary,
        models: this.selectedProjectModels,
        modelTotalCost: this.selectedProjectModelTotalCost,
      };
    },

    get selectedProjectModelTotalCost() {
      return this.selectedProjectModels.reduce(
        (sum, model) => sum + (model.costUSD ?? 0),
        0,
      );
    },

    get maxSelectedProjectModelCost() {
      return this.selectedProjectModels.reduce(
        (max, model) => Math.max(max, model.costUSD ?? 0),
        0,
      );
    },

    get activeWindowLabel() {
      if (this.rangeKey === "all") return "all time";
      return `last ${this.rangeKey} days`;
    },

    get activeDateRangeLabel() {
      const daily = this.filteredDaily;
      if (!daily.length) return "";
      const first = this.parseDate(daily[0].date);
      const last = this.parseDate(daily[daily.length - 1].date);
      return this.formatDateRange(first, last);
    },

    get pricingMeta() {
      return this.stats?.pricingMeta ?? null;
    },

    get pricingBasisLabel() {
      const meta = this.pricingMeta;
      if (!meta) return "estimate basis unavailable";
      const basis = meta.openRouter?.used ? "live + defaults" : "defaults only";
      return meta.userOverride?.loaded ? `${basis} + override` : basis;
    },

    get fallbackPricingModels() {
      return (this.pricingMeta?.models?.fallbackModels ?? []).map((model) => ({
        model,
        label: shortModel(model),
      }));
    },

    get budgetConfig() {
      return this.stats?.budget ?? null;
    },

    get budgetView() {
      const config = this.budgetConfig;
      const monthlyBudgetUSD = config?.monthlyBudgetUSD ?? null;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const monthKey = `${today.getFullYear()}-${String(
        today.getMonth() + 1,
      ).padStart(2, "0")}`;
      const monthDays = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        0,
      ).getDate();
      const elapsedDays = Math.max(1, today.getDate());
      const monthDaily = (this.stats?.daily ?? [])
        .map((day) => this.filterDayByProvider(day))
        .filter((day) => {
          if (!day.date?.startsWith(monthKey)) return false;
          return this.parseDate(day.date) <= today;
        });
      const monthToDateCostUSD = monthDaily.reduce(
        (sum, day) => sum + (day.costUSD ?? 0),
        0,
      );
      const projectedMonthEndCostUSD =
        (monthToDateCostUSD / elapsedDays) * monthDays;
      const remainingBudgetUSD =
        typeof monthlyBudgetUSD === "number"
          ? monthlyBudgetUSD - monthToDateCostUSD
          : null;
      const usagePct =
        typeof monthlyBudgetUSD === "number" && monthlyBudgetUSD > 0
          ? (monthToDateCostUSD / monthlyBudgetUSD) * 100
          : 0;
      const projectedPct =
        typeof monthlyBudgetUSD === "number" && monthlyBudgetUSD > 0
          ? (projectedMonthEndCostUSD / monthlyBudgetUSD) * 100
          : 0;
      return {
        configured:
          config?.loaded === true && typeof monthlyBudgetUSD === "number",
        error: config?.error ?? null,
        source: config?.source ?? "~/.config/cc-dashboard/budget.json",
        providerLabel:
          this.providerKey === "all" ? "Claude + Codex" : this.providerKey,
        monthlyBudgetUSD,
        monthToDateCostUSD,
        projectedMonthEndCostUSD,
        remainingBudgetUSD,
        usagePct,
        projectedPct,
        usagePctLabel: `${Math.min(999, usagePct).toFixed(
          usagePct >= 10 ? 0 : 1,
        )}%`,
        projectedPctLabel: `${Math.min(999, projectedPct).toFixed(
          projectedPct >= 10 ? 0 : 1,
        )}%`,
        usageMeterWidth: `${Math.max(0, Math.min(100, usagePct)).toFixed(1)}%`,
        projectedMeterWidth: `${Math.max(
          0,
          Math.min(100, projectedPct),
        ).toFixed(1)}%`,
        state: this.budgetState(usagePct),
        projectedState: this.budgetState(projectedPct),
      };
    },

    get dataHealth() {
      return this.stats?.dataHealth ?? null;
    },

    get dataHealthSources() {
      return this.dataHealth?.sources ?? [];
    },

    get dataHealthCounts() {
      const counts = this.dataHealth?.counts ?? {};
      return [
        {
          label: "Claude transcripts",
          value: counts.claudeTranscriptFiles ?? 0,
        },
        {
          label: "Codex session files",
          value: counts.codexSessionFiles ?? 0,
        },
        {
          label: "Codex thread rows",
          value: counts.codexThreadRows ?? 0,
        },
      ];
    },

    get filteredLedger() {
      if (!this.stats?.ledger) return [];
      const dates = this.filteredDaily;
      const firstDate = this.rangeKey === "all" ? null : dates[0]?.date;
      const lastDate =
        this.rangeKey === "all" ? null : dates[dates.length - 1]?.date;
      return [...this.stats.ledger]
        .filter((row) => {
          if (this.providerKey !== "all" && row.provider !== this.providerKey) {
            return false;
          }
          if (!firstDate || !lastDate) return true;
          return row.date >= firstDate && row.date <= lastDate;
        })
        .sort((a, b) => this.compareLedgerRows(a, b));
    },

    get visibleLedgerRows() {
      return this.filteredLedger.slice(0, this.ledgerVisibleCount);
    },

    get hasMoreLedgerRows() {
      return this.filteredLedger.length > this.visibleLedgerRows.length;
    },

    get ledgerSummaryLabel() {
      const count = this.filteredLedger.length;
      return `${fmtNum(count)} rows · ${this.activeWindowLabel}`;
    },

    get usageAnomalyState() {
      const daily = this.filteredDaily.filter(
        (day) => (day.costUSD ?? 0) > 0 || (day.tokens ?? 0) > 0,
      );
      if (daily.length < 5) {
        return {
          ready: false,
          label: "Need at least 5 active days for a baseline.",
          anomalies: [],
        };
      }

      const costMedian = this.median(daily.map((day) => day.costUSD ?? 0));
      const tokenMedian = this.median(daily.map((day) => day.tokens ?? 0));
      if (costMedian <= 0 && tokenMedian <= 0) {
        return {
          ready: false,
          label: "No usage baseline in this window.",
          anomalies: [],
        };
      }

      const anomalies = daily
        .map((day) => this.anomalyForDay(day, costMedian, tokenMedian))
        .filter(Boolean)
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 3);

      return {
        ready: true,
        label: anomalies.length
          ? `${anomalies.length} elevated day${anomalies.length === 1 ? "" : "s"}`
          : "No elevated days in this window.",
        anomalies,
      };
    },

    get usageAnomalies() {
      return this.usageAnomalyState.anomalies;
    },

    get heatmapCells() {
      if (!this.stats) return [];
      let matrix;
      if (this.rangeKey === "all" || !this.stats.dailyHourCounts) {
        matrix = this.stats.weekHourMatrix;
      } else {
        matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const dailyHourCounts = this.stats.dailyHourCounts;
        for (const day of this.filteredDaily) {
          const counts = dailyHourCounts[day.date];
          if (!counts) continue;
          const dow = this.parseDate(day.date).getDay();
          for (let h = 0; h < 24; h++) {
            matrix[dow][h] += counts[h] ?? 0;
          }
        }
      }
      let max = 0;
      for (const row of matrix) for (const v of row) if (v > max) max = v;
      const cells = [];
      for (let dow = 0; dow < matrix.length; dow++) {
        cells.push({
          k: `d-${dow}`,
          cls: "heatmap-d-label",
          style: {},
          title: "",
          label: DAYS[dow],
        });
        for (let h = 0; h < matrix[dow].length; h++) {
          const v = matrix[dow][h];
          cells.push({
            k: `c-${dow}-${h}`,
            cls: "heatmap-cell",
            style: { background: this.heatColorFromMax(v, max) },
            title: `${DAYS[dow]} ${h}:00 · ${v} messages`,
            label: "",
          });
        }
      }
      return cells;
    },

    get activityWall() {
      const source = this.stats?.daily?.length
        ? this.stats.daily
        : this.stats?.activityDays;
      if (!source || source.length === 0) {
        return { cells: [], monthLabels: [], weekCount: 0 };
      }

      const byDate = new Map(source.map((d) => [d.date, d]));
      const minWeeks = 24;
      const last = this.parseDate(source[source.length - 1].date);
      const end = new Date(last);
      end.setDate(end.getDate() + (6 - end.getDay()));
      const start = new Date(end);
      start.setDate(start.getDate() - minWeeks * 7 + 1);

      let max = 0;
      for (const d of source) {
        if ((d.messages ?? 0) > max) max = d.messages;
      }

      const cells = [];
      const monthLabels = [];
      const seenMonths = new Set();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let week = 1;
      for (
        const cur = new Date(start);
        cur <= end;
        cur.setDate(cur.getDate() + 1)
      ) {
        const date = this.formatDate(cur);
        const day = byDate.get(date);
        const messages = day?.messages ?? 0;
        const dow = cur.getDay();
        const monthKey = `${cur.getFullYear()}-${cur.getMonth()}`;
        const isFuture = cur > today;

        if (!seenMonths.has(monthKey) && cur.getDate() <= 7) {
          seenMonths.add(monthKey);
          monthLabels.push({
            k: `m-${monthKey}`,
            label: MONTHS[cur.getMonth()],
            style: { gridColumn: `${week + 1} / span 4` },
          });
        }

        cells.push({
          k: date,
          style: {
            gridColumn: String(week + 1),
            gridRow: String(dow + 2),
            background: this.activityColorFromMax(messages, max),
            visibility: isFuture ? "hidden" : "visible",
          },
          title: isFuture ? "" : `${date} · ${messages} interactions`,
        });

        if (dow === 6) week += 1;
      }

      return { cells, monthLabels, weekCount: week - 1 };
    },

    // ---------- Methods ----------

    fmtNum,
    fmtTokens,
    fmtUSD,
    shortModel,
    colorFor,
    modelMarkClass,
    providerBadgeClass,
    dayLabel: (i) => DAYS[i],

    loadPrefs() {
      return normalizePrefs(loadStoredPrefs());
    },

    savePrefs() {
      saveStoredPrefs({
        providerKey: this.providerKey,
        rangeKey: this.rangeKey,
        trendMode: this.trendMode,
        trendModelScope: this.trendModelScope,
        topProjectMode: this.topProjectMode,
        selectedModels: this.selectedModels,
      });
    },

    reconcileSelectedModels() {
      const available = this.availableModelKeys();
      const next = {};
      for (const model of available) {
        next[model] = Object.prototype.hasOwnProperty.call(
          this.selectedModels,
          model,
        )
          ? this.selectedModels[model] === true
          : true;
      }
      this.selectedModels = next;
    },

    reconcileSelectedProject() {
      if (!this.selectedProjectPath || !this.stats) return;
      const exists = this.stats.projects?.some(
        (project) => project.path === this.selectedProjectPath,
      );
      if (!exists) this.clearSelectedProject();
    },

    selectProject(path) {
      this.lockPageScroll();
      this.selectedProjectPath = path;
      this.$nextTick(() => {
        this.$refs.projectDetailDialog?.focus();
      });
    },

    clearSelectedProject() {
      this.selectedProjectPath = null;
      this.unlockPageScroll();
    },

    isSelectedProject(path) {
      return this.selectedProjectPath === path;
    },

    lockPageScroll() {
      this.modalScrollY = window.scrollY || 0;
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      document.body.style.paddingRight = `${window.innerWidth - document.documentElement.clientWidth}px`;
    },

    unlockPageScroll() {
      const scrollY = this.modalScrollY || 0;
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
      window.scrollTo(0, scrollY);
    },

    showMoreLedgerRows() {
      this.ledgerVisibleCount += LEDGER_PAGE_SIZE;
    },

    availableModelKeys() {
      if (!this.stats) return [];
      const set = new Set();
      for (const d of this.stats.daily ?? []) {
        for (const m of Object.keys(d.tokensByModel ?? {})) set.add(m);
        for (const m of Object.keys(d.usageByModel ?? {})) set.add(m);
      }
      for (const m of this.stats.byModel ?? []) {
        if (m.model) set.add(m.model);
      }
      return [...set].sort();
    },

    modelTokenTotal(model) {
      return (
        (model.inputTokens ?? 0) +
        (model.outputTokens ?? 0) +
        (model.cacheReadTokens ?? 0) +
        (model.cacheCreationTokens ?? 0) +
        (model.reasoningTokens ?? 0)
      );
    },

    projectModelCostPct(model) {
      const max = this.maxSelectedProjectModelCost || 0;
      if (max <= 0) return 0;
      return Math.max(0, Math.min(100, ((model.costUSD ?? 0) / max) * 100));
    },

    compareLedgerRows(a, b) {
      if (this.ledgerSortKey === "tokens") {
        return (
          (b.tokens ?? 0) - (a.tokens ?? 0) ||
          (b.timestampMs ?? 0) - (a.timestampMs ?? 0)
        );
      }
      if (this.ledgerSortKey === "cost") {
        return (
          (b.costUSD ?? -1) - (a.costUSD ?? -1) ||
          (b.timestampMs ?? 0) - (a.timestampMs ?? 0)
        );
      }
      return (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
    },

    ledgerSortLabel(sortKey) {
      return (
        {
          date: "Latest",
          tokens: "Tokens",
          cost: "Cost",
        }[sortKey] ?? sortKey
      );
    },

    ledgerModelLabel(model) {
      if (!model || model === "n/a") return "n/a";
      if (model === "mixed") return "mixed";
      return shortModel(model);
    },

    ledgerCostLabel(row) {
      if (row.costUSD == null) return "n/a";
      const prefix = row.costBasis === "thread_tokens" ? "~" : "";
      return `${prefix}${fmtUSD(row.costUSD)}`;
    },

    ledgerCostNote(row) {
      if (row.costUSD == null) return "unavailable";
      if (row.costBasis === "thread_tokens") return "approx";
      return "usage";
    },

    exportPayload() {
      return {
        exportedAt: new Date().toISOString(),
        filters: {
          provider: this.providerKey,
          range: this.rangeKey,
          dateRange: this.activeDateRangeLabel,
        },
        summary: this.filtered.summary,
        daily: this.filteredDaily,
        models: this.filteredByModel,
        projects: this.exportProjectRows(),
      };
    },

    exportProjectRows() {
      if (!this.stats) return [];
      return [...(this.stats.projects ?? [])]
        .map((project) => this.projectExportRow(project))
        .filter((project) => project.tokens > 0 || project.costUSD > 0)
        .sort((a, b) => {
          const key = this.topProjectMode === "cost" ? "costUSD" : "tokens";
          return (b[key] ?? 0) - (a[key] ?? 0);
        });
    },

    projectExportRow(project) {
      const provider = this.providerKey;
      const messages =
        provider === "claude"
          ? (project.claudeMessages ?? 0)
          : provider === "codex"
            ? (project.codexMessages ?? 0)
            : (project.messageCount ?? 0);
      const tokens =
        provider === "claude"
          ? (project.claudeTokens ?? 0)
          : provider === "codex"
            ? (project.codexTokens ?? 0)
            : (project.tokens ?? 0);
      const costUSD =
        provider === "claude"
          ? (project.claudeCostUSD ?? 0)
          : provider === "codex"
            ? (project.codexCostUSD ?? 0)
            : (project.costUSD ?? 0);
      return {
        name: project.name ?? "",
        path: project.path ?? "",
        provider,
        range: "all-time-project-totals",
        messages,
        tokens,
        costUSD: this.formatCSVNumber(costUSD),
        claudeMessages: project.claudeMessages ?? 0,
        codexMessages: project.codexMessages ?? 0,
        codexThreads: project.codexThreads ?? 0,
        codexToolCalls: project.codexToolCalls ?? 0,
        claudeTokens: project.claudeTokens ?? 0,
        codexTokens: project.codexTokens ?? 0,
        claudeCostUSD: this.formatCSVNumber(project.claudeCostUSD ?? 0),
        codexCostUSD: this.formatCSVNumber(project.codexCostUSD ?? 0),
        firstSeen: project.firstSeen ?? "",
        lastSeen: project.lastSeen ?? "",
      };
    },

    exportFilename(kind, extension) {
      const date = this.formatDate(new Date());
      return `token-atlas-${this.providerKey}-${this.rangeKey}-${kind}-${date}.${extension}`;
    },

    downloadBlob(filename, content, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },

    toCSV(rows, headers = null) {
      const activeHeaders = headers ?? Object.keys(rows[0] ?? {});
      if (!activeHeaders.length) return "";
      return [
        activeHeaders.map((header) => this.escapeCSVField(header)).join(","),
        ...rows.map((row) =>
          activeHeaders
            .map((header) => this.escapeCSVField(row[header]))
            .join(","),
        ),
      ].join("\n");
    },

    escapeCSVField(value) {
      if (value == null) return "";
      const text = String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    },

    formatCSVNumber(value) {
      return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
    },

    compositionPct(value, total) {
      if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
        return 0;
      }
      return Math.max(0, Math.min(100, (value / total) * 100));
    },

    median(values) {
      const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
      if (!sorted.length) return 0;
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2) return sorted[mid];
      return (sorted[mid - 1] + sorted[mid]) / 2;
    },

    anomalyForDay(day, costMedian, tokenMedian) {
      const cost = day.costUSD ?? 0;
      const tokens = day.tokens ?? 0;
      const costRatio = costMedian > 0 ? cost / costMedian : 0;
      const tokenRatio = tokenMedian > 0 ? tokens / tokenMedian : 0;
      const costElevated =
        costMedian > 0 &&
        cost >= ANOMALY_MIN_COST &&
        costRatio >= ANOMALY_MULTIPLIER;
      const tokenElevated =
        tokenMedian > 0 &&
        tokens >= ANOMALY_MIN_TOKENS &&
        tokenRatio >= ANOMALY_MULTIPLIER;
      if (!costElevated && !tokenElevated) return null;

      const metric =
        costElevated && costRatio >= tokenRatio ? "cost" : "tokens";
      const ratio = metric === "cost" ? costRatio : tokenRatio;
      const topModel = this.topModelForDay(day, metric);
      return {
        date: day.date,
        metric,
        ratio,
        value: metric === "cost" ? fmtUSD(cost) : fmtTokens(tokens),
        ratioLabel: `${ratio.toFixed(ratio >= 10 ? 0 : 1)}x`,
        baselineLabel: `${this.activeWindowLabel} median`,
        driverLabel: topModel
          ? `${shortModel(topModel.model)} · ${
              metric === "cost"
                ? fmtUSD(topModel.value)
                : fmtTokens(topModel.value)
            }`
          : "No model breakdown",
      };
    },

    topModelForDay(day, metric) {
      const rows = Object.entries(day.usageByModel ?? {}).map(
        ([model, usage]) => {
          const value =
            metric === "cost"
              ? (usage.costUSD ?? 0)
              : (usage.inputTokens ?? 0) +
                (usage.outputTokens ?? 0) +
                (usage.cacheReadTokens ?? 0) +
                (usage.cacheCreationTokens ?? 0) +
                (usage.reasoningTokens ?? 0);
          return { model, value };
        },
      );
      return rows.sort((a, b) => b.value - a.value)[0] ?? null;
    },

    buildSummaryDelta(metric, current, previous) {
      if (this.rangeKey === "all") {
        return {
          available: false,
          state: "unavailable",
          label: "No comparison for all time",
          valueLabel: "n/a",
          pctLabel: "all time",
          contextLabel: "No comparison",
        };
      }
      if (!this.comparisonDaily.length) {
        return {
          available: false,
          state: "unavailable",
          label: "No previous window",
          valueLabel: "n/a",
          pctLabel: "no baseline",
          contextLabel: "Previous window",
        };
      }

      const delta = current - previous;
      const windowLabel = `previous ${this.rangeKey}d`;
      if (previous === 0) {
        return {
          available: true,
          state: current === 0 ? "neutral" : "increase",
          label:
            current === 0
              ? `no change vs ${windowLabel}`
              : `new activity vs ${windowLabel}`,
          valueLabel:
            current === 0
              ? "no change"
              : `${this.formatDeltaSign(current)}${this.formatDeltaValue(
                  metric,
                  Math.abs(current),
                )}`,
          pctLabel: current === 0 ? "0%" : "new",
          contextLabel: `vs ${windowLabel}`,
        };
      }

      const pct = (delta / previous) * 100;
      const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
      const formattedDelta = this.formatDeltaValue(metric, Math.abs(delta));
      const formattedPct = `${sign}${pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
      return {
        available: true,
        state: delta > 0 ? "increase" : delta < 0 ? "decrease" : "neutral",
        label:
          delta === 0
            ? `no change vs ${windowLabel}`
            : `${sign}${formattedDelta} (${formattedPct}) vs ${windowLabel}`,
        valueLabel: delta === 0 ? "no change" : `${sign}${formattedDelta}`,
        pctLabel: delta === 0 ? "0%" : formattedPct,
        contextLabel: `vs ${windowLabel}`,
      };
    },

    formatDeltaSign(value) {
      return value > 0 ? "+" : value < 0 ? "-" : "";
    },

    formatDeltaValue(metric, value) {
      if (metric === "cost" || metric === "dailyBurn") return fmtUSD(value);
      if (metric === "tokens") return fmtTokens(value);
      return fmtNum(Math.round(value));
    },

    deltaClass(metric) {
      return {
        "compare-block": true,
        "compare-block--increase":
          this.summaryDeltas[metric]?.state === "increase",
        "compare-block--decrease":
          this.summaryDeltas[metric]?.state === "decrease",
        "compare-block--neutral":
          this.summaryDeltas[metric]?.state === "neutral",
        "compare-block--unavailable":
          this.summaryDeltas[metric]?.state === "unavailable",
      };
    },

    filterDayByProvider(day) {
      if (this.providerKey === "all") return day;
      const keep = (model) => providerForModel(model) === this.providerKey;
      const tokensByModel = {};
      for (const [model, tokens] of Object.entries(day.tokensByModel ?? {})) {
        if (keep(model)) tokensByModel[model] = tokens;
      }
      const usageByModel = {};
      for (const [model, usage] of Object.entries(day.usageByModel ?? {})) {
        if (keep(model)) usageByModel[model] = usage;
      }
      let tokens = 0;
      let costUSD = 0;
      for (const usage of Object.values(usageByModel)) {
        tokens +=
          (usage.inputTokens ?? 0) +
          (usage.outputTokens ?? 0) +
          (usage.cacheReadTokens ?? 0) +
          (usage.cacheCreationTokens ?? 0) +
          (usage.reasoningTokens ?? 0);
        costUSD += usage.costUSD ?? 0;
      }
      if (tokens === 0) {
        tokens = Object.values(tokensByModel).reduce(
          (sum, value) => sum + value,
          0,
        );
      }
      const provider = day.providers?.[this.providerKey] ?? {};
      return {
        ...day,
        messages: provider.messages ?? 0,
        sessions: provider.sessions ?? 0,
        toolCalls: provider.toolCalls ?? 0,
        tokens,
        tokensByModel,
        usageByModel,
        costUSD,
      };
    },

    parseDate(date) {
      const [year, month, day] = date.split("-").map(Number);
      return new Date(year, month - 1, day);
    },

    formatDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    },

    formatDateRange(first, last) {
      const fmt = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      if (first.getTime() === last.getTime()) return fmt.format(first);
      return `${fmt.format(first)} - ${fmt.format(last)}`;
    },

    formatDateTime(value) {
      if (!value) return "n/a";
      return new Date(value).toLocaleString();
    },

    dataHealthStatusClass(status) {
      return {
        "data-health-status": true,
        "data-health-status--ok": status === "ok",
        "data-health-status--missing": status === "missing",
        "data-health-status--empty": status === "empty",
        "data-health-status--unreadable": status === "unreadable",
      };
    },

    budgetState(pct) {
      if (!Number.isFinite(pct)) return "low";
      if (pct >= 100) return "over";
      if (pct >= 80) return "high";
      if (pct >= 50) return "medium";
      return "low";
    },

    budgetStateLabel(state) {
      return (
        {
          low: "under 50%",
          medium: "50-80%",
          high: "80-100%",
          over: "over budget",
        }[state] ?? "under 50%"
      );
    },

    budgetMeterClass(state) {
      return {
        "budget-meter-fill": true,
        "budget-meter-fill--medium": state === "medium",
        "budget-meter-fill--high": state === "high",
        "budget-meter-fill--over": state === "over",
      };
    },

    heatColorFromMax(v, max) {
      if (!max) return "var(--bg-rail)";
      if (v === 0) return "var(--bg-rail)";
      const ratio = Math.pow(v / max, 0.5);
      const alpha = 0.15 + ratio * 0.85;
      // Violet-magenta — pulls from sunrise's cool end, contrasts the calendar's coral
      return `oklch(60% 0.20 318 / ${alpha.toFixed(3)})`;
    },

    activityColorFromMax(v, max) {
      if (!max) return "var(--bg-rail)";
      if (v === 0) return "var(--bg-rail)";
      const ratio = Math.pow(v / max, 0.5);
      const alpha = 0.14 + ratio * 0.82;
      // Coral-orange — distinct from heatmap's amber, same sunrise lineage
      return `oklch(68% 0.18 32 / ${alpha.toFixed(3)})`;
    },

    trendDayValue(day, models, isCost) {
      return models.reduce(
        (sum, model) =>
          sum +
          (isCost
            ? (day.usageByModel?.[model]?.costUSD ?? 0)
            : (day.tokensByModel?.[model] ?? 0)),
        0,
      );
    },

    renderTrend() {
      if (!window.Chart || !this.stats) return;
      const ctx = this.$refs.trendCanvas?.getContext("2d");
      if (!ctx) return;
      const daily = this.filteredDaily;
      const labels = daily.map((d) => d.date);
      const isCost = this.trendMode === "cost";
      const activeModels = this.activeTrendModels;
      const previousDaily = this.previousTrendAvailable
        ? this.comparisonDaily
        : [];

      if (charts.trend) {
        charts.trend.destroy();
        charts.trend = null;
      }
      if (activeModels.length === 0) return;

      const tooltipBg = cssVar("--chart-tooltip-bg");
      const tooltipText = cssVar("--chart-tooltip-text");
      const tooltipBorder = cssVar("--chart-tooltip-border");
      const chartGrid = cssVar("--chart-grid");
      const chartAxis = cssVar("--chart-axis");

      const datasets = activeModels.map((m) => ({
        label: shortModel(m),
        provider: providerForModel(m),
        data: daily.map((d) =>
          isCost
            ? (d.usageByModel?.[m]?.costUSD ?? 0)
            : (d.tokensByModel?.[m] ?? 0),
        ),
        borderColor: colorFor(m),
        backgroundColor: colorFor(m),
        borderWidth: 0,
        borderRadius: 3,
        borderSkipped: false,
        categoryPercentage: 0.72,
        barPercentage: 0.82,
      }));

      if (previousDaily.length) {
        datasets.push({
          type: "line",
          label: this.previousTrendLabel,
          data: previousDaily.map((d) =>
            this.trendDayValue(d, activeModels, isCost),
          ),
          borderColor: cssVar("--accent"),
          backgroundColor: cssVar("--accent"),
          borderDash: [7, 5],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
          order: 0,
          yAxisID: "yPrevious",
        });
      }

      const maxTrendValue = Math.max(
        0,
        ...daily.map((d) => this.trendDayValue(d, activeModels, isCost)),
        ...previousDaily.map((d) =>
          this.trendDayValue(d, activeModels, isCost),
        ),
      );
      const trendAxisMax = maxTrendValue > 0 ? maxTrendValue * 1.08 : undefined;

      charts.trend = new window.Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: tooltipBg,
              titleColor: tooltipText,
              bodyColor: tooltipText,
              borderColor: tooltipBorder,
              borderWidth: 1.5,
              padding: 10,
              cornerRadius: 6,
              callbacks: {
                label: (ctx) =>
                  ctx.parsed.y === 0
                    ? null
                    : `${ctx.dataset.label}: ${
                        isCost ? fmtUSD(ctx.parsed.y) : fmtTokens(ctx.parsed.y)
                      }`,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: chartAxis, maxTicksLimit: 10 },
              grid: { color: chartGrid },
              stacked: true,
            },
            y: {
              ticks: {
                color: chartAxis,
                callback: (v) => (isCost ? fmtUSD(v) : fmtTokens(v)),
              },
              grid: { color: chartGrid },
              stacked: true,
              beginAtZero: true,
              max: trendAxisMax,
            },
            yPrevious: {
              display: false,
              beginAtZero: true,
              max: trendAxisMax,
            },
          },
        },
      });
    },

    renderDonut() {
      if (!window.Chart || !this.stats) return;
      const ctx = this.$refs.donutCanvas?.getContext("2d");
      if (!ctx) return;

      const data = this.filteredByModel.map((m) => ({
        label: shortModel(m.model),
        full: m.model,
        value: this.modelTokenTotal(m),
      }));
      data.sort((a, b) => b.value - a.value);
      const donutData =
        data.length > 6
          ? [
              ...data.slice(0, 6),
              {
                label: "Other",
                full: "__other__",
                value: data.slice(6).reduce((sum, d) => sum + d.value, 0),
              },
            ].filter((d) => d.value > 0)
          : data;

      if (charts.donut) {
        charts.donut.destroy();
        charts.donut = null;
      }
      if (donutData.length === 0) return;

      const tooltipBg = cssVar("--chart-tooltip-bg");
      const tooltipText = cssVar("--chart-tooltip-text");
      const tooltipBorder = cssVar("--chart-tooltip-border");
      const surfaceText = cssVar("--text");

      charts.donut = new window.Chart(ctx, {
        type: "doughnut",
        data: {
          labels: donutData.map((d) => d.label),
          datasets: [
            {
              data: donutData.map((d) => d.value),
              backgroundColor: donutData.map((d) => colorFor(d.full)),
              borderColor: cssVar("--surface-2"),
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "60%",
          plugins: {
            legend: {
              position: "bottom",
              labels: {
                color: surfaceText,
                font: { size: 11 },
                boxWidth: 10,
              },
            },
            tooltip: {
              backgroundColor: tooltipBg,
              titleColor: tooltipText,
              bodyColor: tooltipText,
              borderColor: tooltipBorder,
              borderWidth: 1.5,
              padding: 10,
              cornerRadius: 6,
              callbacks: {
                label: (ctx) => `${ctx.label}: ${fmtTokens(ctx.parsed)}`,
              },
            },
          },
        },
      });
    },
  };
}

window.App = App;
createApp({ App }).mount("#app");

// Sunrise Bloom — pointer position is lerped toward target each frame so the
// light glides behind the cursor with natural exponential ease-out (closer to
// target = smaller step). Smoothing happens in JS because CSS transitions on
// custom properties get re-armed every pointermove and never visibly trail.
(function installBloomTracker() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SELECTOR = ".panel, .card, .budget-panel, .data-health-panel";
  // Per-frame lerp factor. Lower = laggier trail. 0.14 ≈ ~300ms to settle.
  const SMOOTH = 0.14;
  const SNAP_EPSILON = 0.15;

  let activeEl = null;
  let targetX = 50;
  let targetY = 50;
  let currentX = 50;
  let currentY = 50;
  let rafId = 0;

  function tick() {
    rafId = 0;
    if (!activeEl) return;
    currentX += (targetX - currentX) * SMOOTH;
    currentY += (targetY - currentY) * SMOOTH;
    activeEl.style.setProperty("--bloom-x", currentX.toFixed(2) + "%");
    activeEl.style.setProperty("--bloom-y", currentY.toFixed(2) + "%");
    if (
      Math.abs(targetX - currentX) > SNAP_EPSILON ||
      Math.abs(targetY - currentY) > SNAP_EPSILON
    ) {
      rafId = requestAnimationFrame(tick);
    }
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest(SELECTOR);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nextX = ((event.clientX - rect.left) / rect.width) * 100;
      const nextY = ((event.clientY - rect.top) / rect.height) * 100;
      if (el !== activeEl) {
        // Panel switch: jump to cursor so the trail starts from where the
        // user actually entered, not from the previous panel's last point.
        activeEl = el;
        currentX = targetX = nextX;
        currentY = targetY = nextY;
        el.style.setProperty("--bloom-x", currentX.toFixed(2) + "%");
        el.style.setProperty("--bloom-y", currentY.toFixed(2) + "%");
        return;
      }
      targetX = nextX;
      targetY = nextY;
      if (!rafId) rafId = requestAnimationFrame(tick);
    },
    { passive: true },
  );
})();
