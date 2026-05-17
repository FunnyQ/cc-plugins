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

const CLAUDE_PALETTE = [
  "oklch(76% 0.112 70)",
  "oklch(72% 0.096 52)",
  "oklch(79% 0.086 86)",
  "oklch(69% 0.076 38)",
  "oklch(74% 0.082 104)",
  "oklch(66% 0.07 62)",
  "oklch(82% 0.072 76)",
  "oklch(70% 0.064 92)",
];

const CODEX_PALETTE = [
  "oklch(75% 0.09 205)",
  "oklch(72% 0.112 157)",
  "oklch(70% 0.088 245)",
  "oklch(71% 0.09 286)",
  "oklch(69% 0.074 194)",
  "oklch(74% 0.07 175)",
  "oklch(66% 0.078 232)",
  "oklch(73% 0.072 268)",
];

const OTHER_COLOR = "oklch(58% 0.018 224)";

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
const PREFS_STORAGE_KEY = "token-atlas:prefs:v1";
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

    async mounted() {
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
        this.savePrefs();
        await this.$nextTick();
        this.renderTrend();
        this.renderDonut();
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
      this.savePrefs();
      this.$nextTick(() => {
        this.renderTrend();
        this.renderDonut();
      });
    },

    onProviderChange(provider) {
      this.providerKey = provider;
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

    onSelectedModelsChange() {
      this.savePrefs();
      this.renderTrend();
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

    get comparisonSummary() {
      return this.summarizeDaily(this.comparisonDaily);
    },

    get summaryDeltas() {
      const current = this.filtered.summary;
      const previous = this.comparisonSummary;
      return {
        cost: this.buildSummaryDelta("cost", current.cost, previous.cost),
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
        const value = p.costUSD ?? 0;
        const claudeValue = p.claudeCostUSD ?? 0;
        const codexValue = p.codexCostUSD ?? 0;
        const providerTotal = claudeValue + codexValue || value || 1;
        return {
          ...p,
          displayLabel: fmtUSD(value),
          tokenLabel: fmtTokens(p.tokens ?? 0),
          pct: ((value / total) * 100).toFixed(1),
          claudePct: ((claudeValue / providerTotal) * 100).toFixed(1),
          codexPct: ((codexValue / providerTotal) * 100).toFixed(1),
          hasClaude: claudeValue > 0,
          hasCodex: codexValue > 0,
          claudeDisplay: fmtUSD(claudeValue),
          codexDisplay: fmtUSD(codexValue),
        };
      });
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

    normalizePrefs(raw) {
      return normalizePrefs(raw);
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
        };
      }
      if (!this.comparisonDaily.length) {
        return {
          available: false,
          state: "unavailable",
          label: "No previous window",
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
      };
    },

    formatDeltaValue(metric, value) {
      if (metric === "cost") return fmtUSD(value);
      if (metric === "tokens") return fmtTokens(value);
      return fmtNum(Math.round(value));
    },

    deltaClass(metric) {
      return {
        "card-delta": true,
        "card-delta--increase":
          this.summaryDeltas[metric]?.state === "increase",
        "card-delta--decrease":
          this.summaryDeltas[metric]?.state === "decrease",
        "card-delta--neutral": this.summaryDeltas[metric]?.state === "neutral",
        "card-delta--unavailable":
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

    heatColorFromMax(v, max) {
      if (!max) return "var(--bg-rail)";
      if (v === 0) return "var(--bg-rail)";
      const ratio = Math.pow(v / max, 0.5);
      const alpha = 0.15 + ratio * 0.85;
      return `rgba(220, 162, 79, ${alpha.toFixed(3)})`;
    },

    activityColorFromMax(v, max) {
      if (!max) return "var(--bg-rail)";
      if (v === 0) return "var(--bg-rail)";
      const ratio = Math.pow(v / max, 0.5);
      const alpha = 0.14 + ratio * 0.82;
      return `oklch(73% 0.13 151 / ${alpha.toFixed(3)})`;
    },

    renderTrend() {
      if (!window.Chart || !this.stats) return;
      const ctx = this.$refs.trendCanvas?.getContext("2d");
      if (!ctx) return;
      const daily = this.filteredDaily;
      const labels = daily.map((d) => d.date);
      const isCost = this.trendMode === "cost";
      const activeModels = this.activeTrendModels;

      if (charts.trend) {
        charts.trend.destroy();
        charts.trend = null;
      }
      if (activeModels.length === 0) return;

      const tooltipBg = cssVar("--chart-tooltip-bg");
      const tooltipText = cssVar("--chart-tooltip-text");
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
              borderColor: chartGrid,
              borderWidth: 1,
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
      const chartGrid = cssVar("--chart-grid");

      charts.donut = new window.Chart(ctx, {
        type: "doughnut",
        data: {
          labels: donutData.map((d) => d.label),
          datasets: [
            {
              data: donutData.map((d) => d.value),
              backgroundColor: donutData.map((d) => colorFor(d.full)),
              borderColor: cssVar("--bg"),
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
                color: tooltipText,
                font: { size: 11 },
                boxWidth: 10,
              },
            },
            tooltip: {
              backgroundColor: tooltipBg,
              titleColor: tooltipText,
              bodyColor: tooltipText,
              borderColor: chartGrid,
              borderWidth: 1,
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
