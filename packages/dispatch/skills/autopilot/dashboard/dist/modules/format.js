// Shared rendering rules for the fleet table and the task lanes.
//
// The user compares the same score meter across both panels, so the scale, the
// clamp, the pass/fail class, and the number format live here once. Two copies
// would drift the moment either panel changed.

// SCORE_MAX is the rubric scale, documented in the Eval rubric. ScoreEntry.weighted
// is on this scale (0–5). The meter display must match this scale for visual accuracy.
// If this value changes, meter thresholds and all score calculations must be reviewed.
export const SCORE_MAX = 5;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Absent must never render as zero: a row with no matched transcript burned an
// unknown amount, not a measured zero, and collapsing the two would look like a
// real reading to anyone glancing at the panel.
export function formatTokens(value) {
  if (value === undefined || value === null) return "N/A";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "N/A";
  if (number === 0) return "0";
  if (number < 1_000) return String(Math.trunc(number));
  if (number < 1_000_000) return `${(number / 1_000).toFixed(1)}K`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}

/** Whether a count was measured at all — exactly the values formatTokens prints N/A for. */
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
 *
 * An absent counts object stays absent rather than reading 0, so formatTokens still
 * prints N/A for a row no transcript matched.
 */
export function freshTokens(counts) {
  if (counts === undefined || counts === null) return undefined;
  return Number(counts.cacheWrite) || 0;
}

/**
 * Fresh tokens across every harness that worked on the plan — the header's one figure.
 *
 * The per-row and per-task panels keep Claude and codex apart, because there the reader
 * is asking which side of a dev step burned what. The plan-level number is the opposite
 * question — what did this flight cost in total — and two figures there would just be a
 * sum the reader has to do in their head.
 *
 * An absent side contributes 0 rather than making the whole total unavailable: a plan
 * with no external engine still has a real Claude total to print.
 */
export function allHarnessTokens(...counts) {
  return counts.reduce((total, entry) => total + (freshTokens(entry) ?? 0), 0);
}

/**
 * Every billed token, for the tooltip only. Kept beside `freshTokens` so a panel can
 * explain the smaller number it prints without a second trip to the server.
 */
export function totalTokens(counts) {
  if (counts === undefined || counts === null) return undefined;
  return (
    (Number(counts.input) || 0) +
    (Number(counts.output) || 0) +
    (Number(counts.cacheRead) || 0) +
    (Number(counts.cacheWrite) || 0)
  );
}

// Per-agent budget thresholds. Read against ONE agent's spend, never a per-task or
// plan-wide total: those aggregate several agents, clear both thresholds on any real
// run, and a figure that is permanently red teaches the eye to stop reading the colour.
//
// Calibrated on fresh tokens against the 661 agents on disk here (p50 39.5K, p75 55.5K,
// p90 75K): warn catches the top fifth, danger the top ~3%.
export const TOKEN_WARN = 60_000;
export const TOKEN_DANGER = 100_000;

/**
 * The tier class for one agent's token count, or "" when there is no measurement.
 * Only the fleet paints these — see the note on TOKEN_WARN.
 *
 * Absent is not a tier. A row with no matched transcript prints N/A, and
 * painting that the normal colour would claim a reading nobody took.
 */
export function tokenTier(value) {
  if (!hasTokenReading(value)) return "";
  const number = Number(value);
  if (number >= TOKEN_DANGER) return "-danger";
  if (number >= TOKEN_WARN) return "-warn";
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
 * An elapsed span, held to seven characters at its widest so a berth plate can
 * reserve the column before a reading exists. Sub-minute keeps a decimal
 * because a fast agent's whole life is a few seconds; past a minute the decimal
 * is noise.
 *
 * Lives here rather than in fleet.js, where it started, because the fleet row,
 * the run header, and the berth plate all print it and a formatter shared three
 * ways is a formatter, not a fleet concern.
 */
export function formatDuration(elapsedMs) {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/**
 * The wave readout's tooltip — what the two figures in the header mean.
 *
 * The count includes the wave in flight, which is the one thing about it a
 * reader can get wrong: a run mid-wave-2 of two shows "2 left", not "1 left".
 * The per-wave sizes come along because they are the shape of the run ahead —
 * `4 → 1` is one broad pass then the final review, and that reads nothing like
 * `1 → 1 → 1 → 1`.
 */
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

/** The dimension rows of a rubric breakdown, as markup. */
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
 * The judge's prose is markdown it wrote for `RUNLOG.md`, and the well below
 * renders it rather than printing it raw.
 *
 * An earlier pass laid it out with `white-space: pre-wrap` on the grounds that a
 * parser plus a sanitizer was too much machinery for evidence. The evidence is
 * hundreds of words long and its structure is the fastest way into it — a reader
 * hunting the blocking defect scans for the heading, and `##` in front of it and
 * `**` around the verdict are noise standing exactly where the signal should be.
 *
 * No sanitizer ships with it, because nothing here can produce markup the judge
 * did not get to write: every span of text passes through `escapeHtml` before it
 * is placed, the tag set is fixed and closed, and there is no branch that emits
 * an attribute from the source — no links, no images, no raw-HTML passthrough.
 * Keep that property when extending this: escape at the leaf, never at the seam.
 */

// Order is load-bearing twice over. Inline code leads so a `**` inside backticks
// stays literal, and `**` precedes `*` so a bold run is never read as emphasis
// wrapping a stray asterisk — JS alternation takes the first branch that matches
// at a position, not the longest.
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

/**
 * The judge's rationale as markup: headings, paragraphs, lists, fenced code,
 * and the two inline marks judges actually use.
 *
 * Headings start at `h3`. `h1` is the page and `h2` is the panel heading the
 * well sits under, and a rationale that opened at `h1` would outrank both.
 *
 * A fence left unterminated still renders as code. The trail is tailed from a
 * running agent, so the last block on screen is routinely half-written, and
 * dropping it would blank the one part the reader is waiting on.
 */
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
    // The judge's own first number, not a renumbering from 1. A rationale that
    // walks a seven-step pipeline numbers it 0..6, and an <ol> that ignored that
    // would print step 0 as step 1 and misreport every reference in the prose.
    // `start` is safe unescaped: it comes from a `\d+` capture, nothing else.
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

    // Lazy continuation. A judge hard-wraps a long item across lines, and
    // treating the second line as a new paragraph split the item in two and
    // started the next number at 1 — on a real trail that turned one seven-step
    // list into four lists that all began again. A non-blank line under an open
    // item belongs to that item, which is also what markdown says.
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

/**
 * The whole expanded rubric well: the dimension meters, then the judge's prose.
 *
 * The fleet table builds HTML strings and the task lanes are a petite-vue
 * template, but the user reads the same well in both, so it is written once
 * here. Each panel keeps its own wrapper element.
 *
 * Takes the score, not its `breakdown`, because a verdict is now two things: an
 * older trail has bars and no prose, and both panels must render that unchanged.
 */
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

/** Bucket, then task number read as a number, then ref. The lanes and the graph share it. */
export function compareTaskOrder(left, right) {
  return (
    String(left.bucket ?? "").localeCompare(String(right.bucket ?? "")) ||
    String(left.nn ?? "").localeCompare(String(right.nn ?? ""), undefined, {
      numeric: true,
    }) ||
    String(left.ref ?? "").localeCompare(String(right.ref ?? ""))
  );
}
