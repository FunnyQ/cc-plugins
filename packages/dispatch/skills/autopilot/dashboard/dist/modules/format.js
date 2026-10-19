export const SCORE_MAX = 5;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatTokens(value) {
  if (value === undefined || value === null) return "N/A";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "N/A";
  if (number === 0) return "0";
  if (number < 1_000) return String(Math.trunc(number));
  if (number < 1_000_000) return `${(number / 1_000).toFixed(1)}K`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}

export function hasTokenReading(value) {
  const number = Number(value);
  return value !== null && Number.isFinite(number) && number >= 0;
}

/**
 * The figure every panel prints: fresh prompt tokens — content this agent processed
 * for the first time, excluding re-reads of the cache.
 *
 * This is the metric Claude Code's own Execute panel shows. Verified against a live
 * 11-agent run: `cache_creation_input_tokens` alone reproduces 9 of the 11 rows to
 * the digit (16,630 -> "16.6k", 49,911 -> "49.9k"), across two models and both
 * finished and running agents. Folding input+output in breaks the match — verify#2
 * is 44,920 fresh against 50,020 with them added, and the panel reads 44.9k.
 *
 * The counter is named for how Claude bills it (new prompt content is written to the
 * cache), but the concept is vendor-neutral, so `codex-usage.ts` maps codex's
 * non-cached input onto the same field. Read this as "fresh", not as "a cache write".
 *
 * Deliberately not the billed total. Cache reads carry 94–96% of that total, which
 * makes it a measure of how often context was re-sent rather than of work done, and
 * it cannot be reconciled with the harness panel sitting beside it.
 */
export function freshTokens(counts) {
  if (counts === undefined || counts === null) return undefined;
  return Number(counts.cacheWrite) || 0;
}

export function allHarnessTokens(...counts) {
  return counts.reduce((total, entry) => total + (freshTokens(entry) ?? 0), 0);
}

export function totalTokens(counts) {
  if (counts === undefined || counts === null) return undefined;
  return (
    (Number(counts.input) || 0) +
    (Number(counts.output) || 0) +
    (Number(counts.cacheRead) || 0) +
    (Number(counts.cacheWrite) || 0)
  );
}

// Calibrated on fresh tokens against the 661 agents on disk here (p50 39.5K, p75 55.5K,
// p90 75K): warn catches the top fifth, danger the top ~3%.
export const PER_AGENT_TOKEN_WARN = 60_000;
export const PER_AGENT_TOKEN_DANGER = 100_000;

export function tokenTier(value) {
  if (!hasTokenReading(value)) return "";
  const number = Number(value);
  if (number >= PER_AGENT_TOKEN_DANGER) return "-danger";
  if (number >= PER_AGENT_TOKEN_WARN) return "-warn";
  return "-normal";
}

export function percent(value, maximum = SCORE_MAX) {
  const number = Math.min(Math.max(Number(value) || 0, 0), maximum);
  return `${(number / maximum) * 100}%`;
}

export function scoreClass(score) {
  if (score.hardFailed) return "-failed";
  if (score.passed) return "-passed";
  return "-pending";
}

export function formatScore(score) {
  return Number(score).toFixed(2);
}

/**
 * Lives here rather than in fleet.js, where it started, because the fleet row,
 * the run header, and the berth plate all print it and a formatter shared three
 * ways is a formatter, not a fleet concern.
 */
export function formatDuration(elapsedMs) {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function waveHint(waves) {
  const sizes = waves?.sizes ?? [];
  const unschedulable = waves?.unschedulable ?? [];
  const parts = [];
  if (waves?.current) parts.push(`Wave ${waves.current} in flight`);
  parts.push(
    sizes.length
      ? `${sizes.length} ${sizes.length === 1 ? "wave" : "waves"} left, counting the one in flight: ${sizes.join(" → ")} tasks`
      : "No waves left to fly",
  );
  if (unschedulable.length) {
    parts.push(
      `${unschedulable.length} task(s) no wave can reach: ${unschedulable.join(", ")}`,
    );
  }
  return parts.join(" · ");
}

function largestWeight(breakdown) {
  return Math.max(
    ...breakdown.map((dimension) => Number(dimension.weight) || 0),
    1,
  );
}

function renderDimensions(breakdown) {
  const largest = largestWeight(breakdown);
  return breakdown
    .map(
      (dimension) => `
    <div class="dimension">
      <span class="label">${escapeHtml(dimension.name)}</span>
      <span class="bar" style="inline-size: ${percent(dimension.weight, largest)}">
        <span class="fill" style="inline-size: ${percent(dimension.score)}"></span>
      </span>
      <span class="score">${formatScore(dimension.score)}</span>
    </div>`,
    )
    .join("");
}

/*
 * An earlier pass laid the judge's markdown out with `white-space: pre-wrap` on the grounds that a
 * parser plus a sanitizer was too much machinery for evidence. The evidence is
 * hundreds of words long and its structure is the fastest way into it — a reader
 * hunting the blocking defect scans for the heading, and `##` in front of it and
 * `**` around the verdict are noise standing exactly where the signal should be.
 */

const INLINE_MARKUP = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

function renderInline(text) {
  return (
    text
      .split(INLINE_MARKUP)
      // split() with one capturing group puts the matches at every odd index.
      .map((piece, index) => {
        if (index % 2 === 0) return escapeHtml(piece);
        if (piece.startsWith("`")) {
          return `<code>${escapeHtml(piece.slice(1, -1))}</code>`;
        }
        if (piece.startsWith("**")) {
          return `<strong>${escapeHtml(piece.slice(2, -2))}</strong>`;
        }
        return `<em>${escapeHtml(piece.slice(1, -1))}</em>`;
      })
      .join("")
  );
}

const FENCE = /^\s*```\s*(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;

export function renderRationale(source) {
  const out = [];
  let paragraph = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item) => `<li>${renderInline(item)}</li>`);
    const open =
      list.tag === "ol" && list.start !== 1
        ? `<ol start="${list.start}">`
        : `<${list.tag}>`;
    out.push(`${open}${items.join("")}</${list.tag}>`);
    list = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };
  const flushFence = () => {
    const lang = fence.lang ? ` data-lang="${escapeHtml(fence.lang)}"` : "";
    out.push(
      `<pre${lang}><code>${escapeHtml(fence.lines.join("\n"))}</code></pre>`,
    );
    fence = null;
  };

  for (const line of String(source ?? "").split("\n")) {
    const fenced = FENCE.exec(line);
    if (fence) {
      if (fenced) flushFence();
      else fence.lines.push(line);
      continue;
    }
    if (fenced) {
      flushBlocks();
      fence = { lang: fenced[1], lines: [] };
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushBlocks();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (RULE.test(line)) {
      flushBlocks();
      out.push("<hr>");
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list)
        list = { tag, start: ordered ? Number(ordered[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1] : ordered[2]);
      continue;
    }

    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    if (list) {
      list.items[list.items.length - 1] += `\n${line}`;
      continue;
    }
    paragraph.push(line);
  }

  if (fence) flushFence();
  flushBlocks();
  return out.join("");
}

export function renderRubric(score) {
  const dimensions = score?.breakdown?.length
    ? renderDimensions(score.breakdown)
    : "";
  const rationale = String(score?.rationale ?? "").trim();
  if (!rationale) return dimensions;

  // A div, not a p: the prose now carries block children of its own.
  return `${dimensions}
    <div class="rationale">${renderRationale(rationale)}</div>`;
}

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku"];

export function formatModel(id) {
  const raw = String(id ?? "");
  const family = CLAUDE_FAMILIES.find((name) => raw.includes(name));
  return family ?? raw.replaceAll("-", " ");
}

export function formatModelList(ids) {
  if (!ids || !ids.length) return "";
  const labels = [];
  for (const id of ids) {
    const label = formatModel(id);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(" / ");
}

export function compareTaskOrder(left, right) {
  return (
    String(left.bucket ?? "").localeCompare(String(right.bucket ?? "")) ||
    String(left.nn ?? "").localeCompare(String(right.nn ?? ""), undefined, {
      numeric: true,
    }) ||
    String(left.ref ?? "").localeCompare(String(right.ref ?? ""))
  );
}
