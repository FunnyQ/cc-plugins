import {
  escapeHtml,
  formatScore,
  percent,
  renderDimensions,
  scoreClass,
} from "./format.js";

const MAX_ROWS = 200;
const expandedRows = new Set();

// Why we render rows as given: The server owns all derivation — pairing, ordering,
// label parsing, and score attachment. We receive fully aggregated FleetRow objects
// and render them without reimplementing any of that logic. This split is deliberate:
// the derivation rules are unit-tested once, on the server, in TypeScript. A second
// implementation in the browser would drift from the first the moment either changed,
// and the two would disagree about something the user is watching in real time.

function renderScore(score) {
  if (!score) return "";

  const failure = score.hardFailed
    ? '<span class="failure">hard fail</span>'
    : "";
  return `
    <span class="c-fleet-score ${scoreClass(score)}">
      <span class="track" aria-hidden="true">
        <span class="fill" style="inline-size: ${percent(score.weighted)}"></span>
        <span class="threshold" style="inset-inline-start: ${percent(score.threshold)}"></span>
      </span>
      <span class="value">${formatScore(score.weighted)}</span>
      ${failure}
    </span>`;
}

function renderBreakdown(row) {
  if (!expandedRows.has(row.key) || !row.score?.breakdown?.length) return "";

  return `<div class="c-fleet-rubric" id="fleet-rubric-${escapeHtml(row.key)}">${renderDimensions(row.score.breakdown)}</div>`;
}

function renderRow(row, nowMs) {
  const inFlight = isInFlight(row);
  const hardFailed = Boolean(row.score?.hardFailed);
  const stateClass = hardFailed
    ? "-failed"
    : inFlight
      ? "-flight"
      : "-finished";
  const elapsed = elapsedText(row, nowMs);
  const unknownLabel =
    row.role === "unknown"
      ? `<span class="raw-label">${escapeHtml(row.label)}</span>`
      : "";
  const expandable = Boolean(row.score?.breakdown?.length);
  // A ticking row carries its own start time so the ticker can update this one
  // cell without rebuilding the table and throwing away keyboard focus.
  const ticking =
    inFlight && row.startedAt && row.elapsedMs === undefined
      ? ` data-started-at="${escapeHtml(row.startedAt)}"`
      : "";

  return `
    <div class="fleet-row ${stateClass}${expandable ? " -expandable" : ""}" role="row"
      data-row-key="${escapeHtml(row.key)}"${ticking} tabindex="${expandable ? "0" : "-1"}"
      aria-expanded="${expandable ? expandedRows.has(row.key) : false}">
      <span class="fleet-cell -status" role="cell"><span class="fleet-status" aria-label="${inFlight ? "in flight" : hardFailed ? "hard failed" : "finished"}"></span></span>
      <span class="fleet-cell -role" role="cell"><span class="role-badge">${escapeHtml(row.role)}</span>${unknownLabel}</span>
      <span class="fleet-cell -ref" role="cell">${escapeHtml(row.ref)}</span>
      <span class="fleet-cell -attempt" role="cell">${row.attempt === undefined ? "" : escapeHtml(row.attempt)}</span>
      <span class="fleet-cell -elapsed" role="cell">${elapsed}</span>
      <span class="fleet-cell -verdict" role="cell">${renderScore(row.score)}</span>
      <span class="fleet-cell -message" role="cell" title="${escapeHtml(row.message)}">${escapeHtml(row.message)}</span>
    </div>
    ${renderBreakdown(row)}`;
}

export function connectEvents({ onFleet, onState }) {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => onState?.("connected"));
  source.addEventListener("error", () => onState?.("reconnecting"));
  source.addEventListener("fleet", (event) => {
    try {
      onFleet?.(JSON.parse(event.data));
    } catch {
      onState?.("reconnecting");
    }
  });

  return () => {
    source.close();
    onState?.("closed");
  };
}

export function formatDuration(elapsedMs) {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/**
 * The one derived value we own is the elapsed display.
 *
 * A row still in flight arrives with `startedAt` set and `elapsedMs` undefined;
 * we tick it against the browser clock once per second for real-time feedback.
 * Once a row finishes we print `elapsedMs` as given and never recompute it.
 * Ticking is a rendering concern, not a derivation one, so the server leaves it here.
 */
export function elapsedText(row, nowMs) {
  if (!row.startedAt) return "";
  if (row.elapsedMs !== undefined) return formatDuration(row.elapsedMs);
  if (!isInFlight(row)) return "";
  return formatDuration(nowMs - Date.parse(row.startedAt));
}

export function isInFlight(row) {
  return row.status === "in-flight";
}

/** Advance the elapsed cell of every ticking row in place. */
export function tickElapsed(root, nowMs = Date.now()) {
  for (const row of root?.querySelectorAll?.("[data-started-at]") ?? []) {
    const cell = row.querySelector(".fleet-cell.-elapsed");
    if (!cell) continue;
    cell.textContent = formatDuration(
      nowMs - Date.parse(row.dataset.startedAt),
    );
  }
}

export function toggleRubric(rowKey) {
  if (expandedRows.has(rowKey)) expandedRows.delete(rowKey);
  else expandedRows.add(rowKey);
}

export function renderFleet(
  rows,
  entryCount,
  logPresent,
  connectionState,
  onRowClick,
) {
  const visibleRows = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
  const hiddenCount = Math.max((rows?.length ?? 0) - visibleRows.length, 0);
  const stateLabel =
    connectionState === "reconnecting"
      ? "reconnecting"
      : logPresent
        ? "live"
        : "waiting for the run";
  const nowMs = Date.now();
  const root = document.createElement("div");
  root.className = "c-fleet";
  root.innerHTML = `
    <header class="fleet-heading">
      <h2>Agent fleet</h2>
      <span class="connection -${connectionState === "reconnecting" ? "reconnecting" : logPresent ? "live" : "waiting"}">${stateLabel}</span>
      <span class="entry-count">${Number(entryCount) || 0} entries</span>
    </header>
    <div class="fleet-table" role="table" aria-label="Agent fleet">
      <div class="fleet-row fleet-columns" role="row">
        <span role="columnheader"><span class="visually-hidden">Status</span></span>
        <span role="columnheader">Role</span><span role="columnheader">Task</span>
        <span role="columnheader">Try</span><span role="columnheader">Elapsed</span>
        <span role="columnheader">Verdict</span><span role="columnheader">Message</span>
      </div>
      <div class="fleet-body" role="rowgroup">
        ${visibleRows.map((row) => renderRow(row, nowMs)).join("") || '<p class="fleet-empty">No agents seen yet.</p>'}
      </div>
    </div>
    ${hiddenCount ? `<p class="hidden-count">${hiddenCount} older rows hidden</p>` : ""}`;

  root.addEventListener("click", (event) => {
    const row = event.target.closest(".fleet-row[data-row-key]");
    if (row) onRowClick?.(row.dataset.rowKey);
  });
  root.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.matches(".fleet-row[data-row-key]")
    ) {
      event.preventDefault();
      onRowClick?.(event.target.dataset.rowKey);
    }
  });
  return root;
}
