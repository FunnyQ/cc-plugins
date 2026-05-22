import {
  ANOMALY_MIN_COST,
  ANOMALY_MIN_TOKENS,
  ANOMALY_MULTIPLIER,
  AUTO_REFRESH_MS,
  DAYS,
  LEDGER_INITIAL_VISIBLE,
  LEDGER_PAGE_SIZE,
  LIVE_POLL_MS,
  MODEL_EXPORT_HEADERS,
  MONTHS,
  PROJECT_EXPORT_HEADERS,
  TOKEN_BUCKETS,
  colorFor,
  cssVar,
  detectInitialTheme,
  enrichProjectRow,
  fmtNum,
  fmtTokens,
  fmtUSD,
  loadChartJs,
  loadStoredPrefs,
  modelMarkClass,
  normalizePrefs,
  providerBadgeClass,
  providerForModel,
  saveStoredPrefs,
  saveStoredTheme,
  shortModel,
} from "./dashboard-utils.js";

// Chart instances stay outside reactive scope because petite-vue 0.4 deep-reactivates
// any object property, but Chart.js stores Maps internally which crashes its
// reactive Proxy creation (`new Proxy(map, null)`).
const charts = { trend: null, donut: null };
const STREAM_ERROR_NOTICE_DELAY_MS = 15_000;
// Code/tool-result blocks taller than this collapse into a <details> by default.
const STREAM_COLLAPSE_LINES = 10;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readXmlTag(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlText(match[1].trim()) : "";
}

function parseTaskNotification(text) {
  const raw = String(text).trim();
  if (!raw.startsWith("<task-notification>")) return null;
  const usage = readXmlTag(raw, "usage");
  return {
    status: readXmlTag(raw, "status") || "completed",
    summary: readXmlTag(raw, "summary") || "Task completed",
    result: readXmlTag(raw, "result"),
    totalTokens: readXmlTag(usage, "total_tokens"),
    toolUses: readXmlTag(usage, "tool_uses"),
    durationMs: readXmlTag(usage, "duration_ms"),
  };
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label, href) =>
        `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${label}</a>`,
    );
}

const MAX_QUOTE_DEPTH = 8;

function renderMarkdown(text, depth = 0) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
    list = null;
  }

  function flushQuote() {
    if (!quote.length) return;
    // Cap nesting so a line of thousands of `>` can't blow the stack; past the
    // limit the remaining quote markers render as inline text.
    const inner =
      depth >= MAX_QUOTE_DEPTH
        ? `<p>${renderInlineMarkdown(quote.join(" "))}</p>`
        : renderMarkdown(quote.join("\n"), depth + 1);
    html.push(`<blockquote>${inner}</blockquote>`);
    quote = [];
  }

  function flushOpenBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
  }

  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      if (code) {
        html.push(
          `<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`,
        );
        code = null;
      } else {
        flushOpenBlocks();
        code = { lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushOpenBlocks();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushOpenBlocks();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const tag = listMatch[1].endsWith(".") ? "ol" : "ul";
      if (!list || list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(`<li>${renderInlineMarkdown(listMatch[2])}</li>`);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  if (code)
    html.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  flushOpenBlocks();
  return html.join("");
}

export function App() {
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
    liveSessions: [],
    liveError: null,
    livePollTimer: null,
    liveTickTimer: null,
    liveVisibilityHandler: null,
    nowTick: Date.now(),
    streamSessionId: null,
    streamProvider: "claude",
    streamProjectName: "",
    streamEntries: [],
    streamSource: null,
    streamError: null,
    streamErrorTimer: null,
    streamPinnedToBottom: true,
    streamScrollFrame: null,
    streamHistoryStart: 0,
    streamHasMore: false,
    streamLoadingOlder: false,
    streamKeySeq: 0,
    streamSeenEntries: {},
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
      this.startLivePolling();
      this.startLiveClock();
      this.liveVisibilityHandler = () => {
        if (!document.hidden) this.fetchLive();
      };
      document.addEventListener("visibilitychange", this.liveVisibilityHandler);
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

    async fetchLive() {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/live");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        this.liveSessions = data.sessions ?? [];
        this.liveError = null;
      } catch (err) {
        this.liveError = err.message ?? String(err);
      }
    },

    startLivePolling() {
      this.fetchLive();
      if (this.livePollTimer) window.clearInterval(this.livePollTimer);
      this.livePollTimer = window.setInterval(
        () => this.fetchLive(),
        LIVE_POLL_MS,
      );
    },

    startLiveClock() {
      if (this.liveTickTimer) window.clearInterval(this.liveTickTimer);
      this.liveTickTimer = window.setInterval(() => {
        // Only churn the relative-time bindings when the panel is actually
        // visible with rows — otherwise this is a 1Hz no-op re-render forever.
        if (document.hidden || !this.liveSessions.length) return;
        this.nowTick = Date.now();
      }, 1_000);
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

    get usageLimitsConfig() {
      return this.stats?.usageLimits ?? null;
    },

    get codexUsageLimitsConfig() {
      return this.stats?.codexUsageLimits ?? null;
    },

    get usageLimitsView() {
      const providers = [
        this.usageLimitProviderView(
          "claude",
          "Claude",
          this.usageLimitsConfig,
          "waiting for Claude Code",
          "~/.cache/token-atlas/rate-limits.json",
        ),
        this.usageLimitProviderView(
          "codex",
          "Codex",
          this.codexUsageLimitsConfig,
          "waiting for Codex login",
          "~/.cache/token-atlas/codex-usage-limits.json",
        ),
      ].filter(Boolean);
      return {
        available: providers.length > 0,
        providers,
        emptyLabel: "Usage window data is unavailable.",
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

    liveAgo(updatedAt) {
      const ms = this.nowTick - new Date(updatedAt).getTime();
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m}m ago`;
      return `${Math.round(m / 60)}h ago`;
    },

    liveStatusClass(status) {
      const known = {
        busy: "is-busy",
        idle: "is-idle",
        waiting: "is-waiting",
        "active-inferred": "is-busy",
        recent: "is-recent",
      };
      return "live-dot " + (known[status] ?? "is-unknown");
    },

    openStream(session) {
      this.closeStream();
      this.streamSessionId = session.id;
      this.streamProvider = session.provider || "claude";
      this.streamProjectName = session.projectName;
      this.streamEntries = [];
      this.streamError = null;
      this.streamPinnedToBottom = true;
      this.streamHistoryStart = 0;
      this.streamHasMore = false;
      this.streamLoadingOlder = false;
      this.streamKeySeq = 0;
      this.streamSeenEntries = {};
      this.lockPageScroll();

      const source = new EventSource(
        `/api/stream?provider=${encodeURIComponent(this.streamProvider)}` +
          `&id=${encodeURIComponent(session.id)}`,
      );
      source.onopen = () => {
        this.clearDelayedStreamError();
        this.streamError = null;
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.clearDelayedStreamError();
          this.streamError = null;
          // The backlog-done frame carries the reverse-scroll cursor.
          if (payload.kind === "backlog-done") {
            this.streamHistoryStart = payload.historyStart ?? 0;
            this.streamHasMore = !!payload.hasMore;
            return;
          }
          if (payload.kind && !payload.entry) return;
          const shouldScroll = this.streamPinnedToBottom;
          const entry = this.tagStreamEntry(payload.entry ?? payload);
          if (!entry) return;
          this.streamEntries.push(entry);
          this.reconcileToolResults();
          this.$nextTick(() => this.scheduleStreamScroll(shouldScroll));
        } catch {
          // Ignore unparseable stream frames.
        }
      };
      source.onerror = () => {
        this.scheduleDelayedStreamError(source);
      };
      this.streamSource = source;
      this.$nextTick(() => {
        this.$refs.liveStreamDialog?.focus();
      });
    },

    closeStream() {
      if (this.streamSource) {
        this.streamSource.close();
        this.streamSource = null;
      }
      if (this.streamSessionId) this.unlockPageScroll();
      this.streamSessionId = null;
      this.streamProvider = "claude";
      this.streamProjectName = "";
      this.streamEntries = [];
      this.streamError = null;
      this.clearDelayedStreamError();
      this.streamPinnedToBottom = true;
      this.streamHistoryStart = 0;
      this.streamHasMore = false;
      this.streamLoadingOlder = false;
      this.streamSeenEntries = {};
      if (this.streamScrollFrame) {
        window.cancelAnimationFrame(this.streamScrollFrame);
        this.streamScrollFrame = null;
      }
    },

    scheduleDelayedStreamError(source) {
      this.clearDelayedStreamError();
      this.streamErrorTimer = window.setTimeout(() => {
        this.streamErrorTimer = null;
        if (source !== this.streamSource) return;
        this.streamError = "Live connection paused. Reconnecting...";
      }, STREAM_ERROR_NOTICE_DELAY_MS);
    },

    clearDelayedStreamError() {
      if (!this.streamErrorTimer) return;
      window.clearTimeout(this.streamErrorTimer);
      this.streamErrorTimer = null;
    },

    // Stamp a stable v-for key (so prepending older entries doesn't shift keys
    // and force a full re-render), and drop reconnect duplicates. Dedup on the
    // same identity the snapshot pipeline uses (api.ts: requestId:messageId,
    // then uuid) — a content fingerprint would wrongly drop genuinely-distinct
    // entries with identical content (e.g. a repeated tool call). The positional
    // fallback keeps id-less entries always unique.
    tagStreamEntry(entry) {
      if (!entry || typeof entry !== "object") return entry;
      // Dedup on uuid only: each transcript line has a unique one, and a
      // reconnect resends the same uuids. Do NOT key on requestId:messageId —
      // Claude persists the thinking / text / tool_use of one response as
      // separate lines that SHARE requestId:messageId, so that key would drop
      // the text (the actual reply) and tool_use, leaving only the thinking.
      // Positional fallback keeps id-less lines unique.
      const key = entry.uuid ?? `pos:${this.streamKeySeq + 1}`;
      if (this.streamSeenEntries[key]) return null;
      this.streamSeenEntries[key] = true;
      entry.__key = ++this.streamKeySeq;
      entry.__html = this.buildEntryHtml(entry);
      return entry;
    },

    isStreamNearBottom() {
      const el = this.$refs.liveStreamBody;
      if (!el) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    },

    handleStreamScroll() {
      this.streamPinnedToBottom = this.isStreamNearBottom();
      const el = this.$refs.liveStreamBody;
      // Page older history on a scroll toward the top, from any input (wheel,
      // touch, keyboard, scrollbar drag). The guards keep our own programmatic
      // scrolls from triggering it: streamLoadingOlder covers the anchor-restore
      // scroll, !streamPinnedToBottom + the scrollable-height check exclude the
      // auto-scroll-to-bottom and short (non-scrollable) content.
      if (
        el &&
        this.streamHasMore &&
        !this.streamLoadingOlder &&
        !this.streamPinnedToBottom &&
        el.scrollHeight - el.clientHeight > 120 &&
        el.scrollTop < 120
      ) {
        this.loadOlderEntries();
      }
    },

    async loadOlderEntries() {
      if (
        this.streamLoadingOlder ||
        !this.streamHasMore ||
        !this.streamSessionId
      ) {
        return;
      }
      this.streamLoadingOlder = true;
      const el = this.$refs.liveStreamBody;
      // Anchor on the current topmost entry's DOM node (preserved across the
      // keyed prepend) rather than total height — immune to a live entry landing
      // at the bottom mid-fetch, which would otherwise skew a height delta.
      const anchor = el?.querySelector(".live-entry");
      const anchorTopBefore = anchor ? anchor.offsetTop : 0;
      const prevTop = el ? el.scrollTop : 0;
      try {
        const res = await fetch(
          `/api/transcript?provider=${encodeURIComponent(this.streamProvider)}` +
            `&id=${encodeURIComponent(this.streamSessionId)}` +
            `&before=${this.streamHistoryStart}&limit=50`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const older = (data.entries ?? [])
          .map((e) => this.tagStreamEntry(e))
          .filter(Boolean);
        if (older.length) this.streamEntries.unshift(...older);
        this.reconcileToolResults();
        this.streamHistoryStart = data.historyStart ?? 0;
        this.streamHasMore = !!data.hasMore;
        await this.$nextTick();
        if (el && anchor) {
          el.scrollTop = prevTop + (anchor.offsetTop - anchorTopBefore);
        }
      } catch (err) {
        this.streamError = err.message ?? String(err);
      } finally {
        // Clear after the anchor write's scroll event has fired (scroll steps
        // run before rAF), so it isn't mistaken for a fresh scroll-to-top.
        window.requestAnimationFrame(() => {
          this.streamLoadingOlder = false;
        });
      }
    },

    scheduleStreamScroll(shouldScroll = false) {
      if (!shouldScroll) return;
      if (this.streamScrollFrame) {
        window.cancelAnimationFrame(this.streamScrollFrame);
      }
      this.streamScrollFrame = window.requestAnimationFrame(() => {
        this.streamScrollFrame = window.requestAnimationFrame(() => {
          this.streamScrollFrame = null;
          this.scrollStreamToBottom();
        });
      });
    },

    scrollStreamToBottom() {
      const el = this.$refs.liveStreamBody;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      this.streamPinnedToBottom = true;
    },

    // Pre-render an entry to HTML once, on receipt. Splitting into segments lets
    // each block render in its natural form: conversational text as Markdown,
    // tool calls / tool results / file dumps as verbatim escaped code blocks
    // (long ones collapsed). Computing once also avoids re-rendering Markdown for
    // every entry on each reactive update.
    buildEntryHtml(entry) {
      const results = entry.__toolResults || {};
      return this.streamEntrySegments(entry)
        .map((seg) => {
          let html = this.renderStreamSegment(seg);
          // A tool_use renders with its paired result right below it once the
          // result arrives — a terminal-style call/output block.
          if (seg.toolUseId && results[seg.toolUseId]) {
            html += this.renderStreamSegment(
              this.resultSegment(results[seg.toolUseId]),
            );
          }
          return html;
        })
        .join("");
    },

    resultSegment(part) {
      return {
        kind: "code",
        label: part.is_error ? "⚠ result (error)" : "↳ result",
        error: !!part.is_error,
        text: this.segText(part.content),
      };
    },

    renderStreamSegment(seg) {
      if (seg.kind === "task-notification") {
        const task = seg.task;
        const usage = [
          task.totalTokens ? `${fmtNum(Number(task.totalTokens))} tokens` : "",
          task.toolUses ? `${fmtNum(Number(task.toolUses))} tools` : "",
          formatDurationMs(task.durationMs),
        ].filter(Boolean);
        const result = task.result?.trim()
          ? `<div class="live-task-result">${renderMarkdown(task.result)}</div>`
          : "";
        const usageHtml = usage.length
          ? `<div class="live-task-meta">${usage
              .map((item) => `<span>${escapeHtml(item)}</span>`)
              .join("")}</div>`
          : "";
        return [
          '<section class="live-task-card">',
          `<div class="live-task-kicker">${escapeHtml(task.status)}</div>`,
          `<div class="live-task-title">${escapeHtml(task.summary)}</div>`,
          result,
          usageHtml,
          "</section>",
        ].join("");
      }
      if (seg.kind === "markdown") {
        const body = renderMarkdown(seg.text);
        if (!seg.label) return body;
        const cls = seg.note ? "live-seg live-seg--note" : "live-seg";
        return `<div class="${cls}"><div class="live-seg-label">${escapeHtml(seg.label)}</div>${body}</div>`;
      }
      const text = seg.text ?? "";
      const cls = seg.error ? "live-seg-code is-error" : "live-seg-code";
      const pre = `<pre class="${cls}">${escapeHtml(text)}</pre>`;
      const lineCount = text ? text.split("\n").length : 0;
      if (lineCount > STREAM_COLLAPSE_LINES) {
        const summary = `${escapeHtml(seg.label || "output")} · ${lineCount} lines`;
        return `<details class="live-seg"><summary>${summary}</summary>${pre}</details>`;
      }
      const label = seg.label
        ? `<div class="live-seg-label">${escapeHtml(seg.label)}</div>`
        : "";
      return `<div class="live-seg">${label}${pre}</div>`;
    },

    streamEntrySegments(entry) {
      if (entry?.type === "response_item") {
        const segs = this.codexPayloadSegments(entry.payload);
        return segs.length
          ? segs
          : [{ kind: "code", text: JSON.stringify(entry, null, 2) }];
      }
      const content = entry?.message?.content ?? entry?.content ?? entry?.text;
      const segs = this.contentSegments(content);
      if (segs.length) return segs;
      if (entry?.toolUseResult) {
        return [{ kind: "code", text: this.segText(entry.toolUseResult) }];
      }
      if (entry?.message?.usage) {
        return [
          { kind: "code", text: JSON.stringify(entry.message.usage, null, 2) },
        ];
      }
      return [{ kind: "code", text: JSON.stringify(entry, null, 2) }];
    },

    codexPayloadSegments(payload) {
      if (!payload || typeof payload !== "object") return [];
      if (payload.type === "message")
        return this.contentSegments(payload.content);
      if (payload.type === "function_call") {
        return [
          {
            kind: "code",
            label: payload.name ?? "tool",
            text: this.prettyJsonText(
              payload.arguments ?? JSON.stringify(payload, null, 2),
            ),
            toolUseId: payload.call_id,
          },
        ];
      }
      if (payload.type === "function_call_output") {
        return [
          this.resultSegment({
            content: payload.output ?? JSON.stringify(payload, null, 2),
          }),
        ];
      }
      return [];
    },

    prettyJsonText(value) {
      if (typeof value !== "string") return this.segText(value);
      const trimmed = value.trim();
      if (!trimmed) return "";
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    },

    contentSegments(content) {
      if (content == null) return [];
      if (typeof content === "string") {
        const task = parseTaskNotification(content);
        if (task) return [{ kind: "task-notification", task }];
        return content.trim() ? [{ kind: "markdown", text: content }] : [];
      }
      if (!Array.isArray(content)) {
        const text = content.text ?? content.content;
        if (typeof text === "string") {
          return text.trim() ? [{ kind: "markdown", text }] : [];
        }
        return [{ kind: "code", text: JSON.stringify(content, null, 2) }];
      }
      const out = [];
      for (const part of content) {
        if (typeof part === "string") {
          if (part.trim()) out.push({ kind: "markdown", text: part });
          continue;
        }
        if (!part || typeof part !== "object") continue;
        if (
          (part.type === "text" ||
            part.type === "input_text" ||
            part.type === "output_text") &&
          part.text?.trim()
        ) {
          out.push({ kind: "markdown", text: part.text });
        } else if (part.type === "thinking" && part.thinking?.trim()) {
          out.push({
            kind: "markdown",
            text: part.thinking,
            label: "💭 thinking",
            note: true,
          });
        } else if (part.type === "tool_use") {
          const input =
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input ?? {}, null, 2);
          out.push({
            kind: "code",
            label: `🔧 ${part.name ?? "tool"}`,
            text: input,
            toolUseId: part.id,
          });
        } else if (part.type === "tool_result") {
          out.push(this.resultSegment(part));
        } else if (part.type === "image") {
          out.push({ kind: "code", text: "[image]" });
        } else {
          const text = part.text ?? part.content;
          if (typeof text === "string") out.push({ kind: "markdown", text });
          else out.push({ kind: "code", text: JSON.stringify(part, null, 2) });
        }
      }
      return out;
    },

    // Flatten a tool-result/content value (string, array of blocks, or object)
    // into displayable text for a code block.
    segText(value) {
      if (value == null) return "";
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value
          .map((part) =>
            typeof part === "string"
              ? part
              : (part.text ?? part.content ?? JSON.stringify(part)),
          )
          .filter(Boolean)
          .join("\n");
      }
      if (typeof value === "object") {
        return value.text ?? value.content ?? JSON.stringify(value, null, 2);
      }
      return String(value);
    },

    // The tool_result blocks of a pure tool-result entry (every block is a
    // tool_result). Mixed entries (real user text + a result) are left alone.
    streamEntryToolResults(entry) {
      if (entry?.payload?.type === "function_call_output") {
        return [
          {
            content:
              entry.payload.output ?? JSON.stringify(entry.payload, null, 2),
            tool_use_id: entry.payload.call_id,
          },
        ];
      }
      const content = entry?.message?.content;
      if (!Array.isArray(content) || !content.length) return [];
      const results = content.filter((b) => b && b.type === "tool_result");
      if (!results.length || results.length !== content.length) return [];
      return results;
    },

    // Merge each pure tool-result entry into the entry that holds the matching
    // tool_use (linked by tool_use_id) so a call and its output render as one
    // terminal-style block — and the standalone result entry (a misleading
    // "user" bubble) disappears. Runs after live append and history paging;
    // orphan results whose tool_use isn't loaded stay standalone until it is.
    reconcileToolResults() {
      const toolUseEntry = {};
      for (const e of this.streamEntries) {
        if (e?.payload?.type === "function_call" && e.payload.call_id) {
          toolUseEntry[e.payload.call_id] = e;
        }
        const content = e?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b && b.type === "tool_use" && b.id) toolUseEntry[b.id] = e;
        }
      }
      const remove = new Set();
      for (const e of this.streamEntries) {
        const results = this.streamEntryToolResults(e);
        if (!results.length) continue;
        if (!results.every((r) => toolUseEntry[r.tool_use_id])) continue;
        for (const r of results) {
          const target = toolUseEntry[r.tool_use_id];
          target.__toolResults = {
            ...(target.__toolResults || {}),
            [r.tool_use_id]: r,
          };
          target.__html = this.buildEntryHtml(target);
        }
        remove.add(e.__key);
      }
      if (remove.size) {
        this.streamEntries = this.streamEntries.filter(
          (e) => !remove.has(e.__key),
        );
      }
    },

    // Display label for an entry's role. A pure tool-result entry that couldn't
    // be merged (its tool_use isn't loaded) shows "tool result", not "user".
    streamEntryRole(entry) {
      if (this.streamEntryToolResults(entry).length) return "tool result";
      if (this.streamEntryHasToolSegments(entry)) return "tool";
      if (entry?.type === "response_item") {
        if (entry.payload?.type === "message")
          return entry.payload.role || "message";
        if (entry.payload?.type === "function_call") return "tool";
        if (entry.payload?.type === "function_call_output")
          return "tool result";
      }
      return entry.type || "unknown";
    },

    streamEntryHasToolSegments(entry) {
      if (entry?.payload?.type === "function_call") return true;
      const content = entry?.message?.content;
      return (
        Array.isArray(content) &&
        content.some((b) => b && b.type === "tool_use")
      );
    },

    liveEntryClass(entry) {
      const role = this.streamEntryRole(entry).replace(/\s+/g, "-");
      const toolClass = this.streamEntryHasToolSegments(entry)
        ? " has-tool-segments"
        : "";
      return `live-entry is-${role}${toolClass}`;
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

    usageLimitProviderView(key, label, limits, waitingLabel, fallbackPath) {
      const windows = [
        this.usageLimitWindowView("fiveHour", "5hr", limits?.fiveHour),
        this.usageLimitWindowView("weekly", "Weekly", limits?.weekly),
      ].filter(Boolean);
      const error = limits?.error ?? null;
      const stale = limits?.stale === true;
      const state =
        error && windows.length === 0 ? "missing" : stale ? "stale" : "live";
      const sourceParts = [];
      if (limits?.capturedAt) {
        sourceParts.push(
          `captured ${this.formatUsageLimitCapture(limits.capturedAt)}`,
        );
      } else {
        sourceParts.push(waitingLabel);
      }
      if (limits?.plan) sourceParts.push(limits.plan);

      return {
        key,
        label,
        windows,
        state,
        sourceLabel: sourceParts.join(" / "),
        emptyLabel:
          error === "missing" || error === "missing-auth"
            ? "No live rate limit capture yet."
            : "Usage window data is unavailable.",
        path: limits?.path ?? fallbackPath,
      };
    },

    usageLimitWindowView(key, label, window) {
      if (!window) return null;

      const usedPercent =
        typeof window.usedPercent === "number" &&
        Number.isFinite(window.usedPercent)
          ? window.usedPercent
          : null;
      const elapsedPercent =
        typeof window.elapsedPercent === "number" &&
        Number.isFinite(window.elapsedPercent)
          ? window.elapsedPercent
          : null;
      const remainingMs =
        typeof window.remainingMs === "number" &&
        Number.isFinite(window.remainingMs)
          ? window.remainingMs
          : null;
      const usedClamped =
        usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent));
      const elapsedClamped =
        elapsedPercent === null
          ? null
          : Math.max(0, Math.min(100, elapsedPercent));
      const usedLabel =
        usedPercent === null
          ? "n/a"
          : `${Math.min(999, Math.max(0, usedPercent)).toFixed(
              usedPercent >= 10 ? 0 : 1,
            )}%`;
      const elapsedLabel =
        elapsedClamped === null ? "n/a" : `${elapsedClamped.toFixed(1)}%`;
      // Color encodes how close the window is to its cap, matching the budget
      // meter's sunrise ramp, not which window this is.
      const severity =
        usedClamped === null || usedClamped < 50
          ? "low"
          : usedClamped < 75
            ? "medium"
            : usedClamped < 90
              ? "high"
              : "critical";

      // Projected end-of-window usage if the current burn rate holds. Hold off
      // until enough of the window has elapsed that used/elapsed isn't dominated
      // by early noise (5% of the window: ~15min for 5hr, ~8h for weekly).
      let projectedAngle = null;
      let projectedLevel = null;
      let projectedAria = null;
      if (
        usedClamped !== null &&
        elapsedClamped !== null &&
        elapsedClamped >= 5
      ) {
        const projected = (usedClamped / elapsedClamped) * 100;
        projectedLevel =
          projected >= 100 ? "over" : projected >= 80 ? "warn" : "safe";
        // Marker angle around the ring: 0% sits at 12 o'clock, sweeping clockwise.
        projectedAngle = Math.min(100, projected) * 3.6;
        projectedAria =
          projectedLevel === "over"
            ? "Projected to hit the limit before reset"
            : `Projected ~${Math.round(projected)}% at reset`;
      }

      return {
        key,
        label,
        usedLabel,
        usedValueNow: usedClamped === null ? null : Math.round(usedClamped),
        severity,
        // Arc lengths feed stroke-dasharray on a circle whose circumference is
        // normalized to 100, so the clamped percent maps straight to the dash.
        usedArc: usedClamped === null ? 0 : Number(usedClamped.toFixed(2)),
        elapsedArc:
          elapsedClamped === null ? 0 : Number(elapsedClamped.toFixed(2)),
        projectedAngle,
        projectedLevel,
        projectedAria,
        resetLabel: window.resetAt
          ? `resets ${this.formatUsageLimitReset(window.resetAt)}`
          : "reset unavailable",
        elapsedLabel,
        remainingLabel: this.formatUsageLimitDuration(remainingMs),
        meterLabel:
          usedPercent === null
            ? `${label} usage unavailable`
            : `${label}: ${usedLabel} used, ${elapsedLabel} of window elapsed`,
      };
    },

    formatUsageLimitCapture(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "n/a";
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    },

    formatUsageLimitReset(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "n/a";
      return date.toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    },

    formatUsageLimitDuration(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";

      const totalMinutes = Math.max(0, Math.floor(value / 60000));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;

      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
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
