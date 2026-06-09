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

const OPENCODE_PALETTE = [
  "oklch(62% 0.18 165)",
  "oklch(58% 0.16 185)",
  "oklch(68% 0.14 145)",
  "oklch(54% 0.18 205)",
  "oklch(72% 0.12 175)",
  "oklch(60% 0.15 135)",
  "oklch(66% 0.16 195)",
  "oklch(56% 0.14 155)",
];

const OTHER_COLOR = "oklch(64% 0.014 50)";
const CLAUDE_FAMILY_COLORS = {
  haiku: "oklch(78% 0.16 78)",
  sonnet: "oklch(66% 0.20 25)",
  opus: "oklch(60% 0.20 330)",
};

const colorCache = new Map();
function colorFor(model) {
  if (model === "__other__") return OTHER_COLOR;
  if (!colorCache.has(model)) {
    const familyColor = claudeFamilyColor(model);
    if (familyColor) {
      colorCache.set(model, familyColor);
    } else {
      const provider = providerForModel(model);
      const palette =
        provider === "codex"
          ? CODEX_PALETTE
          : provider === "opencode"
            ? OPENCODE_PALETTE
            : CLAUDE_PALETTE;
      const idx = hashString(rawModel(model)) % palette.length;
      colorCache.set(model, palette[idx]);
    }
  }
  return colorCache.get(model);
}

function claudeFamilyColor(model) {
  if (providerForModel(model) !== "claude") return null;
  const raw = rawModel(model).toLowerCase();
  if (raw.includes("haiku")) return CLAUDE_FAMILY_COLORS.haiku;
  if (raw.includes("sonnet")) return CLAUDE_FAMILY_COLORS.sonnet;
  if (raw.includes("opus")) return CLAUDE_FAMILY_COLORS.opus;
  return null;
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
  if (provider === "opencode") return `OpenCode · ${compact}`;
  if (provider === "claude") return `Claude · ${compact}`;
  return compact;
}

function providerForModel(m) {
  if (m.startsWith("codex:")) return "codex";
  if (m.startsWith("opencode:")) return "opencode";
  if (m.startsWith("claude:")) return "claude";
  return "claude";
}

function rawModel(m) {
  return m
    .replace(/^(claude|codex|opencode):/, "")
    .replace("anthropic/", "")
    .replace(/-\d{8}$/, "")
    .replace("claude-", "");
}

function modelMarkClass(model) {
  return {
    dot: true,
    "dot--codex": providerForModel(model) === "codex",
    "dot--opencode": providerForModel(model) === "opencode",
    "dot--claude": providerForModel(model) === "claude",
  };
}

function providerBadgeClass(provider) {
  return {
    badge: true,
    "badge--claude": provider === "claude",
    "badge--codex": provider === "codex",
    "badge--opencode": provider === "opencode",
  };
}

function providerLabel(provider) {
  return (
    {
      all: "All",
      claude: "Claude",
      codex: "Codex",
      opencode: "OpenCode",
    }[provider] ?? provider
  );
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
const LIVE_POLL_MS = 3_000;
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
  "openCodeMessages",
  "openCodeSessions",
  "openCodeToolCalls",
  "claudeTokens",
  "codexTokens",
  "openCodeTokens",
  "claudeCostUSD",
  "codexCostUSD",
  "openCodeCostUSD",
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
  providerKey: ["all", "claude", "codex", "opencode"],
  rangeKey: ["24h", "7", "30", "90", "all"],
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
  const isCost = Math.abs(value - (p.costUSD ?? Number.NaN)) < 0.000001;
  const providerValues = [
    {
      key: "claude",
      label: "Claude",
      value: p.providers?.claude
        ? isCost
          ? (p.providers.claude.costUSD ?? 0)
          : (p.providers.claude.tokens ?? 0)
        : claudeValue,
    },
    {
      key: "codex",
      label: "Codex",
      value: p.providers?.codex
        ? isCost
          ? (p.providers.codex.costUSD ?? 0)
          : (p.providers.codex.tokens ?? 0)
        : codexValue,
    },
    {
      key: "opencode",
      label: "OpenCode",
      value: p.providers?.opencode
        ? isCost
          ? (p.providers.opencode.costUSD ?? 0)
          : (p.providers.opencode.tokens ?? 0)
        : isCost
          ? (p.openCodeCostUSD ?? 0)
          : (p.openCodeTokens ?? 0),
    },
  ].filter((provider) => provider.value > 0);
  const providerTotal =
    providerValues.reduce((sum, provider) => sum + provider.value, 0) ||
    value ||
    1;
  return {
    ...p,
    displayLabel: fmt(value),
    pct: ((value / total) * 100).toFixed(1),
    providerSegments: providerValues.map((provider) => ({
      ...provider,
      pct: ((provider.value / providerTotal) * 100).toFixed(1),
      display: fmt(provider.value),
      className: `project-rank-meter-segment--${provider.key}`,
    })),
    claudePct: ((claudeValue / providerTotal) * 100).toFixed(1),
    codexPct: ((codexValue / providerTotal) * 100).toFixed(1),
    hasClaude: claudeValue > 0,
    hasCodex: codexValue > 0,
    claudeDisplay: fmt(claudeValue),
    codexDisplay: fmt(codexValue),
  };
}

export {
  loadChartJs,
  colorFor,
  fmtNum,
  fmtTokens,
  fmtUSD,
  shortModel,
  providerLabel,
  providerForModel,
  rawModel,
  modelMarkClass,
  providerBadgeClass,
  cssVar,
  DAYS,
  MONTHS,
  AUTO_REFRESH_MS,
  LIVE_POLL_MS,
  ANOMALY_MULTIPLIER,
  ANOMALY_MIN_COST,
  ANOMALY_MIN_TOKENS,
  LEDGER_INITIAL_VISIBLE,
  LEDGER_PAGE_SIZE,
  MODEL_EXPORT_HEADERS,
  PROJECT_EXPORT_HEADERS,
  TOKEN_BUCKETS,
  saveStoredTheme,
  detectInitialTheme,
  loadStoredPrefs,
  saveStoredPrefs,
  normalizePrefs,
  enrichProjectRow,
};
