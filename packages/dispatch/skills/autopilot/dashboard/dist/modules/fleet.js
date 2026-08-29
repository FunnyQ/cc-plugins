import {
  escapeHtml,
  formatScore,
  formatTokens,
  freshTokens,
  percent,
  renderDimensions,
  scoreClass,
  tokenTier,
  totalTokens,
} from "./format.js";

const MAX_ROWS = 200;
const expandedRows = new Set();
// Collapse state lives here, not in the DOM: every SSE frame rebuilds the panel,
// so a class on the old node would be thrown away a second later.
let fleetCollapsed = false;

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

// Local to this module: it has one caller, renderRow. The chip prints fresh tokens
// only, so the title carries the billed total and the counters behind both.
function tokenTitle(usage) {
  return usage
    ? `fresh ${usage.cacheWrite} · billed total ${totalTokens(usage)} (cache read ${usage.cacheRead} · input ${usage.input} · output ${usage.output})`
    : "no transcript matched this agent";
}

// Under the role chip rather than in a column of its own: the count belongs to
// the agent, and a whole column bought one number per row at the cost of the
// width the message needs.
// The external CLI's own spend, printed beside the driver's rather than added to it.
// A dev-codex row is a cheap Haiku driver plus an expensive external model, and one
// merged figure would read as a single very expensive Claude agent.
//
// Tiered on the same thresholds as the Claude figure: the reader is scanning one
// column for "which agent is expensive", and a second scale in that column would mean
// two ambers stood for two different amounts. The `cdx` prefix carries the vendor, so
// the colour is free to carry the budget.
function renderCodexTokens(codexUsage) {
  if (!codexUsage) return "";
  const fresh = freshTokens(codexUsage);
  const tier = tokenTier(fresh);
  const title = `codex — fresh ${codexUsage.cacheWrite} · cache read ${codexUsage.cacheRead} · output ${codexUsage.output}`;
  return `<span class="role-tokens -codex${tier ? ` ${tier}` : ""}" title="${escapeHtml(title)}">cdx ${escapeHtml(formatTokens(fresh))}</span>`;
}

function renderTokens(usage, codexUsage) {
  const fresh = freshTokens(usage);
  // An unmeasured count carries no tier, so it gets no class rather than an
  // empty one — the CSS reads the absence, and the markup stays legible.
  const tier = tokenTier(fresh);
  return `<span class="role-tokens${tier ? ` ${tier}` : ""}" title="${escapeHtml(tokenTitle(usage))}">${escapeHtml(formatTokens(fresh))}</span>${renderCodexTokens(codexUsage)}`;
}

// A leading PASS / FAIL is structure, not prose — agents write it on nearly every
// verify and judge message. The dash after it is the separator the chip replaces.
const VERDICT_PREFIX = /^(PASS|FAIL|SKIP|BLOCKED)\s*(?:[—–-]\s*)?/;

/*
 * Identifiers the agents write bare, with no backticks to mark them:
 *   Foo::Bar          ActiveRecord::InvalidMigrationTimestampError
 *   snake_case        cms_kit, change_reason
 *   cmd:sub           db:prepare
 *   long digit runs   20260901000100 (a migration timestamp)
 *   short hex         32b4ea0 (a commit sha)
 *
 * Deliberately narrow. Ordinary English carries no underscores and no `::`, and the
 * colon form needs a letter on both sides, so `shas: 32b4ea0` does not match across
 * the space. Over-matching here would tint half the sentence and the emphasis would
 * stop meaning anything.
 */
const CODEISH =
  /([A-Za-z][\w.]*::[\w.:]+|\b\w+_\w+\b|\b[a-z][\w.-]*:[a-z][\w.:-]*\b|\b\d{6,}\b|\b[0-9a-f]{7,40}\b)/g;

/**
 * The message cell's markup.
 *
 * Escaping runs per token rather than once over the whole string. Escaping first
 * would put `&amp;` and `&#039;` into the text, and the hex-sha branch of CODEISH
 * would then match inside those entities and split them — turning a rendered `&`
 * into visible markup. Splitting first, then escaping each piece, cannot.
 */
export function renderMessage(message) {
  const text = String(message ?? "");
  if (!text) return "";

  const verdict = VERDICT_PREFIX.exec(text);
  const chip = verdict
    ? `<span class="msg-verdict -${verdict[1].toLowerCase() === "pass" ? "pass" : "fail"}">${verdict[1]}</span>`
    : "";
  const body = verdict ? text.slice(verdict[0].length) : text;

  const marked = body
    .split(CODEISH)
    .map((piece, index) =>
      // split() with one capturing group puts the matches at every odd index.
      index % 2 === 1 ? `<code>${escapeHtml(piece)}</code>` : escapeHtml(piece),
    )
    .join("");

  return `${chip}${marked}`;
}

function renderBreakdown(row) {
  if (!expandedRows.has(row.key) || !row.score?.breakdown?.length) return "";

  return `<div class="c-fleet-rubric" id="fleet-rubric-${escapeHtml(row.key)}">${renderDimensions(row.score.breakdown)}</div>`;
}

function renderRow(row, nowMs) {
  const inFlight = isInFlight(row);
  const hardFailed = Boolean(row.score?.hardFailed);
  // A gate that rejected the attempt reads as a rejection, not as a finish.
  // -failed stays reserved for a rubric veto, which is the louder of the two.
  const rejected = !hardFailed && row.outcome === "failed";
  // An agent that died without logging its end reported no verdict at all, so it
  // must not borrow the finished look — nothing here was completed.
  const abandoned = row.status === "abandoned";
  const stateClass = hardFailed
    ? "-failed"
    : rejected
      ? "-rejected"
      : inFlight
        ? "-flight"
        : abandoned
          ? "-abandoned"
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
      <span class="fleet-cell -status" role="cell"><span class="fleet-status" aria-label="${inFlight ? "in flight" : hardFailed ? "hard failed" : rejected ? "did not pass" : abandoned ? "no end reported" : "finished"}"></span></span>
      <span class="fleet-cell -role" role="cell"><span class="role-badge">${escapeHtml(row.role)}</span>${renderTokens(row.usage, row.codexUsage)}${unknownLabel}</span>
      <span class="fleet-cell -ref" role="cell">${escapeHtml(row.ref)}</span>
      <span class="fleet-cell -attempt" role="cell">${row.attempt === undefined ? "" : escapeHtml(row.attempt)}</span>
      <span class="fleet-cell -elapsed" role="cell">${elapsed}</span>
      <span class="fleet-cell -verdict" role="cell">${renderScore(row.score)}</span>
      <span class="fleet-cell -message" role="cell">${renderMessage(row.message)}</span>
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

/**
 * How long the whole run has been flying: earliest start to now while anything
 * is in flight, else to the last finish. Returns null before the first agent
 * starts. `live` tells the caller whether the value still needs ticking.
 */
export function runElapsed(rows, nowMs = Date.now()) {
  const started = (Array.isArray(rows) ? rows : []).filter(
    (row) => row.startedAt,
  );
  if (!started.length) return null;

  const startMs = Math.min(...started.map((row) => Date.parse(row.startedAt)));
  const live = started.some((row) => isInFlight(row));
  if (live) return { ms: nowMs - startMs, live: true };

  const endMs = Math.max(
    ...started.map(
      (row) => Date.parse(row.startedAt) + (Number(row.elapsedMs) || 0),
    ),
  );
  return { ms: endMs - startMs, live: false };
}

export function isFleetCollapsed() {
  return fleetCollapsed;
}

export function toggleFleet() {
  fleetCollapsed = !fleetCollapsed;
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
  root.className = `c-fleet${fleetCollapsed ? " -collapsed" : ""}`;
  const table = `
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
  root.innerHTML = `
    <header class="fleet-heading">
      <button type="button" class="fleet-toggle" aria-expanded="${fleetCollapsed ? "false" : "true"}">
        <span class="chevron" aria-hidden="true"></span>
        <h2>Agent fleet</h2>
      </button>
      <span class="connection -${connectionState === "reconnecting" ? "reconnecting" : logPresent ? "live" : "waiting"}">${stateLabel}</span>
      <span class="entry-count">${Number(entryCount) || 0} entries</span>
      <span class="row-count">${rows?.length ?? 0} agents</span>
    </header>
    ${fleetCollapsed ? "" : table}`;

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
