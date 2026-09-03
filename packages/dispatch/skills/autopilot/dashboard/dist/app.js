import { createApp, reactive } from "./vendor/petite-vue.es.js";
import { Lanes } from "./modules/lanes.js";
import {
  connectEvents,
  elapsedByTask,
  isInFlight,
  renderFleet,
  runElapsed,
  tickElapsed,
  tickGraphElapsed,
  toggleFleet,
  toggleRubric,
} from "./modules/fleet.js";
import { layoutGraph, relatedRefs, renderGraph } from "./modules/graph.js";
import {
  allHarnessTokens,
  formatDuration,
  formatTokens,
  waveHint,
} from "./modules/format.js";

const POLL_INTERVAL_MS = 3_000;

const emptyCounts = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const emptyUsage = () => ({
  byTask: {},
  unattributed: emptyCounts(),
  totals: emptyCounts(),
  agentCount: 0,
  codexByTask: {},
  codexTotals: emptyCounts(),
  codexRunCount: 0,
});

const emptyWaves = () => ({
  current: 0,
  remaining: 0,
  sizes: [],
  unschedulable: [],
});

const emptyTree = () => ({
  planTitle: "",
  slug: "",
  repo: "",
  buckets: [],
  tasks: [],
  counts: {
    total: 0,
    done: 0,
    inProgress: 0,
    ready: 0,
    blocked: 0,
    invalid: 0,
  },
  waves: emptyWaves(),
  errors: [],
});

const store = reactive({
  view: "graph",
  loading: true,
  loadError: null,
  tree: emptyTree(),
  Lanes,
  formatTokens,
  allHarnessTokens,
  waveHint,
  graphSvg: "",
  // Total flight time, from the first agent start. Empty until one starts.
  elapsed: "",
  elapsedLive: false,
  // Plan-wide token rollup, updated in place from the fleet stream — see onFleet.
  usage: emptyUsage(),
});

let graphLayout;
let graphStructure = "";
let graphNodes = [];
let graphPane = "";
// The berth whose route is currently set, and whether a redraw was held back
// while it was — see updateGraph.
let hoverRef = null;
let graphHeld = false;

/**
 * The pane's content box. The panel spreads its roads into the height and
 * compresses its gaps into the width, so both axes are layout inputs.
 *
 * Read off the DOM rather than guessed from the viewport: the pane is one row of
 * an outer grid, so its height is set by that grid and not by the panel, and
 * measuring it cannot feed back into what it measures. `clientWidth` and
 * `clientHeight` already exclude the scrollbar, which is what we want — the
 * panel must not fit itself into space a scrollbar is standing in.
 */
function paneBox() {
  const pane = document.querySelector(".c-dependency-graph");
  if (!pane) return {};
  const style = getComputedStyle(pane);
  return {
    availableHeight:
      pane.clientHeight -
      parseFloat(style.paddingBlockStart) -
      parseFloat(style.paddingBlockEnd),
    availableWidth:
      pane.clientWidth -
      parseFloat(style.paddingInlineStart) -
      parseFloat(style.paddingInlineEnd),
  };
}

function taskStructure(tasks) {
  return [...tasks]
    .map((task) => [task.ref, [...(task.dependsOn ?? [])].sort()])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, dependencies]) => `${ref}:${dependencies.join(",")}`)
    .join("|");
}

function updateGraph(tasks) {
  const graphTasks = Array.isArray(tasks) ? tasks : [];
  const structure = taskStructure(graphTasks);
  const box = paneBox();
  const pane = `${box.availableWidth}x${box.availableHeight}`;
  // Keep coordinates frozen while polling changes only live task state. The pane
  // box joins the structure in that key because the roads spread to fill its
  // height and the gaps compress to fit its width, so a resize is the one other
  // thing that has to move them.
  const moved =
    !graphLayout || structure !== graphStructure || pane !== graphPane;

  // Hold the panel still while a reader holds a route. petite-vue owns the SVG
  // through v-html, so any redraw swaps the whole tree and takes the hover
  // classes with it — and the fleet frame (2s) and the tree poll (3s) interleave
  // to about one wipe a second. The route is worth more than a token figure that
  // is seconds old, so a redraw that only changes figures waits for the pointer
  // to leave. A relayout cannot wait — the coordinates would be wrong — so it
  // redraws and repaints the route instead.
  if (hoverRef !== null && !moved) {
    graphNodes = graphTasks;
    graphHeld = true;
    return;
  }

  if (moved) {
    graphLayout = layoutGraph(graphTasks, box);
    graphStructure = structure;
    graphPane = pane;
  }
  // Usage and elapsed ride along rather than living in the layout: both change
  // on every fleet frame, and the coordinates must not move when a token count
  // or a clock does. Elapsed is derived from the fleet rows here rather than
  // served on the task payload, so a running berth's figure ticks with the
  // fleet row it came from instead of stepping once per tree poll.
  store.graphSvg = renderGraph(graphTasks, graphLayout, {
    usage: store.usage,
    elapsed: elapsedByTask(fleetState.rows),
  });
  graphNodes = graphTasks;
  graphHeld = false;
  // petite-vue flushes the swap in a microtask; repainting in the frame callback
  // therefore lands after the new SVG is in the DOM and before it is painted,
  // so a relayout mid-hover never shows an unlit frame.
  if (hoverRef !== null) requestAnimationFrame(repaintRoute);
}

function repaintRoute() {
  const container = document.querySelector(".deck-top");
  if (!container) return;
  // The held ref can be gone after a structural redraw — a route to a berth that
  // no longer exists would dim the whole panel and light nothing.
  const focus =
    hoverRef !== null && graphNodes.some(({ ref }) => ref === hoverRef)
      ? { ref: hoverRef, lit: relatedRefs(graphNodes, hoverRef) }
      : null;
  paintLineage(container, focus);
}

/**
 * Hover lineage. The SVG is replaced wholesale on every redraw, so the handlers
 * live on the container that survives — one listener pair, not one per node.
 * Classes go on the elements rather than inline styles so the CSS owns how a
 * dimmed node looks. A redraw would clear them, which is why updateGraph holds
 * the redraw back while a route is set.
 */
function litRefs(target) {
  const node = target?.closest?.(".graph-berth");
  if (!node) return null;
  const ref = node.dataset.ref;
  return { ref, lit: relatedRefs(graphNodes, ref) };
}

function paintLineage(container, focus) {
  const svg = container.querySelector(".dependency-graph");
  if (!svg) return;

  const lit = focus?.lit ?? null;
  svg.classList.toggle("-focus", focus !== null);

  // Links as well as crossovers: a route the panel sets has to light through the
  // running line inside a bucket, not just across the diagonals between them.
  //
  // One class, not three. An earlier pass also marked the one-hop parents and
  // children, but the whole lineage lights at one value on this instrument —
  // a route is set or it is not — so the extra grades had no rule behind them
  // and rendered nothing for the two versions they sat in the file.
  for (const edge of svg.querySelectorAll(
    ".graph-crossover, .graph-link, .graph-flow",
  )) {
    const { from, to } = edge.dataset;
    edge.classList.toggle("-lit", lit?.has(from) === true && lit.has(to));
  }

  for (const node of svg.querySelectorAll(".graph-berth")) {
    const ref = node.dataset.ref;
    node.classList.toggle("-lit", lit?.has(ref) === true);
    node.classList.toggle("-self", ref === focus?.ref);
  }
}

function bindGraphHover(container) {
  container.addEventListener("pointerover", (event) => {
    const focus = litRefs(event.target);
    if (!focus) return;
    hoverRef = focus.ref;
    paintLineage(container, focus);
  });
  container.addEventListener("pointerout", (event) => {
    // Leaving one node for another fires out before over; only clear when the
    // pointer has actually left every node.
    if (litRefs(event.relatedTarget)) return;
    hoverRef = null;
    paintLineage(container, null);
    // Whatever the panel held back while the route was set lands now.
    if (graphHeld) updateGraph(store.tree.tasks);
  });
}

async function loadTree() {
  try {
    const response = await fetch("/api/tree");

    if (!response.ok) {
      throw new Error(`Failed to fetch /api/tree (${response.status})`);
    }

    // `store.tree` is the only copy of the payload: the header, the lanes, and
    // the graph all read it, so nothing can disagree about what was last loaded.
    const payload = await response.json();
    Object.assign(store.tree, payload, {
      planTitle: payload.planTitle ?? "",
      slug: payload.slug ?? "",
      repo: payload.repo ?? "",
      counts: { ...emptyTree().counts, ...(payload.counts ?? {}) },
      waves: { ...emptyWaves(), ...(payload.waves ?? {}) },
      errors: Array.isArray(payload.errors) ? payload.errors : [],
    });
    updateGraph(store.tree.tasks);
    store.loadError = null;
  } catch (error) {
    store.loadError =
      error instanceof Error ? error.message : "API server not responding";
  } finally {
    store.loading = false;
  }
}

let pollTimer;
let fleetTimer;
const fleetState = {
  rows: [],
  entryCount: 0,
  logPresent: false,
  connection: "reconnecting",
};

function syncElapsed(nowMs = Date.now()) {
  const total = runElapsed(fleetState.rows, nowMs);
  store.elapsed = total ? formatDuration(total.ms) : "";
  store.elapsedLive = total?.live === true;
}

// Mutates store.usage's own fields rather than reassigning the object: the
// lanes view destructured this exact object at mount time, and swapping it
// out would freeze that view's card totals at their first-frame values.
function syncUsage(usage) {
  Object.assign(store.usage, usage ?? emptyUsage());
  // The graph is an HTML string, not a reactive template, so a new token count
  // only reaches a node when the SVG is rebuilt. The layout is cached, so this
  // redraws the same coordinates with fresh numbers.
  updateGraph(store.tree.tasks);
}

/**
 * How far the reader had scrolled into each open rationale, carried across the
 * redraw that is about to throw those elements away.
 *
 * Every fleet frame rebuilds the panel, and a replaced element starts at
 * scrollTop 0 — so a rationale being read jumped back to its first line once
 * every two seconds, which is long enough to find a paragraph and not long
 * enough to read it. The frames carry live token counts and elapsed times, so
 * there is no version of this that stops redrawing.
 *
 * Only the wells. `.deck-fleet` is a scrollport too, but `replaceChildren` swaps
 * atomically and the panel keeps its height, so the pane's own offset survives
 * on its own — measured, not assumed. It clamps only when the panel genuinely
 * shrinks, and no saved offset can restore height that is no longer there.
 *
 * Keyed by the rubric's own id, which derives from the row key: a row that moved
 * in the ordering keeps its reading position, and a row that has gone has no key
 * to restore.
 */
function captureRationaleScroll(mount) {
  const wells = new Map();
  for (const well of mount.querySelectorAll(".c-fleet-rubric")) {
    const prose = well.querySelector(".rationale");
    if (prose?.scrollTop) wells.set(well.id, prose.scrollTop);
  }
  return wells;
}

function restoreRationaleScroll(mount, wells) {
  for (const [id, top] of wells) {
    const prose = mount.querySelector(`#${CSS.escape(id)} .rationale`);
    if (prose) prose.scrollTop = top;
  }
}

function drawFleet() {
  const mount = document.querySelector(".deck-fleet");
  if (!mount) return;

  const wells = captureRationaleScroll(mount);
  mount.replaceChildren(
    renderFleet(
      fleetState.rows,
      fleetState.entryCount,
      fleetState.logPresent,
      fleetState.connection,
      (rowKey) => {
        const row = fleetState.rows.find(({ key }) => key === rowKey);
        if (!row?.score?.breakdown?.length) return;
        toggleRubric(rowKey);
        drawFleet();
      },
    ),
  );
  restoreRationaleScroll(mount, wells);

  mount.querySelector(".fleet-toggle")?.addEventListener("click", () => {
    toggleFleet();
    drawFleet();
  });
}

function syncFleetTicker() {
  clearInterval(fleetTimer);
  if (
    fleetState.rows.some(
      (row) => isInFlight(row) && row.startedAt && row.elapsedMs === undefined,
    )
  ) {
    // Tick the elapsed cells in place. Rebuilding the table every second would
    // drop keyboard focus and restart any selection the user is holding; the
    // berth plates are ticked the same way, and for the same reason plus one —
    // a rebuilt SVG loses the hover route the reader is holding open.
    fleetTimer = setInterval(() => {
      tickElapsed(document.querySelector(".deck-fleet"));
      tickGraphElapsed(document.querySelector(".c-dependency-graph"));
      syncElapsed();
    }, 1_000);
  }
}

function scheduleRefresh() {
  clearTimeout(pollTimer);
  if (document.hidden) return;

  pollTimer = setTimeout(async () => {
    await loadTree();
    scheduleRefresh();
  }, POLL_INTERVAL_MS);
}

function refreshWhenVisible() {
  clearTimeout(pollTimer);
  if (document.hidden) return;

  // A failed refresh only updates loadError, so the last good tree stays visible.
  loadTree().finally(scheduleRefresh);
}

document.addEventListener("visibilitychange", refreshWhenVisible);

document.querySelector(".deck-top")?.insertAdjacentHTML(
  "beforeend",
  `<div v-if="view === 'lanes'" v-scope="Lanes({ tree, usage })"></div>
   <div v-if="view === 'graph'" class="c-dependency-graph" v-html="graphSvg"></div>`,
);
createApp(store).mount("#app");
// petite-vue owns the SVG's innerHTML, so the listeners go on its parent, which
// is created once by the insertAdjacentHTML above and never replaced.
const graphMount = document.querySelector(".deck-top");
if (graphMount) bindGraphHover(graphMount);
// The roads spread to the pane, so the pane changing size is a relayout.
window.addEventListener("resize", () => updateGraph(graphNodes));
window.__flightdeck = store;

connectEvents({
  onFleet(payload) {
    fleetState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    fleetState.entryCount = payload.entryCount ?? 0;
    fleetState.logPresent = payload.logPresent === true;
    syncUsage(payload.usage);
    syncElapsed();
    drawFleet();
    syncFleetTicker();
  },
  onState(connection) {
    // EventSource repeats `error` while it reconnects. Rebuilding the table for
    // a state it already shows would throw away focus for no visible change.
    if (fleetState.connection === connection) return;
    fleetState.connection = connection;
    drawFleet();
  },
});
drawFleet();

refreshWhenVisible();

export { POLL_INTERVAL_MS, loadTree, store };
