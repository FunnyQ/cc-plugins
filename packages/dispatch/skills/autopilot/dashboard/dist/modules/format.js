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

/** A dimension bar is as wide as its weight against the heaviest dimension. */
export function weightWidth(weight, breakdown) {
  return percent(weight, largestWeight(breakdown));
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
