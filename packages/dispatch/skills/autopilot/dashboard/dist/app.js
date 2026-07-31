import { createApp, reactive } from "./vendor/petite-vue.es.js";

const store = reactive({
  planTitle: "",
  slug: "",
  counts: { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0 },
  errors: [],
  view: "lanes",
  loading: true,
  loadError: null,
});

async function loadTree() {
  try {
    const response = await fetch("/api/tree");

    if (!response.ok) {
      throw new Error(`Failed to fetch /api/tree (${response.status})`);
    }

    const tree = await response.json();
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

createApp(store).mount("#app");
window.__flightdeck = store;

loadTree();

export { store };
