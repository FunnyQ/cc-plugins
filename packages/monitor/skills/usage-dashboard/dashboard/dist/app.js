import { createApp } from "/vendor/petite-vue.es.js";
import { App } from "./modules/dashboard-app.js";
import { installBloomTracker } from "./modules/bloom-tracker.js";
import { installHeroMotionSettler } from "./modules/hero-motion-settler.js";

async function loadDashboardMarkup() {
  const root = document.getElementById("dashboard-root");
  if (!root) throw new Error("Missing #dashboard-root");
  root.innerHTML = await loadPartial("/partials/dashboard.html");
  await expandPartials(root);
}

async function loadPartial(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load partial ${path}: HTTP ${response.status}`);
  }
  return response.text();
}

// Awaiting inside the loop made the ~16 partials serial. replaceWith still runs
// in document order, so the assembled markup is unchanged.
async function expandPartials(container) {
  const placeholders = [...container.querySelectorAll("[data-partial]")];
  const expanded = await Promise.all(
    placeholders.map(async (placeholder) => {
      const template = document.createElement("template");
      template.innerHTML = await loadPartial(placeholder.dataset.partial);
      await expandPartials(template.content);
      return template.content;
    }),
  );
  placeholders.forEach((placeholder, i) =>
    placeholder.replaceWith(expanded[i]),
  );
}

window.App = App;
await loadDashboardMarkup();
createApp({ App }).mount("#app");
installBloomTracker();
installHeroMotionSettler();
