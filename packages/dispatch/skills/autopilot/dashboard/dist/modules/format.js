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

// Per-agent and per-task budget thresholds. They are read against one agent's
// spend or one task's, never against a plan-wide total: the header's rollup
// clears both on any real run, and a figure that is permanently red teaches the
// eye to stop reading the colour. That total stays untiered on purpose.
export const TOKEN_WARN = 80_000;
export const TOKEN_DANGER = 200_000;

/**
 * The tier class for a token count, or "" when there is no measurement.
 *
 * Absent is not a tier. A row with no matched transcript prints N/A, and
 * painting that the normal colour would claim a reading nobody took.
 */
export function tokenTier(value) {
  // The same rejects formatTokens prints N/A for, so a tier class and a real
  // number always arrive together — a count the eye cannot read must not be
  // painted as if it had been measured.
  const number = Number(value);
  if (value === null || !Number.isFinite(number) || number < 0) return "";
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

function largestWeight(breakdown) {
  return Math.max(
    ...breakdown.map((dimension) => Number(dimension.weight) || 0),
    1,
  );
}

/**
 * The dimension rows of a rubric breakdown, as markup.
 *
 * The fleet table builds HTML strings and the task lanes are a petite-vue
 * template, but the user reads the same meter in both, so the rows are written
 * once here. Each panel keeps its own wrapper element.
 */
export function renderDimensions(breakdown) {
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
