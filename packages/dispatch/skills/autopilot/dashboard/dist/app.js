import { createApp, reactive } from "./vendor/petite-vue.es.js";
import { Lanes } from "./modules/lanes.js";
import {
  connectEvents,
  isInFlight,
  renderFleet,
  tickElapsed,
  toggleRubric,
} from "./modules/fleet.js";
import { layoutGraph, renderGraph } from "./modules/graph.js";

const POLL_INTERVAL_MS = 3_000;

const emptyTree = () => ({
  planTitle: "",
  slug: "",
  buckets: [],
  tasks: [],
  counts: { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0 },
  errors: [],
});

const store = reactive({
  view: "lanes",
  loading: true,
  loadError: null,
  tree: emptyTree(),
  Lanes,
  graphSvg: "",
});

let graphLayout;
let graphStructure = "";

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
  // Keep coordinates frozen while polling changes only live task state.
  if (!graphLayout || structure !== graphStructure) {
    graphLayout = layoutGraph(graphTasks);
    graphStructure = structure;
  }
  store.graphSvg = renderGraph(graphTasks, graphLayout);
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
      counts: { ...emptyTree().counts, ...(payload.counts ?? {}) },
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

function drawFleet() {
  const mount = document.querySelector(".deck-fleet");
  if (!mount) return;

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
}

function syncFleetTicker() {
  clearInterval(fleetTimer);
  if (
    fleetState.rows.some(
      (row) => isInFlight(row) && row.startedAt && row.elapsedMs === undefined,
    )
  ) {
    // Tick the elapsed cells in place. Rebuilding the table every second would
    // drop keyboard focus and restart any selection the user is holding.
    fleetTimer = setInterval(
      () => tickElapsed(document.querySelector(".deck-fleet")),
      1_000,
    );
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
  `<div v-if="view === 'lanes'" v-scope="Lanes({ tree })"></div>
   <div v-if="view === 'graph'" class="c-dependency-graph" v-html="graphSvg"></div>`,
);
createApp(store).mount("#app");
window.__flightdeck = store;

connectEvents({
  onFleet(payload) {
    fleetState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    fleetState.entryCount = payload.entryCount ?? 0;
    fleetState.logPresent = payload.logPresent === true;
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
