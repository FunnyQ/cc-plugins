import { createApp, reactive } from "./vendor/petite-vue.es.js";
import { Lanes } from "./modules/lanes.js";

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
  planTitle: "",
  slug: "",
  counts: { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0 },
  errors: [],
  view: "lanes",
  loading: true,
  loadError: null,
  tree: emptyTree(),
  Lanes,
});

async function loadTree() {
  try {
    const response = await fetch("/api/tree");

    if (!response.ok) {
      throw new Error(`Failed to fetch /api/tree (${response.status})`);
    }

    const tree = await response.json();
    Object.assign(store.tree, tree);
    store.planTitle = tree.planTitle ?? "";
    store.slug = tree.slug ?? "";
    store.counts = { ...store.counts, ...(tree.counts ?? {}) };
    store.errors = Array.isArray(tree.errors) ? tree.errors : [];
    store.loadError = null;
  } catch (error) {
    store.loadError = error instanceof Error ? error.message : "API server not responding";
  } finally {
    store.loading = false;
  }
}

let pollTimer;

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
  '<div v-if="view === \'lanes\'" v-scope="Lanes({ tree })"></div>',
);
createApp(store).mount("#app");
window.__flightdeck = store;

refreshWhenVisible();

export { POLL_INTERVAL_MS, loadTree, store };
